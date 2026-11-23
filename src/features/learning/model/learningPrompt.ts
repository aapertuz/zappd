import {
  type ComponentLearningContext,
  type LearningRequest,
  buildLearningPromptParts,
} from '@/shared/domain';

const COMMON_WORDS = new Set(
  'about after also and any are answer assembly before build can component could does during explain for from had has have here how into its just like may more not our part project please should some tell than that the their them then there these they this was were what when where which while who why will with would work works you your'.split(
    ' ',
  ),
);

function meaningfulWords(text: string): Set<string> {
  return new Set(
    (
      text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? []
    )
      .map((word) => word.replace(/(?<=.{3})s$/, ''))
      .filter((word) => word.length >= 3 && !COMMON_WORDS.has(word)),
  );
}

function hasSharedWord(first: Set<string>, second: Set<string>): boolean {
  return [...first].some((word) => second.has(word));
}

export function buildLearningPrompt(
  context: ComponentLearningContext,
  request: LearningRequest,
): string {
  const { systemInstruction, prompt } = buildLearningPromptParts(context, request);
  return `${systemInstruction}\n\nReference and task (JSON):\n${prompt}`;
}

export function evaluateLocalInferenceSufficiency(
  text: string,
  context: ComponentLearningContext,
  request: LearningRequest,
): { readonly sufficient: boolean; readonly reason: string | null } {
  const trimmed = text.trim();
  if (trimmed.length < 40 || trimmed.split(/\s+/).length < 8) {
    return { sufficient: false, reason: 'The on-device response was too short.' };
  }
  if (
    /\b(?:as an ai|i (?:cannot|can['’]t|am unable to)|placeholder|lorem ipsum|coming soon|insert (?:text|answer)|no (?:information|context) (?:available|provided))\b/i.test(
      trimmed,
    )
  ) {
    return { sufficient: false, reason: 'The on-device response did not provide an explanation.' };
  }

  const componentTerms = meaningfulWords(
    [
      context.component.name,
      ...Object.keys(context.component.specifications),
      context.component.materialHint,
      ...context.relationships.map(({ counterpartName }) => counterpartName),
    ].join(' '),
  );
  const responseTerms = meaningfulWords(trimmed);
  const identityTerms = meaningfulWords(context.component.name);
  const questionTerms =
    request.kind === 'question'
      ? new Set(
          [...meaningfulWords(request.question)].filter(
            (word) => !identityTerms.has(word) && word !== 'use',
          ),
        )
      : new Set<string>();
  const relevant =
    hasSharedWord(responseTerms, componentTerms) &&
    (questionTerms.size === 0 || hasSharedWord(responseTerms, questionTerms));
  return relevant
    ? { sufficient: true, reason: null }
    : {
        sufficient: false,
        reason: 'The on-device response did not address this component or question.',
      };
}

type SavedFact = { readonly terms: string; readonly text: string };

function savedFacts(context: ComponentLearningContext): readonly SavedFact[] {
  const { component } = context;
  return [
    {
      terms: 'dimension dimensions size measurements width height length',
      text: `${component.name} has recorded dimensions of ${component.dimensionsMm.join(' × ')} mm.`,
    },
    {
      terms: 'material composition made',
      text: `The recorded material for ${component.name} is ${component.materialHint.replaceAll('_', ' ')}.`,
    },
    ...Object.entries(component.specifications).map(([name, value]) => ({
      terms: name,
      text: `The recorded ${name} for ${component.name} is ${String(value)}.`,
    })),
    ...context.relationships.map((relationship) => ({
      terms: `${relationship.counterpartName} connect connection mount attach join`,
      text: `${relationship.counterpartName} connection: ${relationship.howConnected.replace(/[.!?]$/, '')}. ${relationship.whyConnected}`,
    })),
    ...context.assemblySteps.map((step) => ({
      terms: `step ${step.title} ${step.order}`,
      text: `Step ${step.order}, ${step.title}: ${step.summary}`,
    })),
  ];
}

export function formatOfflineLearningFallback(
  context: ComponentLearningContext,
  request: LearningRequest,
): string {
  const { storedExplanation } = context;
  if (request.kind === 'explain') {
    return `Saved explanation. ${storedExplanation.summary} ${storedExplanation.purpose} ${storedExplanation.operatingPrinciple} ${storedExplanation.systemRole}`;
  }

  const componentTerms = meaningfulWords(context.component.name);
  const questionTerms = meaningfulWords(request.question);
  const specificTerms = new Set([...questionTerms].filter((word) => !componentTerms.has(word)));
  const matchingFact = savedFacts(context).find(({ terms }) =>
    hasSharedWord(specificTerms, meaningfulWords(terms)),
  );
  if (matchingFact !== undefined) return `Saved component records. ${matchingFact.text}`;

  if (
    specificTerms.size === 0 ||
    [...specificTerms].every((term) => ['function', 'purpose', 'role', 'use'].includes(term))
  ) {
    return `Saved component records. ${storedExplanation.purpose} ${storedExplanation.operatingPrinciple}`;
  }

  return `The saved records do not answer this question. ${storedExplanation.summary}`;
}
