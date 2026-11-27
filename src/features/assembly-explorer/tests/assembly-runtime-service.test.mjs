import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import { it } from 'node:test';

import {
  FirebaseEmulatorRepository,
  buildFirebaseStorageMediaUrl,
  defaultFirebaseEmulatorRepository,
} from '@/shared/firebase';

import { assembly, glbBytes } from '../../../shared/firebase/tests/catalogFixture.mjs';

const learningService = new URL(
  '../../learning/services/componentContextStore.ts',
  import.meta.url,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === '@/features/learning' &&
      context.parentURL?.endsWith('/assemblyRuntimeService.ts')
    ) {
      return { url: learningService.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'test-project';
process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET = 'test-bucket';
delete process.env.EXPO_PUBLIC_FIREBASE_USE_EMULATORS;

const {
  clearCachedCatalogBundles,
  loadVerifiedAssemblyByArchetypeId,
  loadVerifiedAssemblyForPrompt,
  peekCachedCatalogBundle,
  preloadCatalogAssemblyBundle,
} = await import('../services/assemblyRuntimeService.ts');

const localUrl = assembly.manifest.files.glb.publicUrl;
const cloudUrl = buildFirebaseStorageMediaUrl(
  'test-bucket',
  assembly.manifest.files.glb.storagePath,
);

function loadBundle(test, readCloud, overrides = {}) {
  const requests = [];
  const progress = [];
  const controller = new AbortController();
  const repository = new FirebaseEmulatorRepository();
  test.mock.method(repository, 'saveProjectAssembly', async () => {});
  test.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(options.signal, controller.signal);
    if (url === '/api/orchestrate') {
      assert.deepEqual(JSON.parse(options.body), {
        prompt: 'Build a quadcopter',
        provider: 'gemini',
        providerExplicitlySelected: false,
        ...overrides,
      });
      return Response.json(assembly);
    }
    if (url === cloudUrl) return readCloud(controller);
    if (url === localUrl) return new Response(glbBytes);
    throw new Error(`Unexpected request for ${url}`);
  });
  const result = loadVerifiedAssemblyForPrompt({
    prompt: 'Build a quadcopter',
    provider: 'gemini',
    repository,
    signal: controller.signal,
    onProgress: (status) => progress.push(status),
    ...overrides,
  });
  return { requests, progress, result };
}

it('downloads the Firebase GLB first and reports completion after the streamed bytes', async (test) => {
  const { requests, progress, result } = loadBundle(test, () => new Response(glbBytes));
  assert.deepEqual(Buffer.from((await result).glbArrayBuffer), glbBytes);
  assert.deepEqual(requests, ['/api/orchestrate', cloudUrl]);
  assert.deepEqual(progress.at(-2), { phase: 'downloading', progress: 0.95 });
  assert.deepEqual(progress.at(-1), { phase: 'ready', progress: 1 });
});

it('loads the local GLB when the Firebase object returns HTTP 404', async (test) => {
  const { requests, result } = loadBundle(test, () => new Response(null, { status: 404 }));
  assert.deepEqual(Buffer.from((await result).glbArrayBuffer), glbBytes);
  assert.deepEqual(requests, ['/api/orchestrate', cloudUrl, localUrl]);
});

it('loads the local GLB when the Firebase request fails at the network', async (test) => {
  const { requests, result } = loadBundle(test, () => {
    throw new TypeError('Failed to fetch');
  });
  assert.deepEqual(Buffer.from((await result).glbArrayBuffer), glbBytes);
  assert.deepEqual(requests, ['/api/orchestrate', cloudUrl, localUrl]);
});

it('reports other HTTP failures without falling back', async (test) => {
  const { requests, result } = loadBundle(test, () => new Response(null, { status: 403 }));
  await assert.rejects(result, /Failed to load GLB geometry.*HTTP 403/);
  assert.deepEqual(requests, ['/api/orchestrate', cloudUrl]);
});

it('does not retry the GLB download after the request aborts', async (test) => {
  const { requests, result } = loadBundle(test, (controller) => {
    controller.abort();
    throw controller.signal.reason;
  });
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(requests, ['/api/orchestrate', cloudUrl]);
});

