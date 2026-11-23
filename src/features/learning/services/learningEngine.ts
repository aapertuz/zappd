import {
  type AiProviderId,
  type LearningCloudRequest,
  type LearningCloudResponse,
  type LearningContextSource,
  type LearningRequest,
  parseLearningCloudResponse,
} from '@/shared/domain';
import { type LocalInferenceRunner, createFirebaseAiLogicLocalRunner } from '@/shared/firebase';

import { retrieveComponentLearningContext } from './componentContextStore';
import {
  buildLearningPrompt,
  evaluateLocalInferenceSufficiency,
  formatOfflineLearningFallback,
} from '../model/learningPrompt';

export type CloudLearningRunner = (request: LearningCloudRequest) => Promise<LearningCloudResponse>;

export type LearningResult = { readonly contextSource: LearningContextSource } & (
  | {
      readonly text: string;
      readonly inferenceSource: 'on_device';
    }
  | (LearningCloudResponse & { readonly fallbackReason: string })
  | {
      readonly text: string;
      readonly inferenceSource: 'offline_cache';
      readonly fallbackReason: string;
    }
);

async function requestCloudLearning(request: LearningCloudRequest): Promise<LearningCloudResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Cloud learning returned HTTP ${response.status}.`);
    return parseLearningCloudResponse(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function isRuntimeOnline(): boolean {
  return globalThis.navigator?.onLine !== false;
}

export async function runLearningRequest({
  request,
  provider,
  providerExplicitlySelected,
  localRunner = createFirebaseAiLogicLocalRunner(),
  cloudRunner = requestCloudLearning,
  isOnline = isRuntimeOnline,
  onChunk,
  ...contextLookup
}: Parameters<typeof retrieveComponentLearningContext>[0] & {
  readonly request: LearningRequest;
  readonly provider?: AiProviderId;
  readonly providerExplicitlySelected?: boolean;
  readonly localRunner?: LocalInferenceRunner;
  readonly cloudRunner?: CloudLearningRunner;
  readonly isOnline?: () => boolean;
  readonly onChunk?: (
    chunk: string,
    metadata: {
      readonly contextSource: LearningContextSource;
      readonly inferenceSource: 'on_device';
    },
  ) => void;
}): Promise<LearningResult> {
  const context = await retrieveComponentLearningContext(contextLookup);
  const { contextSource } = context;
  const prompt = buildLearningPrompt(context, request);
  let fallbackReason: string;

  try {
    const local = await localRunner({
      prompt,
      onChunk:
        onChunk === undefined
          ? undefined
          : (chunk) => onChunk(chunk, { contextSource, inferenceSource: 'on_device' }),
    });
    if (local.available) {
      const assessment = evaluateLocalInferenceSufficiency(local.text, context, request);
      if (assessment.sufficient) {
        return { text: local.text.trim(), inferenceSource: local.inferenceSource, contextSource };
      }
      fallbackReason = assessment.reason ?? 'The on-device response was insufficient.';
    } else {
      fallbackReason = local.reason;
    }
  } catch {
    fallbackReason = 'The on-device model could not generate a response.';
  }

  if (isOnline()) {
    try {
      const cloud = await cloudRunner({
        ...request,
        context,
        provider,
        providerExplicitlySelected,
      });
      return { ...cloud, contextSource, fallbackReason };
    } catch {
      fallbackReason = `${fallbackReason} Cloud learning is unavailable.`;
    }
  }

  return {
    text: formatOfflineLearningFallback(context, request),
    inferenceSource: 'offline_cache',
    contextSource,
    fallbackReason,
  };
}
