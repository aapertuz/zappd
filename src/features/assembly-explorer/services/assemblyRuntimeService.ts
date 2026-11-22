import {
  type AiProviderId,
  type VerifiedProjectAssembly,
  canClassifyAsVerified,
  hasVerifiedUpstreamProvenance,
  parseVerifiedProjectAssembly,
} from '@/shared/domain';
import {
  type FirebaseEmulatorRepository,
  defaultFirebaseEmulatorRepository,
} from '@/shared/firebase';

export type LoadedAssemblyBundle = {
  readonly assembly: VerifiedProjectAssembly;
  readonly glbArrayBuffer: ArrayBuffer;
};

const ORCHESTRATE_ENDPOINT = '/api/orchestrate';

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
}): Promise<LoadedAssemblyBundle> {
  const repository = args.repository ?? defaultFirebaseEmulatorRepository;

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
  if (
    !canClassifyAsVerified(assembly.validation, assembly.verificationStatus) ||
    (assembly.verificationStatus === 'sourced_verified' &&
      !hasVerifiedUpstreamProvenance(assembly.nodes))
  ) {
    throw new Error(`Assembly ${assembly.archetypeId} failed OpenCascade validation checks`);
  }

  const glbResponse = await fetch(assembly.manifest.files.glb.publicUrl);
  if (!glbResponse.ok) {
    throw new Error(
      `Failed to load GLB geometry for ${assembly.archetypeId}: HTTP ${glbResponse.status}`,
    );
  }
  const glbArrayBuffer = await glbResponse.arrayBuffer();

  await repository.saveProjectAssembly(
    assembly,
    {
      glb: new Uint8Array(glbArrayBuffer),
    },
    { syncLiveEmulator: false },
  );

  return {
    assembly,
    glbArrayBuffer,
  };
}
