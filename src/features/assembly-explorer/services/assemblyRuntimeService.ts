import {
  type AiProviderId,
  type VerifiedProjectAssembly,
  isAllowedProjectAssembly,
  parseVerifiedProjectAssembly,
} from '@/shared/domain';
import {
  type FirebaseEmulatorRepository,
  defaultFirebaseEmulatorRepository,
} from '@/shared/firebase';

import { hydrateComponentLearningContext } from '@/features/learning';

import type { AssemblyLoadingProgress } from '../types';

export type LoadedAssemblyBundle = {
  readonly assembly: VerifiedProjectAssembly;
  readonly glbArrayBuffer: ArrayBuffer;
};

const ORCHESTRATE_ENDPOINT = '/api/orchestrate';

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

async function readOrchestrationErrorMessage(response: Response): Promise<string> {
  const fallbackMessage = `Orchestration request failed with HTTP ${response.status}`;
  try {
    const payload: unknown = await response.json();
    return isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

export async function loadVerifiedAssemblyForPrompt(args: {
  readonly prompt: string;
  readonly provider: AiProviderId;
  readonly providerExplicitlySelected?: boolean;
  readonly repository?: FirebaseEmulatorRepository;
  readonly onProgress?: ReportProgress;
}): Promise<LoadedAssemblyBundle> {
  const repository = args.repository ?? defaultFirebaseEmulatorRepository;

  args.onProgress?.({ phase: 'orchestrating', progress: 0.12 });
  const orchestrationResponse = await fetch(ORCHESTRATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: args.prompt,
      provider: args.provider,
      providerExplicitlySelected: args.providerExplicitlySelected ?? false,
    }),
  });
  if (!orchestrationResponse.ok) {
    throw new Error(await readOrchestrationErrorMessage(orchestrationResponse));
  }

  const assembly = parseVerifiedProjectAssembly(await orchestrationResponse.json());
  if (!isAllowedProjectAssembly(assembly)) {
    throw new Error(`Assembly ${assembly.archetypeId} failed OpenCascade validation checks`);
  }

  const glbFile = assembly.manifest.files.glb;
  args.onProgress?.({ phase: 'downloading', progress: 0.55 });
  const glbResponse = await fetch(glbFile.publicUrl);
  if (!glbResponse.ok) {
    throw new Error(
      `Failed to load GLB geometry for ${assembly.archetypeId}: HTTP ${glbResponse.status}`,
    );
  }
  const glbArrayBuffer = await readGlbWithProgress(glbResponse, glbFile.sizeBytes, args.onProgress);

  await hydrateComponentLearningContext({
    assembly,
    repository,
    binaries: { glb: new Uint8Array(glbArrayBuffer) },
  });

  args.onProgress?.({ phase: 'ready', progress: 1 });
  return {
    assembly,
    glbArrayBuffer,
  };
}
