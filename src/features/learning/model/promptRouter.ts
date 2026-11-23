import {
  type ComponentId,
  type VerifiedProjectAssembly,
  CATALOG_ARCHETYPES,
  ROBOTIC_ARM_ARCHETYPE,
} from '@/shared/domain';

type ActiveLearningContext = {
  readonly assembly: Pick<VerifiedProjectAssembly, 'archetypeId' | 'rootNodeId' | 'nodes'>;
  readonly focusedComponentId?: ComponentId | null;
};

type CanvasPromptClassification =
  | { readonly kind: 'load_assembly' }
  | { readonly kind: 'ask_question'; readonly targetComponentId: ComponentId };

const QUESTION_START =
  /^(what|why|how|which|where|when|who|can|could|does|do|is|are|explain|describe|tell me|compare)\b/i;
const EXPLICIT_LOAD = /^(build|load|switch|inspect)\b/;
const OVERVIEW_LOAD = /^(build|load|switch|inspect|open|show|explore|view|create|plan)\b/;
const GENERIC_CATALOG_TERMS = new Set(
  'aerial arm car chassis dof fly gripper ground joint mars mobile robot robotic servo vehicle wheel'.split(
    ' ',
  ),
);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bso[\s-]*(?:arm[\s-]*)?100\b/g, 'so100')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function includesTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

function matchLoadTarget(prompt: string) {
  let bestArchetype: (typeof CATALOG_ARCHETYPES)[number] | undefined;
  let bestScore = 0;
  for (const archetype of CATALOG_ARCHETYPES) {
    const terms = archetype.keywords.filter((term) => !GENERIC_CATALOG_TERMS.has(term));
    const phrases =
      archetype === ROBOTIC_ARM_ARCHETYPE ? [...terms, 'robotic arm', 'robot arm'] : terms;
    const score = phrases.filter((term) => includesTerm(prompt, term)).length;
    if (score > bestScore) {
      bestArchetype = archetype;
      bestScore = score;
    }
  }
  return bestArchetype;
}

function findQuestionTarget(
  prompt: string,
  assembly: ActiveLearningContext['assembly'],
): ComponentId {
  let targetId = assembly.rootNodeId;
  let bestScore = 0;
  const terms = new Set(prompt.split(' '));
  for (const node of assembly.nodes) {
    if (node.id === assembly.rootNodeId) continue;
    const name = normalize(node.name);
    if (name.length === 0) continue;
    const words = name.split(' ');
    const matched = words.filter((word) => terms.has(word)).length;
    const score = includesTerm(prompt, name)
      ? 100 + name.length
      : Math.pow(matched, 2) / words.length;
    if (score > bestScore) {
      bestScore = score;
      targetId = node.id;
    }
  }
  return targetId;
}

export function classifyCanvasPrompt(
  prompt: string,
  activeContext: ActiveLearningContext | null,
): CanvasPromptClassification {
  if (activeContext === null) return { kind: 'load_assembly' };

  const { assembly, focusedComponentId } = activeContext;
  const normalized = normalize(prompt);
  const command = normalized.replace(/^(?:please |i want to |i d like to |let s )+/, '');
  const isQuestion =
    prompt.trimEnd().endsWith('?') || QUESTION_START.test(command.replace(/^show me /, ''));
  const hasLoadCommand =
    focusedComponentId == null ? OVERVIEW_LOAD.test(command) : EXPLICIT_LOAD.test(command);
  const requestedAssembly = command.split(/ (?:with|for|on|in|of|about) /)[0] ?? command;
  const target = !isQuestion && hasLoadCommand ? matchLoadTarget(requestedAssembly) : undefined;

  if (
    target !== undefined &&
    (focusedComponentId == null ||
      target.archetypeId !== assembly.archetypeId ||
      /^(?:build|load|switch)\b(?!.*\b(?:this|current)\b)/.test(command))
  )
    return { kind: 'load_assembly' };

  return {
    kind: 'ask_question',
    targetComponentId: focusedComponentId ?? findQuestionTarget(normalized, assembly),
  };
}
