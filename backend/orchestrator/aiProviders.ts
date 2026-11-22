import fs from 'node:fs';
import path from 'node:path';

import { openAICompatible } from '@genkit-ai/compat-oai';
import { deepSeek } from '@genkit-ai/compat-oai/deepseek';
import { openAI } from '@genkit-ai/compat-oai/openai';
import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';

import {
  type AiApiFormat,
  type AiModelDescriptor,
  type AiProviderId,
  CATALOG_ARCHETYPES,
  getAiProviderDescriptor,
  getCatalogArchetypeById,
  matchProjectArchetypeFromPrompt,
} from '@/shared/domain';

export const ProjectPlanOutputSchema = z.object({
  archetypeId: z.string(),
  projectTitle: z.string(),
  plannedSubsystems: z.array(z.string()),
  rationale: z.string(),
});

export type ProjectPlanOutput = z.infer<typeof ProjectPlanOutputSchema>;

export type ProviderPlanRequest = {
  readonly prompt: string;
  readonly provider: AiProviderId;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelName?: string;
  readonly requireLiveApiKey?: boolean;
};

export type ProviderPlanResolution = ProjectPlanOutput & {
  readonly provider: AiProviderId;
  readonly modelId: string;
  readonly apiFormat: AiApiFormat;
  readonly baseUrl: string;
  readonly executionMode: 'live_api' | 'local_catalog_planner';
};

export function createMultiProviderGenkitInstance(config?: {
  readonly geminiApiKey?: string;
  readonly openaiApiKey?: string;
  readonly deepseekApiKey?: string;
  readonly openaiBaseUrl?: string;
  readonly deepseekBaseUrl?: string;
}) {
  const plugins = [
    googleAI({
      apiKey: config?.geminiApiKey ?? process.env.GEMINI_API_KEY ?? 'local-dev-placeholder',
    }),
    openAI({
      apiKey: config?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? 'local-dev-placeholder',
    }),
    deepSeek({
      apiKey: config?.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? 'local-dev-placeholder',
    }),
  ];

  if (config?.openaiBaseUrl !== undefined) {
    plugins.push(
      openAICompatible({
        name: 'openai-custom',
        baseURL: config.openaiBaseUrl,
        apiKey: config.openaiApiKey ?? 'local-dev-placeholder',
      }),
    );
  }
  if (config?.deepseekBaseUrl !== undefined) {
    plugins.push(
      openAICompatible({
        name: 'deepseek-custom',
        baseURL: config.deepseekBaseUrl,
        apiKey: config.deepseekApiKey ?? 'local-dev-placeholder',
      }),
    );
  }

  return genkit({ plugins });
}

type ProviderEnvKeyName = AiModelDescriptor['envKeyName'];

const DOT_ENV_FILE_NAMES = ['.env.local', '.env'] as const;

const CONFIGURED_PROVIDER_PRIORITY: readonly AiProviderId[] = ['deepseek', 'gemini', 'openai'];

function toNonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function stripSurroundingQuotes(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

function findDotEnvValue(contents: string, envKeyName: ProviderEnvKeyName): string | undefined {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separatorIndex = line.indexOf('=');
    if (line.startsWith('#') || separatorIndex <= 0) {
      continue;
    }
    const key = line
      .slice(0, separatorIndex)
      .replace(/^export\s+/, '')
      .trim();
    if (key === envKeyName) {
      return toNonEmptyTrimmed(stripSurroundingQuotes(line.slice(separatorIndex + 1).trim()));
    }
  }
  return undefined;
}

