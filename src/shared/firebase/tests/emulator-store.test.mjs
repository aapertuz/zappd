import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { beforeEach, it } from 'node:test';

import { doc, writeBatch } from 'firebase/firestore';

import { buildGroundedComponentExplanation } from '@/features/learning/catalog';

import { getFirebaseEmulatorClients } from '../firebaseClient.ts';
import { assembly } from './catalogFixture.mjs';

const writes = [];
const state = new Map();
const attempts = [];
const metadata = { fromCache: false, hasPendingWrites: false };
const makeReference = (parent, ...path) => ({
  path: [parent.path, ...path].filter(Boolean).join('/'),
});
const firestoreSdk = {
  doc: makeReference,
  collection: makeReference,
  getDocs: async (reference) => ({
    docs: [...state.entries()]
      .filter(([path]) => path.startsWith(`${reference.path}/`))
      .map(([, data]) => ({ data: () => data })),
    metadata,
  }),
  getDoc: async (reference) => ({
    ref: reference,
    get: (field) => state.get(reference.path)?.[field],
    exists: () => state.has(reference.path),
    data: () => state.get(reference.path),
    metadata,
  }),
  writeBatch: () => {
    const documents = [];
    attempts.push(documents);
    return {
      set: (reference, data) => documents.push({ path: reference.path, data }),
      commit: async () => {
        assert.ok(documents.length <= 500, 'Firestore rejects batches above 500 operations');
        const { firestore } = getFirebaseEmulatorClients();
        const validationBatch = writeBatch(firestore);
        for (const { path, data } of documents) validationBatch.set(doc(firestore, path), data);
        for (const { path, data } of documents) state.set(path, data);
        writes.push(documents);
      },
    };
  },
};

globalThis.zappdTestFirestore = firestoreSdk;
const mockedSdk =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const { doc, collection, getDocs, getDoc, writeBatch } = globalThis.zappdTestFirestore;',
  );
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'firebase/firestore' && context.parentURL?.endsWith('/emulatorStore.ts')) {
      return { url: mockedSdk, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
process.env.EXPO_PUBLIC_FIREBASE_USE_EMULATORS = '1';
const { FirebaseEmulatorRepository } = await import('../emulatorStore.ts');

const expanded = {
  ...assembly,
  nodes: Array.from({ length: 325 }, (_, index) => ({
    ...assembly.nodes[index % assembly.nodes.length],
    id: `comp_test_${index}`,
  })),
};
const explanations = expanded.nodes.map((node) =>
  buildGroundedComponentExplanation(expanded, node, expanded.relationships, expanded.assemblySteps),
);
const projectPath = `projects/${expanded.projectId}`;

beforeEach((test) => {
  state.clear();
  writes.length = 0;
  attempts.length = 0;
  test.mock.method(globalThis, 'fetch', async () => new Response('emulator'));
});

it('commits more than 500 project documents in bounded batches and writes the completion marker last', async () => {
  const repository = new FirebaseEmulatorRepository();

  await repository.saveProjectAssembly(expanded, undefined, {
    componentExplanations: explanations,
    syncLearningDocuments: true,
  });

  const allWrites = writes.flat();
  assert.equal(
    allWrites.length,
    651 + expanded.relationships.length + expanded.assemblySteps.length,
  );
  assert.deepEqual(
    writes.map(({ length }) => length),
    [400, allWrites.length - 400],
  );
  assert.equal(allWrites.at(-1).path, projectPath);
  assert.equal(allWrites.at(-1).data.learningDocumentVersion, 1);
  assert.equal(allWrites.at(-1).data.payload.projectId, expanded.projectId);
});

it('makes zero write attempts when the project already has a completion marker', async () => {
  state.set(projectPath, { learningDocumentVersion: 1 });
  const repository = new FirebaseEmulatorRepository();

  await repository.saveProjectAssembly(expanded, undefined, {
    componentExplanations: explanations,
    syncLearningDocuments: true,
  });

  assert.deepEqual(attempts, []);
  assert.equal(repository.readProjectNodes(expanded.projectId).length, 325);
});

it('round-trips routed relationships through Firestore without storing nested arrays', async () => {
  const repository = new FirebaseEmulatorRepository();
  const relationship = expanded.relationships.find(
    ({ routingWaypointsMeters }) => routingWaypointsMeters?.length > 0,
  );

  await repository.saveProjectAssembly(expanded, undefined, {
    componentExplanations: explanations,
    syncLearningDocuments: true,
  });

  const stored = state.get(`${projectPath}/relationships/${relationship.id}`);
  assert.deepEqual(
    stored.routingWaypointsMeters,
    relationship.routingWaypointsMeters.map(([x, y, z]) => ({ x, y, z })),
  );
  const learning = await repository.tryFetchProjectLearningDocsFromFirestore(
    expanded.projectId,
    explanations[0].componentId,
  );
  assert.deepEqual(
    learning.relationships.find(({ id }) => id === relationship.id),
    relationship,
  );
});
