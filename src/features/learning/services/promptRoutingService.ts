import {
  type AiProviderId,
  type CanvasPromptRouteDecision,
  type PromptRouteCloudRequest,
  parsePromptRouteCloudResponse,
} from '@/shared/domain';

import {
  type CanvasPromptContext,
  classifyCanvasPromptWithConfidence,
  findPromptQuestionTarget,
} from '../model/promptRouter';

type PromptRouteSource = 'deterministic' | 'cloud' | 'deterministic_fallback';

type CloudPromptRouter = (
  request: PromptRouteCloudRequest,
  signal: AbortSignal,
) => Promise<unknown>;

const ROUTING_TIMEOUT_MS = 3000;

async function requestPromptRoute(
  request: PromptRouteCloudRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch('/api/route-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(`Prompt routing returned HTTP ${response.status}.`);
  return response.json();
}

function isRuntimeOnline(): boolean {
  return globalThis.navigator?.onLine !== false;
}

export async function resolveCanvasPromptRoute({
  prompt,
  activeContext,
  provider,
  providerExplicitlySelected,
  timeoutMs = ROUTING_TIMEOUT_MS,
  signal,
  isOnline = isRuntimeOnline,
  routeCloud = requestPromptRoute,
}: {
  readonly prompt: string;
  readonly activeContext: CanvasPromptContext | null;
  readonly provider: AiProviderId;
  readonly providerExplicitlySelected: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly isOnline?: () => boolean;
  readonly routeCloud?: CloudPromptRouter;
}): Promise<{ readonly decision: CanvasPromptRouteDecision; readonly source: PromptRouteSource }> {
  signal?.throwIfAborted();
  const deterministic = classifyCanvasPromptWithConfidence(prompt, activeContext);
  if (activeContext === null || deterministic.confidence === 'high' || !isOnline()) {
    return { decision: deterministic.decision, source: 'deterministic' };
  }

  const { assembly, focusedComponentId } = activeContext;
  const request: PromptRouteCloudRequest = {
    prompt,
    activeContext: {
      archetypeId: assembly.archetypeId,
      title: assembly.title,
      rootNodeId: assembly.rootNodeId,
      parameters: assembly.parameters,
      focusedComponentId: focusedComponentId ?? null,
      focusedComponentName:
        activeContext.focusedComponentName ??
        assembly.nodes.find(({ id }) => id === focusedComponentId)?.name ??
        null,
    },
    provider,
    providerExplicitlySelected,
  };
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  signal?.addEventListener('abort', abortRequest, { once: true });
  const timer = setTimeout(abortRequest, timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    });
  });
  try {
    const raw = await Promise.race([aborted, routeCloud(request, controller.signal)]);
    signal?.throwIfAborted();
    const { decision } = parsePromptRouteCloudResponse(raw);
    if (decision.kind === 'ask_question') {
      const { targetComponentId } = decision;
      return {
        source: 'cloud',
        decision: {
          kind: 'ask_question',
          targetComponentId:
            focusedComponentId ??
            (targetComponentId !== assembly.rootNodeId &&
            assembly.nodes.some(({ id }) => id === targetComponentId)
              ? targetComponentId
              : findPromptQuestionTarget(prompt, activeContext)),
        },
      };
    }
    if (decision.kind === 'load_assembly' && decision.targetArchetypeId === undefined) {
      return { source: 'deterministic_fallback', decision: deterministic.decision };
    }
    return { decision, source: 'cloud' };
  } catch {
    signal?.throwIfAborted();
    return { decision: deterministic.decision, source: 'deterministic_fallback' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortRequest);
  }
}