function readDotEnvLocalKey(envKeyName: ProviderEnvKeyName): string | undefined {
  for (const fileName of DOT_ENV_FILE_NAMES) {
    const filePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const value = findDotEnvValue(fs.readFileSync(filePath, 'utf8'), envKeyName);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function resolveEnvApiKey(envKeyName: ProviderEnvKeyName): string | undefined {
  return toNonEmptyTrimmed(process.env[envKeyName]) ?? readDotEnvLocalKey(envKeyName);
}

export function listConfiguredAiProviders(): readonly AiProviderId[] {
  return CONFIGURED_PROVIDER_PRIORITY.filter(
    (provider) => resolveEnvApiKey(getAiProviderDescriptor(provider).envKeyName) !== undefined,
  );
}

export function resolveDefaultConfiguredProvider(preferred: AiProviderId): AiProviderId {
  const configured = listConfiguredAiProviders();
  return configured.includes(preferred) ? preferred : (configured[0] ?? preferred);
}

function describeMissingProviderKey(descriptor: AiModelDescriptor): string {
  const configured = listConfiguredAiProviders();
  const configuredHint =
    configured.length > 0
      ? `Configured providers: ${configured.join(', ')}.`
      : 'No AI provider keys are configured.';
  return `Missing ${descriptor.envKeyName} in .env.local for ${descriptor.displayName}. ${configuredHint}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFirstChoiceContent(payload: unknown): string {
  if (!isObjectRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error('OpenAI-compatible response missing choices array');
  }
  const firstChoice: unknown = payload.choices[0];
  if (!isObjectRecord(firstChoice) || !isObjectRecord(firstChoice.message)) {
    throw new Error('OpenAI-compatible response missing first choice message');
  }
  const content = firstChoice.message.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('OpenAI-compatible response missing text content');
  }
  return content;
}

function extractGeminiTextContent(payload: unknown): string {
  if (!isObjectRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error('Gemini response missing candidates array');
  }
  const firstCandidate: unknown = payload.candidates[0];
  if (!isObjectRecord(firstCandidate) || !isObjectRecord(firstCandidate.content)) {
    throw new Error('Gemini response missing candidate content');
  }
  const parts = firstCandidate.content.parts;
  if (!Array.isArray(parts)) {
    throw new Error('Gemini response missing content parts');
  }
  const firstPart: unknown = parts[0];
  if (!isObjectRecord(firstPart) || typeof firstPart.text !== 'string') {
    throw new Error('Gemini response missing part text');
  }
  return firstPart.text;
}

function parseJsonPlan(rawText: string, fallbackPrompt: string): ProjectPlanOutput {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const parsedJson: unknown = JSON.parse(cleaned);
  const parsed = ProjectPlanOutputSchema.parse(parsedJson);
  const catalogMatch =
    getCatalogArchetypeById(parsed.archetypeId) ??
    matchProjectArchetypeFromPrompt(`${fallbackPrompt} ${parsed.archetypeId}`);
  const subsystems =
    parsed.plannedSubsystems.length > 0
      ? parsed.plannedSubsystems
      : catalogMatch.nodes.filter((n) => n.level === 'subsystem').map((n) => n.name);
  return {
    archetypeId: catalogMatch.archetypeId,
    projectTitle: parsed.projectTitle || catalogMatch.title,
    plannedSubsystems: subsystems,
    rationale: parsed.rationale,
  };
}

function buildPlannerSystemInstruction(): string {
  const supportedIds = CATALOG_ARCHETYPES.map(
    (entry) => `"${entry.archetypeId}" (${entry.title})`,
  ).join(', ');
  return `You are the Zappd Phase 1 CAD project planning agent. Return strict JSON with keys: archetypeId (one of ${supportedIds}), projectTitle (string), plannedSubsystems (string[]), rationale (string).`;
}

async function invokeOpenAiCompatiblePlanner(args: {
  readonly prompt: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}): Promise<ProjectPlanOutput> {
  const endpoint = `${args.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const systemInstruction = buildPlannerSystemInstruction();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: args.prompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI-compatible endpoint failed with HTTP ${response.status}`);
  }
  const jsonPayload: unknown = await response.json();
  const content = extractFirstChoiceContent(jsonPayload);
  return parseJsonPlan(content, args.prompt);
}

async function invokeGeminiPlanner(args: {
  readonly prompt: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}): Promise<ProjectPlanOutput> {
  const endpoint = `${args.baseUrl.replace(/\/+$/, '')}/v1beta/models/${args.model}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const systemInstruction = buildPlannerSystemInstruction();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemInstruction}\n\nUser request: ${args.prompt}` }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini endpoint failed with HTTP ${response.status}`);
  }
  const jsonPayload: unknown = await response.json();
  const content = extractGeminiTextContent(jsonPayload);
  return parseJsonPlan(content, args.prompt);
}

export async function planProjectWithProvider(
  request: ProviderPlanRequest,
): Promise<ProviderPlanResolution> {
  const descriptor = getAiProviderDescriptor(request.provider);
  const resolvedBaseUrl = request.baseUrl ?? descriptor.defaultBaseUrl;
  const resolvedModel = request.modelName ?? descriptor.rawModelName;
  const resolvedApiKey = request.apiKey ?? resolveEnvApiKey(descriptor.envKeyName);

  if (resolvedApiKey === undefined && request.requireLiveApiKey === true) {
    throw new Error(describeMissingProviderKey(descriptor));
  }

  if (resolvedApiKey !== undefined) {
    if (descriptor.apiFormat === 'openai_compatible') {
      const livePlan = await invokeOpenAiCompatiblePlanner({
        prompt: request.prompt,
        model: resolvedModel,
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
      });
      return {
        ...livePlan,
        provider: descriptor.provider,
        modelId: descriptor.modelId,
        apiFormat: descriptor.apiFormat,
        baseUrl: resolvedBaseUrl,
        executionMode: 'live_api',
      };
    }

    const livePlan = await invokeGeminiPlanner({
      prompt: request.prompt,
      model: resolvedModel,
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
    });
    return {
      ...livePlan,
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      apiFormat: descriptor.apiFormat,
      baseUrl: resolvedBaseUrl,
      executionMode: 'live_api',
    };
  }

  const matched = matchProjectArchetypeFromPrompt(request.prompt);
  const plannedSubsystems = matched.nodes
    .filter((node) => node.level === 'subsystem')
    .map((node) => node.name);

  return {
    archetypeId: matched.archetypeId,
    projectTitle: matched.title,
    plannedSubsystems,
    rationale: `Matched verified Phase 1 catalog archetype "${matched.archetypeId}" via ${descriptor.displayName} planning contract.`,
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    apiFormat: descriptor.apiFormat,
    baseUrl: resolvedBaseUrl,
    executionMode: 'local_catalog_planner',
  };
}
