import {
  type LearningCloudRequest,
  type LearningCloudResponse,
  DEFAULT_AI_PROVIDER,
  buildLearningPromptParts,
  getAiProviderDescriptor,
  parseLearningCloudResponse,
} from '@/shared/domain';

import {
  generateProviderText,
  resolveDefaultConfiguredProvider,
  resolveProviderApiKey,
} from './aiProviders';

export async function generateCloudLearningResponse(
  request: LearningCloudRequest,
): Promise<LearningCloudResponse> {
  const preferred = request.provider ?? DEFAULT_AI_PROVIDER;
  const provider =
    request.providerExplicitlySelected === true
      ? preferred
      : resolveDefaultConfiguredProvider(preferred);
  const descriptor = getAiProviderDescriptor(provider);
  const apiKey = resolveProviderApiKey(provider);

  if (apiKey === undefined) {
    throw new Error(`Missing ${descriptor.envKeyName} for ${descriptor.displayName}.`);
  }

  const { systemInstruction, prompt } = buildLearningPromptParts(request.context, request);
  const text = await generateProviderText({
    provider,
    apiKey,
    systemInstruction,
    prompt,
    temperature: 0.2,
    responseFormat: 'text',
    signal: AbortSignal.timeout(15000),
  });

  return parseLearningCloudResponse({
    text,
    inferenceSource: 'cloud',
    providerName: descriptor.displayName,
  });
}
