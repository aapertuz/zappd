import {
  type AssemblyParameter,
  type CanvasPromptRouteDecision,
  type CatalogArchetypeDefinition,
  type ComponentId,
  type PromptRouteConfidence,
  type VerifiedProjectAssembly,
  CATALOG_ARCHETYPES,
  DRONE_PARAMETRIC_ARCHETYPE_ID,
  PARAMETRIC_MULTIROTOR_ARCHETYPE,
  ROBOTIC_ARM_ARCHETYPE,
  clampAssemblyParameterValues,
  formatUnsupportedModifyNotice,
  supportsDroneParameterPromotion,
} from '@/shared/domain';

export type CanvasPromptContext = {
  readonly assembly: Pick<
    VerifiedProjectAssembly,
    'archetypeId' | 'title' | 'rootNodeId' | 'nodes' | 'parameters'
  >;
  readonly focusedComponentId?: ComponentId | null;
  readonly focusedComponentName?: string | null;
};

const GENERIC_TERMS = new Set(
  'aerial arm car chassis dof fly gripper ground joint mars mobile robot robotic servo vehicle wheel'.split(
    ' ',
  ),
);
const CATALOG_NAMES = CATALOG_ARCHETYPES.map((archetype) => ({
  archetype,
  names: [
    ...archetype.keywords.filter((term) => !GENERIC_TERMS.has(term)),
    ...(archetype === ROBOTIC_ARM_ARCHETYPE ? ['robotic arm', 'robot arm'] : []),
  ],
}));
const SPANISH_LOAD = /^(?:quiero (?:construir|abrir|cargar|ver)|abre|carga)\b/;
const QUESTION_START =
  /^(?:what|why|how|which|where|when|who|does|do|is|are|would|if|explain|describe|tell me|compare|whereabouts)\b/;
const CAPABILITY_MODAL = /^(?:can|could|will|should|may|might)\s+(?:this|the|it|i|a)\b/;
const POLITE_MODAL = /^(?:can|could|would|will)\s+(?:you|we)\b/;
const COMMAND_PREFIX =
  /^(?:(?:hey|ok|okay|now|actually|instead|next|alright|please|can you|could you|can we|could we|would you|will you|help me|i want to|i want|i wanna|i d like to|i would like to|i need to|let s|lets)\s+)+/;
const LOAD_ACTION =
  /^(?:(?:build|load|switch|open|show|explore|view|create|plan|make|generate|design|try|inspect)\b|(?:change to|go to|give me|move to|check out|pull up)\b)/;
const EDIT_ACTION =
  /\b(?:make|change|modify|update|set|increase|decrease|reduce|lower|raise|add|remove|resize|adjust|turn|convert|thicken|thin|widen|narrow|extend|shorten|replace|swap|switch back|give it|attach|mount|paint|reinforce|stretch out|stick|give the)\b/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\bso[\s-]*(?:arm[\s-]*)?100\b/g, 'so100')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

function withinOneEdit(word: string, term: string): boolean {
  if (word.length > term.length) return withinOneEdit(term, word);
  if (term.length - word.length > 1) return false;
  const mismatch = [...word].findIndex((letter, index) => letter !== term[index]);
  if (mismatch === -1) return true;
  return word.slice(mismatch + Number(word.length === term.length)) === term.slice(mismatch + 1);
}

function matchCatalogTarget(text: string) {
  const words = text.split(' ');
  const bareWords = text.replace(/^(?:a|an|the) /, '').split(' ');
  let best:
    | { archetype: CatalogArchetypeDefinition; score: number; exact: boolean; bare: boolean }
    | undefined;
  for (const { archetype, names } of CATALOG_NAMES) {
    let score = 0;
    let exact = false;
    let bare = false;
    for (const catalogName of names) {
      const name = normalize(catalogName);
      const nameWords = name.split(' ');
      const discrepancies = nameWords.filter((word, index) => word !== bareWords[index]);
      bare ||=
        bareWords.length === nameWords.length &&
        (discrepancies.length === 0 ||
          (discrepancies.length === 1 &&
            nameWords.every((word, index) => {
              const token = bareWords[index];
              return (
                token === word ||
                (token !== undefined &&
                  token.length >= 4 &&
                  word.length >= 5 &&
                  withinOneEdit(token, word))
              );
            })));
      if (includesTerm(text, name)) {
        score += name.includes(' ') ? 3 : 2;
        exact = true;
      } else if (
        !name.includes(' ') &&
        name.length >= 5 &&
        words.some((word) => word.length >= 4 && withinOneEdit(word, name))
      ) {
        score += 1;
      }
    }
    if (score > (best?.score ?? 0)) best = { archetype, score, exact, bare };
  }
  return best;
}

