import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { it } from 'node:test';

import {
  assembly,
  glbBytes,
  pipeline,
} from '../../../src/shared/firebase/tests/catalogFixture.mjs';

const documents = new Map();
const objects = new Map();
const batchSizes = [];
let failSecondBatch = true;

const firestore = {
  settings() {},
  doc(path) {
    return {
      path,
      get: async () => ({
        data: () => documents.get(path),
        get: (field) => documents.get(path)?.[field],
      }),
      set: async (value) => documents.set(path, value),
    };
  },
  batch() {
    const pending = new Map();
    return {
      set: ({ path }, value) => pending.set(path, value),
      async commit() {
        batchSizes.push(pending.size);
        if (batchSizes.length === 2 && failSecondBatch) throw new Error('Interrupted commit');
        for (const [path, value] of pending) documents.set(path, value);
      },
    };
  },
};

const bucket = {
  file(path) {
    return {
      async getMetadata() {
        const object = objects.get(path);
        if (object === undefined) throw Object.assign(new Error('Not found'), { code: 404 });
        return [object.metadata];
      },
      async save(bytes, { metadata }) {
        objects.set(path, { bytes, metadata });
      },
    };
  },
};

globalThis.zappdTestAdmin = {
  applicationDefault: () => ({ getAccessToken: async () => ({ access_token: 'test' }) }),
  getApps: () => [],
  initializeApp: (options, name) => ({ options, name }),
  getStorage: () => ({ bucket: () => bucket }),
  getFirestore: () => firestore,
};
const adminExports = new Map([
  ['firebase-admin/app', 'applicationDefault, getApps, initializeApp'],
  ['firebase-admin/storage', 'getStorage'],
  ['firebase-admin/firestore', 'getFirestore'],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const exports = adminExports.get(specifier);
    if (exports !== undefined && context.parentURL?.endsWith('/firebaseCloudStore.ts')) {
      const script = `export const { ${exports} } = globalThis.zappdTestAdmin;`;
      return { url: 'data:text/javascript,' + encodeURIComponent(script), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

process.env.ZAPPD_DISABLE_FIREBASE_CLOUD = '0';
process.env.EXPO_PUBLIC_FIREBASE_USE_EMULATORS = '0';
process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'test-project';
process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET = 'test-bucket';

const { publishAssemblyToFirebaseCloud } = await import('../firebaseCloudStore.ts');

it('retries a partially published assembly and skips all writes once published', async () => {
  const projectPath = `projects/${assembly.projectId}`;
  const catalogPath = `catalogAssemblies/${assembly.archetypeId}`;
  const nodes = Array.from({ length: 325 }, (_, index) => ({
    ...assembly.nodes[index % assembly.nodes.length],
    id: `comp_test_${index}`,
  }));
  const rawPipelineResult = Buffer.from(JSON.stringify({ ...pipeline, nodes }));
  const input = {
    assembly: { ...assembly, nodes },
    rawPipelineResult,
    artifacts: {
      step: glbBytes,
      glb: glbBytes,
      usdz: glbBytes,
      manifest: Buffer.from(JSON.stringify(assembly.manifest)),
    },
    optionalReports: { 'engineering.json': Buffer.from('{}') },
    updateCatalogPointer: true,
  };

  await assert.rejects(publishAssemblyToFirebaseCloud(input), /Interrupted commit/);
  assert.equal(objects.size, 6);
  assert.equal(documents.size, 400);
  assert.equal(documents.has(projectPath), false);
  assert.equal(documents.has(catalogPath), false);

  failSecondBatch = false;
  const result = await publishAssemblyToFirebaseCloud(input);
  assert.equal(result.uploadedFiles, 0);
  assert.equal(result.skippedFiles, 6);
  assert.equal(
    result.firestoreDocsWritten,
    652 + assembly.relationships.length + assembly.assemblySteps.length,
  );
  assert.ok(batchSizes.every((size) => size <= 400));
  assert.equal(documents.get(projectPath).learningDocumentVersion, 1);
  assert.equal([...documents.keys()].at(-1), catalogPath);
  assert.deepEqual(documents.get(catalogPath), result.pointer);
  for (const { bytes, metadata } of objects.values()) {
    assert.equal(metadata.cacheControl, 'public, max-age=31536000, immutable');
    assert.equal(metadata.metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
  }

  const completed = await publishAssemblyToFirebaseCloud(input);
  assert.equal(completed.uploadedFiles, 0);
  assert.equal(completed.firestoreDocsWritten, 0);
  assert.deepEqual(completed.pointer, result.pointer);
});
