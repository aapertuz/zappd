import assert from 'node:assert/strict';
import { it } from 'node:test';

import { deleteApp, initializeApp } from 'firebase/app';

import {
  FIREBASE_EMULATOR_CONFIG,
  buildFirebaseStorageMediaUrl,
  resolveAssemblyAssetUrls,
} from '../firebaseClient.ts';

const file = { storagePath: 'assemblies/hash with space/model.glb', publicUrl: '/local.glb' };

it('encodes the bucket and the entire Storage object path', () => {
  assert.equal(
    buildFirebaseStorageMediaUrl('bucket/name', file.storagePath),
    'https://firebasestorage.googleapis.com/v0/b/bucket%2Fname/o/assemblies%2Fhash%20with%20space%2Fmodel.glb?alt=media',
  );
});

it('uses a cloud Storage URL first and retains the local fallback', async (test) => {
  const app = initializeApp({ projectId: 'cloud', storageBucket: 'my-bucket' });
  test.after(() => deleteApp(app));
  assert.deepEqual(resolveAssemblyAssetUrls(file), [
    'https://firebasestorage.googleapis.com/v0/b/my-bucket/o/assemblies%2Fhash%20with%20space%2Fmodel.glb?alt=media',
    '/local.glb',
  ]);
});

it('uses a local URL in emulator mode', async (test) => {
  const app = initializeApp({
    projectId: FIREBASE_EMULATOR_CONFIG.projectId,
    storageBucket: 'local-bucket',
  });
  test.after(() => deleteApp(app));
  assert.deepEqual(resolveAssemblyAssetUrls(file), ['/local.glb']);
});

it('uses a local URL if the cloud app has no bucket configured', async (test) => {
  const app = initializeApp({ projectId: 'cloud' });
  test.after(() => deleteApp(app));
  assert.deepEqual(resolveAssemblyAssetUrls(file), ['/local.glb']);
});

it('preserves absolute asset URLs', () => {
  for (const publicUrl of ['http://localhost/model.glb', 'https://example.test/model.glb']) {
    assert.deepEqual(resolveAssemblyAssetUrls({ ...file, publicUrl }), [publicUrl]);
  }
});