const QUESTION_TARGET_STOPWORDS = new Set(
  'a an and are at by for from in is of on or the to with'.split(' '),
);

export function findPromptQuestionTarget(
  prompt: string,
  context: CanvasPromptContext,
): ComponentId {
  const { assembly, focusedComponentId } = context;
  if (focusedComponentId != null) return focusedComponentId;
  const normalized = normalize(prompt);
  const terms = new Set(
    normalized.split(' ').filter((word) => word.length > 0 && !QUESTION_TARGET_STOPWORDS.has(word)),
  );
  let targetId = assembly.rootNodeId;
  let bestScore = 0;
  for (const node of assembly.nodes) {
    if (node.id === assembly.rootNodeId) continue;
    const name = normalize(node.name);
    if (name.length === 0) continue;
    const words = name
      .split(' ')
      .filter((word) => word.length > 0 && !QUESTION_TARGET_STOPWORDS.has(word));
    if (words.length === 0) continue;
    const matched = words.filter((word) => terms.has(word)).length;
    const score = includesTerm(normalized, name)
      ? 100 + name.length
      : (matched * matched) / words.length;
    if (score > bestScore) {
      bestScore = score;
      targetId = node.id;
    }
  }
  return targetId;
}

type ParameterEditRule = {
  readonly name: string;
  readonly increaseBy: RegExp;
  readonly decreaseBy: RegExp;
  readonly value: RegExp;
  readonly increase: RegExp;
  readonly decrease: RegExp;
  readonly increment: number;
};

