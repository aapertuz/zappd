import {
  type ComponentLearningContext,
  type LearningRequest,
  buildLearningPromptParts,
} from '@/shared/domain';

import {
  describePurpose,
  finishSentence,
  formatConnection,
  formatDimensions,
  formatSpecification,
  humanizeMaterial,
  humanizeName,
  humanizeTechnicalText,
} from './learningLanguage';

const COMMON_WORDS = new Set(
  'about after also and any are answer assembly before build can called component could detail does during explain for from group had has have here how include into its just like may model more not our part project please record save saved should some tell than that the their them then there these they this was were what when where which while who whole why will with would work works you your'.split(
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
      .filter((word) => !COMMON_WORDS.has(word))
      .map((word) => word.replace(/(?<=.{2}[^s])s$/, ''))
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
      context.component.category,
      context.projectTitle,
      context.projectSummary,
      context.parentComponentName ?? '',
      ...context.childComponentNames,
      context.component.materialHint === 'assembly_root' ? '' : context.component.materialHint,
      ...Object.keys(context.component.specifications),
      ...Object.values(context.component.specifications).map(String),
      ...context.relationships.flatMap(({ counterpartName, howConnected, whyConnected }) => [
        counterpartName,
        howConnected,
        whyConnected,
      ]),
      ...context.assemblySteps.map(({ title }) => title),
      context.storedExplanation.summary,
      context.storedExplanation.purpose,
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
  const name = humanizeName(component.name);
  const material = humanizeMaterial(component.materialHint);
  return [
    {
      terms: 'dimension dimensions size measurements width height length',
      text: `The ${name} measures ${formatDimensions(component.dimensionsMm)}.`,
    },
    ...(material === null
      ? []
      : [{ terms: 'material composition made', text: `The ${name} is made of ${material}.` }]),
    ...Object.entries(component.specifications).map(([name, value]) => ({
      terms: name,
      text: formatSpecification(name, value),
    })),
    ...context.relationships.map((relationship) => ({
      terms: `${relationship.counterpartName} connect connection mount attach join`,
      text: `${formatConnection(relationship.counterpartName, relationship.howConnected)} ${describePurpose(relationship.whyConnected, 'This connection')}`,
    })),
    ...context.assemblySteps.map((step) => ({
      terms: `step ${step.title} ${step.order}`,
      text: `The guide covers this in step ${step.order} (${humanizeName(step.title)}). ${finishSentence(humanizeTechnicalText(step.summary))}`,
    })),
  ];
}

function joinExplanationSentences(fields: readonly string[], limit: number): string {
  const sentences = new Map<string, string>();
  for (const field of fields) {
    for (const sentence of field.trim().split(/(?<=[.!?])\s+/)) {
      if (sentence.length === 0) continue;
      const key = sentence.toLowerCase().replace(/[.!?]+$/, '');
      if (!sentences.has(key)) sentences.set(key, finishSentence(sentence));
    }
  }
  return [...sentences.values()].slice(0, limit).join(' ');
}

export function formatOfflineLearningFallback(
  context: ComponentLearningContext,
  request: LearningRequest,
): string {
  const { storedExplanation } = context;
  if (request.kind === 'explain') {
    return joinExplanationSentences(
      [
        storedExplanation.summary,
        storedExplanation.purpose,
        storedExplanation.operatingPrinciple,
        storedExplanation.systemRole,
      ],
      4,
    );
  }

  const componentTerms = meaningfulWords(context.component.name);
  const questionTerms = meaningfulWords(request.question);
  const specificTerms = new Set([...questionTerms].filter((word) => !componentTerms.has(word)));
  const matchingFact = savedFacts(context).find(({ terms }) =>
    hasSharedWord(specificTerms, meaningfulWords(terms)),
  );
  if (matchingFact !== undefined) return matchingFact.text;

  if (
    specificTerms.size === 0 ||
    [...specificTerms].every((term) => ['function', 'purpose', 'role', 'use'].includes(term))
  ) {
    return joinExplanationSentences(
      [storedExplanation.purpose, storedExplanation.operatingPrinciple],
      2,
    );
  }

  return joinExplanationSentences(
    ['The saved details do not cover that yet.', storedExplanation.summary],
    2,
  );
}
