import {
  type AiProviderId,
  type CatalogArchetypeId,
  type VerifiedProjectAssembly,
  canRenderAssembly,
  parseVerifiedProjectAssembly,
} from '@/shared/domain';
import {
  type FirebaseEmulatorRepository,
  defaultFirebaseEmulatorRepository,
  resolveAssemblyAssetUrls,
} from '@/shared/firebase';

import { hydrateComponentLearningContext } from '@/features/learning';

import type { AssemblyLoadingProgress } from '../types';

export type LoadedAssemblyBundle = {
  readonly assembly: VerifiedProjectAssembly;
  readonly glbArrayBuffer: ArrayBuffer;
};

type ReportProgress = (progress: AssemblyLoadingProgress) => void;

async function readGlbWithProgress(
  response: Response,
  sizeBytes: number,
  onProgress: ReportProgress | undefined,
): Promise<ArrayBuffer> {
  const reader = onProgress === undefined ? undefined : response.body?.getReader?.();
  if (reader === undefined || onProgress === undefined) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ phase: 'downloading', progress: 0.95 });
    return buffer;
  }

  const contentLength = Number(response.headers.get('Content-Length'));
  const totalBytes =
    contentLength > 0 && Number.isFinite(contentLength) ? contentLength : sizeBytes;
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      receivedBytes += chunk.value.byteLength;
      if (totalBytes > 0) {
        onProgress({
          phase: 'downloading',
          progress: 0.55 + 0.4 * Math.min(1, receivedBytes / totalBytes),
        });
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress({ phase: 'downloading', progress: 0.95 });
  return bytes.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRequestErrorMessage(response: Response, action: string): Promise<string> {
  const fallbackMessage = `${action} request failed with HTTP ${response.status}`;
  try {
    const payload: unknown = await response.json();
    return isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

type BundleOptions = {
  readonly repository?: FirebaseEmulatorRepository;
  readonly onProgress?: ReportProgress;
  readonly signal?: AbortSignal;
};

async function fetchGlb(
  { archetypeId, manifest }: VerifiedProjectAssembly,
  { onProgress, signal }: BundleOptions,
): Promise<ArrayBuffer> {
  const file = manifest.files.glb;
  const urls = resolveAssemblyAssetUrls(file);
  let failure: string | undefined;
  for (const url of urls) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, { signal });
      if (response.ok) return await readGlbWithProgress(response, file.sizeBytes, onProgress);
    } catch (error) {
      signal?.throwIfAborted();
      failure = error instanceof Error ? error.message : 'Network error';
      continue;
    }
    failure = `HTTP ${response.status}`;
    if (response.status !== 404) break;
  }
  throw new Error(`Failed to load GLB geometry for ${archetypeId}: ${failure ?? 'No asset URL'}`);
}

function postAssemblyRequest(body: object): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function requestAssemblyBundle(
  endpoint: string,
  request: RequestInit,
  action: string,
  { repository = defaultFirebaseEmulatorRepository, onProgress, signal }: BundleOptions,
  expectedArchetypeId?: CatalogArchetypeId,
): Promise<LoadedAssemblyBundle> {
  onProgress?.({ phase: 'orchestrating', progress: 0.12 });
  const response = await fetch(endpoint, { ...request, signal });
  if (!response.ok) {
    throw new Error(await readRequestErrorMessage(response, action));
  }

  const assembly = parseVerifiedProjectAssembly(await response.json());
  if (expectedArchetypeId !== undefined && assembly.archetypeId !== expectedArchetypeId) {
    throw new Error(`Catalog returned ${assembly.archetypeId} for ${expectedArchetypeId}`);
  }
  if (!canRenderAssembly(assembly)) {
    throw new Error(`Assembly ${assembly.archetypeId} failed OpenCascade validation checks`);
  }

  onProgress?.({ phase: 'downloading', progress: 0.55 });
  const glbArrayBuffer = await fetchGlb(assembly, { onProgress, signal });

  await hydrateComponentLearningContext({
    assembly,
    repository,
    binaries: { glb: new Uint8Array(glbArrayBuffer) },
  });

  onProgress?.({ phase: 'ready', progress: 1 });
  return {
    assembly,
    glbArrayBuffer,
  };
}