const DIMENSION_RULES: readonly ParameterEditRule[] = [
  {
    name: 'wheelbase_mm',
    increaseBy:
      /\b(?:increase|grow|widen|expand|add to) (?:the )?wheelbase by (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    decreaseBy:
      /\b(?:decrease|reduce|shrink|narrow|lower) (?:the )?wheelbase by (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    value:
      /\b(\d+(?:\.\d+)?)\s*mm wheelbase\b|\bwheelbase(?: (?:of|to))? (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    increase: /\b(?:wider|larger|bigger) wheelbase\b|\bwheelbase (?:wider|larger|bigger)\b/,
    decrease:
      /\b(?:narrower|smaller|tighter|shorter) wheelbase\b|\bwheelbase (?:narrower|smaller|tighter|shorter)\b/,
    increment: 20,
  },
  {
    name: 'deck_gap_mm',
    increaseBy:
      /\b(?:increase|raise|widen|expand) (?:the )?deck gap by (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    decreaseBy:
      /\b(?:decrease|reduce|lower|narrow|shrink) (?:the )?deck gap by (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    value:
      /\b(\d+(?:\.\d+)?)\s*mm deck gap\b|\bdeck gap(?: (?:of|to))? (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    increase:
      /\b(?:wider|larger|bigger|taller|more) deck gap\b|\bdeck gap (?:wider|larger|bigger|taller)\b|\bmore (?:vertical )?(?:room|space) between (?:the )?decks\b/,
    decrease:
      /\b(?:narrower|smaller|tighter|shorter|less) deck gap\b|\bdeck gap (?:narrower|smaller|tighter|shorter)\b/,
    increment: 4,
  },
  {
    name: 'arm_thickness_mm',
    increaseBy:
      /\b(?:increase|thicken) (?:the )?arm(?: thickness|s)? by (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    decreaseBy:
      /\b(?:decrease|reduce|thin) (?:the )?arm(?: thickness|s)? by (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    value:
      /\b(\d+(?:\.\d+)?)\s*mm (?:thick )?arm(?:s| thickness)?\b|\b(?:arm thickness(?: (?:of|to))?|(?:thicken|thin) (?:the )?arms? to) (\d+(?:\.\d+)?)\s*(?:mm)?\b/,
    increase:
      /\b(?:thicker|beefier|stronger) arms?\b|\barms? (?:thicker|beefier|stronger)\b|\b(?:thicken|beef up) (?:the )?arms?\b/,
    decrease: /\b(?:thinner|slimmer) arms?\b|\barms? (?:thinner|slimmer)\b|\bthin (?:the )?arms?\b/,
    increment: 1,
  },
];

function getRotorCount(text: string, current: number): number | undefined {
  const add = /\b(?:add|plus) (\d+) (?:more )?rotors?\b/.exec(text);
  if (add) return current + Number(add[1]);
  const remove = /\b(?:remove|subtract|minus) (\d+) rotors?\b/.exec(text);
  if (remove) return current - Number(remove[1]);
  const absolute = /\b(\d+) rotors?\b|\brotor count(?: (?:of|to))? (\d+)\b/.exec(text);
  if (absolute) return Number(absolute[1] ?? absolute[2]);
  if (/\bhexacopter\b/.test(text)) return 6;
  if (/\b(?:to|into) (?:a |the )?quadcopter\b/.test(text)) return 4;
  if (/\bmore rotors?\b/.test(text)) return current + 2;
  if (/\b(?:fewer|less) rotors?\b/.test(text)) return current - 2;
  return undefined;
}

function getEditedDimension(text: string, rule: ParameterEditRule, current: number) {
  const increase = rule.increaseBy.exec(text);
  if (increase) return current + Number(increase[1]);
  const decrease = rule.decreaseBy.exec(text);
  if (decrease) return current - Number(decrease[1]);
  const absolute = rule.value.exec(text);
  if (absolute) return Number(absolute[1] ?? absolute[2]);
  if (rule.increase.test(text)) return current + rule.increment;
  if (rule.decrease.test(text)) return current - rule.increment;
  return undefined;
}

export function extractDroneParameterPatch(
  prompt: string,
  parameters: readonly AssemblyParameter[],
): Readonly<Record<string, number>> {
  const text = normalize(prompt);
  const patch: Record<string, number> = {};
  for (const { name, value } of parameters) {
    const rule = DIMENSION_RULES.find((entry) => entry.name === name);
    const updated = rule
      ? getEditedDimension(text, rule, value)
      : name === 'rotor_count'
        ? getRotorCount(text, value)
        : undefined;
    if (updated !== undefined && Number.isFinite(updated)) patch[name] = updated;
  }
  return patch;
}

type PromptClassification = {
  readonly decision: CanvasPromptRouteDecision;
  readonly confidence: PromptRouteConfidence;
};

export function classifyCanvasPromptWithConfidence(
  prompt: string,
  activeContext: CanvasPromptContext | null,
): PromptClassification {
  if (activeContext === null) {
    return { decision: { kind: 'load_assembly' }, confidence: 'high' };
  }

  const { assembly, focusedComponentId } = activeContext;
  const normalized = normalize(prompt);
  const command = normalized.replace(COMMAND_PREFIX, '');
  const polite = POLITE_MODAL.test(normalized);
  const capability = CAPABILITY_MODAL.test(normalized);
  const punctuated = /[?¿]/.test(prompt);
  const requiresCloud =
    punctuated || polite || capability || /\b(?:would|if|or)\b/.test(normalized);
  const askQuestion = (confidence: PromptRouteConfidence): PromptClassification => ({
    decision: {
      kind: 'ask_question',
      targetComponentId: findPromptQuestionTarget(prompt, activeContext),
    },
    confidence,
  });

  const isQuestionStart = QUESTION_START.test(command.replace(/^show me /, ''));
  if (isQuestionStart || capability || (punctuated && /^inspect\b/.test(command))) {
    const mentionsOtherAssembly =
      matchCatalogTarget(normalized)?.archetype.archetypeId !== undefined &&
      matchCatalogTarget(normalized)?.archetype.archetypeId !== assembly.archetypeId;
    const unambiguousQuestion =
      isQuestionStart &&
      !capability &&
      !polite &&
      !mentionsOtherAssembly &&
      !/\b(?:would|if|or)\b/.test(normalized);
    return askQuestion(unambiguousQuestion ? 'high' : 'low');
  }

  const switchTo = /^(?:switch|change|go|move) (?:from .+? )?to (.+)$/.exec(command);
  const destination = switchTo?.[1] ?? command;
  const target = matchCatalogTarget(
    destination.split(/ (?:with|for|on|in|of|about) /)[0] ?? destination,
  );
  const differentAssembly =
    target !== undefined && target.archetype.archetypeId !== assembly.archetypeId;
  const spanishLoad = SPANISH_LOAD.test(command);
  const explicitLoad = switchTo !== null || LOAD_ACTION.test(command) || spanishLoad;
  const bareName = target?.bare === true && !punctuated;
  const mentionsCurrent = /\b(?:this|current)\b/.test(command);
  const editAction = EDIT_ACTION.test(command);
  const addOntoCurrent =
    /\b(?:add|attach|mount|put)\b/.test(command) &&
    /\b(?:on|to|onto|on top of) (?:this|the)\b/.test(command);
  const modifiesCurrent =
    switchTo === null &&
    editAction &&
    (!differentAssembly ||
      /\b(?:taller|shorter|wider|narrower|bigger|smaller|color|red|blue|green|lidar|camera|wheels|raspberry pi|antenna)\b/.test(
        command,
      )) &&
    !/^make me\b/.test(command);

  const droneParameters =
    assembly.parameters?.length && assembly.archetypeId === DRONE_PARAMETRIC_ARCHETYPE_ID
      ? assembly.parameters
      : (PARAMETRIC_MULTIROTOR_ARCHETYPE.parameters ?? []);
  const droneActive =
    assembly.archetypeId === DRONE_PARAMETRIC_ARCHETYPE_ID ||
    supportsDroneParameterPromotion(assembly.archetypeId);
  const targetsAnotherFamily =
    target !== undefined &&
    target.archetype.archetypeId !== DRONE_PARAMETRIC_ARCHETYPE_ID &&
    !supportsDroneParameterPromotion(target.archetype.archetypeId);
  const requestedFreshBuild =
    target !== undefined &&
    !mentionsCurrent &&
    (bareName || spanishLoad || /^(?:build|create|generate|design|load|open)\b/.test(command));
  const patch = extractDroneParameterPatch(destination, droneParameters);
  if (
    droneActive &&
    !addOntoCurrent &&
    !(explicitLoad && targetsAnotherFamily) &&
    !requestedFreshBuild &&
    (!punctuated || editAction || explicitLoad) &&
    Object.keys(patch).length > 0
  ) {
    return {
      decision: {
        kind: 'modify_assembly',
        targetArchetypeId: DRONE_PARAMETRIC_ARCHETYPE_ID,
        parameterValues: clampAssemblyParameterValues(droneParameters, patch),
      },
      confidence:
        requiresCloud || (!editAction && !explicitLoad && !mentionsCurrent) ? 'low' : 'high',
    };
  }

  if (
    target !== undefined &&
    !addOntoCurrent &&
    !modifiesCurrent &&
    !mentionsCurrent &&
    (explicitLoad || (differentAssembly && bareName)) &&
    (differentAssembly ||
      focusedComponentId == null ||
      /^(?:build|load|switch|open)\b/.test(command))
  ) {
    const defaults = PARAMETRIC_MULTIROTOR_ARCHETYPE.parameters ?? [];
    const requestedParameters = extractDroneParameterPatch(destination, defaults);
    const loadParametric =
      target.archetype.archetypeId === DRONE_PARAMETRIC_ARCHETYPE_ID ||
      (supportsDroneParameterPromotion(target.archetype.archetypeId) &&
        Object.keys(requestedParameters).length > 0);
    return {
      decision: {
        kind: 'load_assembly',
        targetArchetypeId: loadParametric
          ? DRONE_PARAMETRIC_ARCHETYPE_ID
          : target.archetype.archetypeId,
        ...(loadParametric && Object.keys(requestedParameters).length > 0
          ? { parameterValues: clampAssemblyParameterValues(defaults, requestedParameters) }
          : {}),
      },
      confidence: requiresCloud || spanishLoad || !target.exact ? 'low' : 'high',
    };
  }

  if (
    addOntoCurrent ||
    (editAction &&
      !/^(?:make me|build this)\b/.test(command) &&
      (!punctuated || polite || modifiesCurrent))
  ) {
    return {
      decision: { kind: 'unsupported_modify', reason: formatUnsupportedModifyNotice(assembly) },
      confidence: 'low',
    };
  }

  return askQuestion('low');
}

export function classifyCanvasPrompt(
  prompt: string,
  activeContext: CanvasPromptContext | null,
): CanvasPromptRouteDecision {
  return classifyCanvasPromptWithConfidence(prompt, activeContext).decision;
}

export { formatUnsupportedModifyNotice };
