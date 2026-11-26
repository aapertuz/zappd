import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { env } from 'node:process';
import path from 'node:path';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import { FirebaseEmulatorRepository } from '@/shared/firebase';

import {
  createPointer,
  encodeFirestoreFields,
  pipeline,
} from '../../../src/shared/firebase/tests/catalogFixture.mjs';
import {
  cloudCatalogPointerSchema,
  decodeFirestoreRestFields,
  fetchCloudCatalogPayload,
  resolveFirebaseCloudConfig,
  tryPublishAssemblyToFirebaseCloud,
} from '../firebaseCloudStore.ts';
import { orchestrateProjectAssemblyCreation } from '../genkitOrchestrator.ts';

const config = { enabled: true, projectId: 'test-project', storageBucket: 'test-bucket' };
const pointer = createPointer();
const firestorePath = `/v1/projects/${config.projectId}/databases/(default)/documents/catalogAssemblies/${pointer.archetypeId}`;
const storagePath = `/v0/b/${config.storageBucket}/o/${encodeURIComponent(pointer.files.pipelineResult.storagePath)}?alt=media`;

async function serveCatalog(
  test,
  {
    firestoreStatus = 200,
    storageStatus = 200,
    catalogPointer = pointer,
    rawResult = JSON.stringify(pipeline),
  } = {},
) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === firestorePath) {
      response.writeHead(firestoreStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ fields: encodeFirestoreFields(catalogPointer) }));
    } else if (request.url === storagePath) {
      response.writeHead(storageStatus, { 'Content-Type': 'application/json' });
      response.end(rawResult);
    } else {
      response.writeHead(404).end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  test.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests };
}

function setEnv(test, key, value) {
  const original = env[key];
  if (value === undefined) delete env[key];
  else env[key] = value;
  test.after(() => {
    if (original === undefined) delete env[key];
    else env[key] = original;
  });
}

describe('Firebase catalog REST reads', () => {
  it('decodes nested Firestore maps, arrays, safe integers, and other primitive values', () => {
    const values = { items: [null, false, 42, 1.5, { label: 'node' }], empty: {}, missing: [] };
    assert.deepEqual(decodeFirestoreRestFields(encodeFirestoreFields(values)), values);
    assert.throws(() => decodeFirestoreRestFields({ size: { integerValue: '9007199254740993' } }));
    assert.throws(() => decodeFirestoreRestFields({ enabled: { booleanValue: 'false' } }));
  });

  it('rejects unknown fields, malformed digests, and cross-manifest paths', () => {
    assert.deepEqual(cloudCatalogPointerSchema.parse(pointer), pointer);
    assert.equal(
      cloudCatalogPointerSchema.safeParse({ ...pointer, credential: true }).success,
      false,
    );
    assert.equal(
      cloudCatalogPointerSchema.safeParse({ ...pointer, manifestHash: 'invalid' }).success,
      false,
    );
    const changedFile = { ...pointer.files.glb, storagePath: `${pointer.storagePrefix}/other.glb` };
    assert.equal(
      cloudCatalogPointerSchema.safeParse({
        ...pointer,
        files: { ...pointer.files, glb: changedFile },
      }).success,
      false,
    );
  });

  it('fetches Firestore and checksum-matched Storage bytes without credentials', async (test) => {
    const { baseUrl, requests } = await serveCatalog(test);
    assert.deepEqual(
      await fetchCloudCatalogPayload(pointer.archetypeId, config, {
        firestoreBaseUrl: baseUrl,
        storageBaseUrl: baseUrl,
      }),
      { pointer, rawPipelineResult: JSON.parse(JSON.stringify(pipeline)) },
    );
    assert.deepEqual(requests, [
      { path: firestorePath, authorization: undefined },
      { path: storagePath, authorization: undefined },
    ]);
  });

  for (const [name, behavior, requestCount] of [
    ['missing pointer', { firestoreStatus: 404 }, 1],
    ['missing artifact', { storageStatus: 404 }, 2],
    ['truncated artifact', { rawResult: '{}' }, 2],
    [
      'same-length artifact with a changed digest',
      { rawResult: JSON.stringify(pipeline).replace('composed_validated', 'composed_corrupted') },
      2,
    ],
  ]) {
    it(`falls back for a ${name}`, async (test) => {
      const { baseUrl, requests } = await serveCatalog(test, behavior);
      assert.equal(
        await fetchCloudCatalogPayload(pointer.archetypeId, config, {
          firestoreBaseUrl: baseUrl,
          storageBaseUrl: baseUrl,
        }),
        null,
      );
      assert.equal(requests.length, requestCount);
    });
  }

  it('skips Firebase entirely when disabled for offline use', async (test) => {
    setEnv(test, 'ZAPPD_DISABLE_FIREBASE_CLOUD', '1');
    assert.deepEqual(resolveFirebaseCloudConfig(), { enabled: false });
    const fetchImpl = test.mock.fn();
    assert.equal(
      await fetchCloudCatalogPayload(pointer.archetypeId, undefined, { fetchImpl }),
      null,
    );
    assert.equal(fetchImpl.mock.callCount(), 0);
    assert.deepEqual(await tryPublishAssemblyToFirebaseCloud({}), {
      published: false,
      reason: 'Firebase cloud publishing is disabled.',
    });
  });

  it('orchestrates a verified cloud catalog on a checkout without CAD files', async (test) => {
    const { baseUrl, requests } = await serveCatalog(test);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'zappd-cloud-catalog-test-'));
    const originalDirectory = process.cwd();
    process.chdir(directory);
    test.after(() => {
      process.chdir(originalDirectory);
      rmSync(directory, { recursive: true, force: true });
    });
    setEnv(test, 'GEMINI_API_KEY', undefined);
    setEnv(test, 'ZAPPD_DISABLE_FIREBASE_CLOUD', undefined);
    setEnv(test, 'EXPO_PUBLIC_FIREBASE_USE_EMULATORS', undefined);
    setEnv(test, 'EXPO_PUBLIC_FIREBASE_PROJECT_ID', config.projectId);
    setEnv(test, 'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET', config.storageBucket);
    const request = globalThis.fetch;
    test.mock.method(globalThis, 'fetch', (input, options) => {
      const url = new URL(input);
      assert.ok(
        ['firestore.googleapis.com', 'firebasestorage.googleapis.com'].includes(url.hostname),
      );
      return request(new URL(url.pathname + url.search, baseUrl), options);
    });
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Build a quadcopter',
      provider: 'gemini',
      repository,
    });
    assert.equal(assembly.manifest.manifestHash, pointer.manifestHash);
    assert.deepEqual(repository.getProjectAssembly(assembly.projectId), assembly);
    assert.equal(repository.readStorageObject(assembly.manifest.files.glb.storagePath), null);
    assert.equal(existsSync(path.join(directory, 'public/assemblies')), false);
    assert.equal(requests.length, 2);
  });
});