export function loadVerifiedAssemblyForPrompt({
  prompt,
  provider,
  providerExplicitlySelected = false,
  ...options
}: BundleOptions & {
  readonly prompt: string;
  readonly provider: AiProviderId;
  readonly providerExplicitlySelected?: boolean;
}): Promise<LoadedAssemblyBundle> {
  return requestAssemblyBundle(
    '/api/orchestrate',
    postAssemblyRequest({ prompt, provider, providerExplicitlySelected }),
    'Orchestration',
    options,
  );
}

export function rebuildAssemblyForParameters({
  assembly: { archetypeId, title, userPrompt, orchestration },
  parameterValues,
  ...options
}: BundleOptions & {
  readonly assembly: VerifiedProjectAssembly;
  readonly parameterValues: Readonly<Record<string, number>>;
}): Promise<LoadedAssemblyBundle> {
  return requestAssemblyBundle(
    '/api/rebuild',
    postAssemblyRequest({ archetypeId, title, userPrompt, orchestration, parameterValues }),
    'Parameter rebuild',
    options,
  );
}

type PendingCatalogBundle = {
  readonly promise: Promise<LoadedAssemblyBundle>;
  subscribe(listener: ReportProgress): () => void;
};

type CatalogBundleCache = {
  readonly resolved: Map<CatalogArchetypeId, LoadedAssemblyBundle>;
  readonly pending: Map<CatalogArchetypeId, PendingCatalogBundle>;
};

let catalogCaches = new WeakMap<FirebaseEmulatorRepository, CatalogBundleCache>();

export function clearCachedCatalogBundles(): void {
  catalogCaches = new WeakMap();
}

export function peekCachedCatalogBundle(
  archetypeId: CatalogArchetypeId,
): LoadedAssemblyBundle | undefined {
  return catalogCaches.get(defaultFirebaseEmulatorRepository)?.resolved.get(archetypeId);
}

function startCatalogDownload(
  archetypeId: CatalogArchetypeId,
  repository: FirebaseEmulatorRepository,
  cache: CatalogBundleCache,
): PendingCatalogBundle {
  const listeners = new Set<ReportProgress>();
  let latest: AssemblyLoadingProgress = { phase: 'orchestrating', progress: 0.12 };
  const promise = requestAssemblyBundle(
    `/api/assemblies/${encodeURIComponent(archetypeId)}`,
    { method: 'GET' },
    'Catalog assembly',
    {
      repository,
      onProgress: (progress) => {
        latest = progress;
        for (const report of listeners) report(progress);
      },
    },
    archetypeId,
  )
    .then((bundle) => {
      cache.resolved.set(archetypeId, bundle);
      return bundle;
    })
    .finally(() => {
      cache.pending.delete(archetypeId);
    });
  const pending = {
    promise,
    subscribe(listener: ReportProgress) {
      listener(latest);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  cache.pending.set(archetypeId, pending);
  return pending;
}

export async function loadVerifiedAssemblyByArchetypeId({
  archetypeId,
  repository = defaultFirebaseEmulatorRepository,
  onProgress,
  signal,
}: BundleOptions & {
  readonly archetypeId: CatalogArchetypeId;
}): Promise<LoadedAssemblyBundle> {
  signal?.throwIfAborted();
  let cache = catalogCaches.get(repository);
  if (cache === undefined) {
    cache = { resolved: new Map(), pending: new Map() };
    catalogCaches.set(repository, cache);
  }
  const cached = cache.resolved.get(archetypeId);
  if (cached !== undefined) {
    onProgress?.({ phase: 'ready', progress: 1 });
    return cached;
  }
  const pending =
    cache.pending.get(archetypeId) ?? startCatalogDownload(archetypeId, repository, cache);
  const unsubscribe = onProgress === undefined ? undefined : pending.subscribe(onProgress);
  if (signal === undefined) return pending.promise.finally(unsubscribe);

  return new Promise<LoadedAssemblyBundle>((resolve, reject) => {
    const abort = () => {
      unsubscribe?.();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void pending.promise.then(resolve, reject).finally(() => {
      unsubscribe?.();
      signal.removeEventListener('abort', abort);
    });
    if (signal.aborted) abort();
  });
}

export function preloadCatalogAssemblyBundle(
  archetypeId: CatalogArchetypeId,
): Promise<LoadedAssemblyBundle> {
  return loadVerifiedAssemblyByArchetypeId({ archetypeId });
}