const catalogEndpoint = `/api/assemblies/${assembly.archetypeId}`;

it('preloads an assembly directly and hands off the same GLB to the explorer', async (test) => {
  clearCachedCatalogBundles();
  test.after(clearCachedCatalogBundles);
  const requests = [];
  const progress = [];
  const save = test.mock.method(
    defaultFirebaseEmulatorRepository,
    'saveProjectAssembly',
    async () => {},
  );
  test.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options.method]);
    if (url === catalogEndpoint) return Response.json(assembly);
    if (url === cloudUrl) return new Response(glbBytes);
    throw new Error(`Unexpected request for ${url}`);
  });

  assert.equal(peekCachedCatalogBundle(assembly.archetypeId), undefined);
  const preview = preloadCatalogAssemblyBundle(assembly.archetypeId);
  const explorer = loadVerifiedAssemblyByArchetypeId({
    archetypeId: assembly.archetypeId,
    onProgress: (status) => progress.push(status),
  });
  const bundle = await preview;
  assert.equal(await explorer, bundle);
  assert.equal(peekCachedCatalogBundle(assembly.archetypeId), bundle);
  assert.equal(await preloadCatalogAssemblyBundle(assembly.archetypeId), bundle);
  assert.equal(save.mock.callCount(), 1);
  assert.deepEqual(Buffer.from(bundle.glbArrayBuffer), glbBytes);
  assert.deepEqual(requests, [
    [catalogEndpoint, 'GET'],
    [cloudUrl, undefined],
  ]);
  assert.deepEqual(progress.at(-1), { phase: 'ready', progress: 1 });
});

it('surfaces catalog errors and retries a failed request without caching it', async (test) => {
  clearCachedCatalogBundles();
  test.after(clearCachedCatalogBundles);
  let assemblyRequests = 0;
  const repository = new FirebaseEmulatorRepository();
  test.mock.method(repository, 'saveProjectAssembly', async () => {});
  test.mock.method(globalThis, 'fetch', async (url) => {
    if (url === cloudUrl) return new Response(glbBytes);
    assert.equal(url, catalogEndpoint);
    assemblyRequests += 1;
    return assemblyRequests === 1
      ? Response.json({ error: 'Catalog export unavailable' }, { status: 400 })
      : Response.json(assembly);
  });
  const load = () =>
    loadVerifiedAssemblyByArchetypeId({ archetypeId: assembly.archetypeId, repository });
  await assert.rejects(load(), /Catalog export unavailable/);
  assert.equal((await load()).assembly.archetypeId, assembly.archetypeId);
  assert.equal(assemblyRequests, 2);
});

it('aborts an explorer wait and lets the shared preview download complete', async (test) => {
  clearCachedCatalogBundles();
  test.after(clearCachedCatalogBundles);
  const { promise: response, resolve } = Promise.withResolvers();
  test.mock.method(defaultFirebaseEmulatorRepository, 'saveProjectAssembly', async () => {});
  test.mock.method(globalThis, 'fetch', async (url) => {
    if (url === catalogEndpoint) return response;
    if (url === cloudUrl) return new Response(glbBytes);
    throw new Error(`Unexpected request for ${url}`);
  });
  const controller = new AbortController();
  const preview = preloadCatalogAssemblyBundle(assembly.archetypeId);
  const explorer = loadVerifiedAssemblyByArchetypeId({
    archetypeId: assembly.archetypeId,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(explorer, { name: 'AbortError' });
  resolve(Response.json(assembly));
  assert.equal(await preview, peekCachedCatalogBundle(assembly.archetypeId));
});

it('forwards the chosen archetype and numeric parameters to orchestration', async (test) => {
  const { result } = loadBundle(test, () => new Response(glbBytes), {
    prompt: 'change wheelbase to 320mm',
    archetypeId: 'parametric_multirotor_v1',
    parameterValues: { rotor_count: 6, wheelbase_mm: 320, deck_gap_mm: 26, arm_thickness_mm: 4 },
  });
  await result;
});
