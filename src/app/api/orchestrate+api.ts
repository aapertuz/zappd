import { type AiProviderId, DEFAULT_AI_PROVIDER, parseAiProviderId } from '@/shared/domain';

import {
  listConfiguredAiProviders,
  resolveDefaultConfiguredProvider,
} from '@/backend/orchestrator/aiProviders';
import { orchestrateProjectAssemblyCreation } from '@/backend/orchestrator/genkitOrchestrator';

type OrchestrateRequestBody = {
  readonly prompt: string;
  readonly provider: AiProviderId;
  readonly providerExplicitlySelected: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOrchestrateRequestBody(raw: unknown): OrchestrateRequestBody {
  if (!isRecord(raw)) {
    throw new Error('Request body must be a JSON object');
  }
  if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    throw new Error('Prompt must be a non-empty string');
  }
  return {
    prompt: raw.prompt.trim(),
    provider: parseAiProviderId(raw.provider),
    providerExplicitlySelected: raw.providerExplicitlySelected === true,
  };
}

export function GET(): Response {
  return Response.json({
    configuredProviders: listConfiguredAiProviders(),
    defaultProvider: resolveDefaultConfiguredProvider(DEFAULT_AI_PROVIDER),
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = parseOrchestrateRequestBody(await request.json());
    const effectiveProvider = body.providerExplicitlySelected
      ? body.provider
      : resolveDefaultConfiguredProvider(body.provider);
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: body.prompt,
      provider: effectiveProvider,
      requireLiveApiKey: true,
    });
    return Response.json(assembly, { status: 200 });
  } catch (error: unknown) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Orchestration failed' },
      { status: 400 },
    );
  }
}
