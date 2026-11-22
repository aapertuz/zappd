export type AiProviderId = 'gemini' | 'openai' | 'deepseek';

export type AiApiFormat = 'google_genai' | 'openai_compatible';

export type AiModelDescriptor = {
  readonly provider: AiProviderId;
  readonly displayName: string;
  readonly modelId: string;
  readonly rawModelName: string;
  readonly apiFormat: AiApiFormat;
  readonly defaultBaseUrl: string;
  readonly envKeyName: 'GEMINI_API_KEY' | 'OPENAI_API_KEY' | 'DEEPSEEK_API_KEY';
};

export const AI_PROVIDER_REGISTRY: Readonly<Record<AiProviderId, AiModelDescriptor>> = {
  gemini: {
    provider: 'gemini',
    displayName: 'Google Gemini',
    modelId: 'googleai/gemini-2.5-flash',
    rawModelName: 'gemini-2.5-flash',
    apiFormat: 'google_genai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    envKeyName: 'GEMINI_API_KEY',
  },
  openai: {
    provider: 'openai',
    displayName: 'OpenAI',
    modelId: 'openai/gpt-4o',
    rawModelName: 'gpt-4o',
    apiFormat: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    envKeyName: 'OPENAI_API_KEY',
  },
  deepseek: {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    modelId: 'deepseek/deepseek-chat',
    rawModelName: 'deepseek-chat',
    apiFormat: 'openai_compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    envKeyName: 'DEEPSEEK_API_KEY',
  },
};

export const SUPPORTED_AI_PROVIDERS: readonly AiProviderId[] = ['gemini', 'deepseek', 'openai'];

export const DEFAULT_AI_PROVIDER: AiProviderId = 'deepseek';

export function isAiProviderId(value: unknown): value is AiProviderId {
  return value === 'gemini' || value === 'openai' || value === 'deepseek';
}

export function parseAiProviderId(value: unknown): AiProviderId {
  if (isAiProviderId(value)) {
    return value;
  }
  throw new Error(`Unsupported AI provider: ${String(value)}`);
}

export function getAiProviderDescriptor(provider: AiProviderId): AiModelDescriptor {
  return AI_PROVIDER_REGISTRY[provider];
}

export function isOpenAiCompatibleProvider(provider: AiProviderId): boolean {
  return AI_PROVIDER_REGISTRY[provider].apiFormat === 'openai_compatible';
}
