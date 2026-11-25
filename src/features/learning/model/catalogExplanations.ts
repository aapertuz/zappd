import {
  type AssemblyInstructionStep,
  type AssemblyNode,
  type ComponentExplanationRecord,
  type ComponentRelationship,
  type VerifiedProjectAssembly,
  getCatalogArchetypeById,
} from '@/shared/domain';

import {
  describePurpose,
  formatConnection,
  formatDimensions,
  formatSpecification,
  humanizeMaterial,
  humanizeName,
  humanizeTechnicalText,
} from './learningLanguage';

function purposeSpecification({ specifications }: AssemblyNode): string | undefined {
  return [specifications.purpose, specifications.function, specifications.role].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

export function describeLearningProject(assembly: VerifiedProjectAssembly) {
  const catalog = getCatalogArchetypeById(assembly.archetypeId);
  const parameters = assembly.parameters?.map(({ name, label, unit, value }) => {
    const current = assembly.parameterValues?.[name] ?? value;
    return `${label} ${current}${unit === 'mm' ? ' mm' : unit === 'deg' ? '°' : ''}`;
  });
  const currentDimensions =
    parameters === undefined || parameters.length === 0
      ? undefined
      : `Current parameters are ${parameters.join(', ')}.`;
  return {
    title: currentDimensions === undefined ? assembly.title : (catalog?.title ?? assembly.title),
    catalogSummary: catalog?.summary,
    currentDimensions,
  };
}

function buildOverview(
  assembly: VerifiedProjectAssembly,
  node: AssemblyNode,
  steps: readonly AssemblyInstructionStep[],
): Omit<ComponentExplanationRecord, 'componentId' | 'verificationStatus'> {
  const children = assembly.nodes.filter(({ parentId }) => parentId === node.id);
  const { title, catalogSummary, currentDimensions } = describeLearningProject(assembly);
  const catalogIntro = catalogSummary?.split(' with ')[0];
  const detail =
    catalogIntro === undefined
      ? undefined
      : humanizeTechnicalText(catalogIntro).replace(/^Open-source\b/, 'open-source');
  const article = detail !== undefined && /^[aeiou]/i.test(detail) ? 'an' : 'a';
  const names = children.slice(0, 4).map(({ name }) => humanizeName(name));
  const listedNames =
    names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const describesGroups =
    children.length > 1 && children.every(({ level }) => level === 'subsystem');
  const purpose = purposeSpecification(node);

  return {
    summary: `This is the ${humanizeName(title)}${detail === undefined ? '' : `, ${article} ${detail}`}.`,
    purpose:
      purpose !== undefined
        ? describePurpose(purpose)
        : (currentDimensions ??
          (detail !== undefined || children.length === 0
            ? `The whole model measures ${formatDimensions(node.dimensionsMm)}.`
            : `The model shows ${assembly.nodes.length - 1} ${assembly.nodes.length === 2 ? 'piece' : 'pieces'} in the build.`)),
    operatingPrinciple:
      children.length === 0
        ? 'The saved details don’t break it down into smaller groups.'
        : describesGroups
          ? `Its main groups ${children.length === names.length ? 'are' : 'include'} ${listedNames}.`
          : `You can explore ${listedNames} in this model.`,
    systemRole:
      steps.length === 0
        ? 'The saved details don’t include a build guide yet.'
        : `The build guide breaks it down into ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}.`,
  };
}

export function buildGroundedComponentExplanation(
  assembly: VerifiedProjectAssembly,
  node: AssemblyNode,
  relationships: readonly ComponentRelationship[],
  steps: readonly AssemblyInstructionStep[],
): ComponentExplanationRecord {
  const identity = { componentId: node.id, verificationStatus: node.provenance.verificationStatus };
  if (node.level === 'project' || node.parentId === null || node.materialHint === 'assembly_root') {
    return { ...identity, ...buildOverview(assembly, node, steps) };
  }

  const outgoing = relationships.find(({ fromComponentId }) => fromComponentId === node.id);
  const connection =
    outgoing ?? relationships.find(({ toComponentId }) => toComponentId === node.id);
  const counterpartId =
    connection?.fromComponentId === node.id
      ? connection.toComponentId
      : connection?.fromComponentId;
  const counterpart = assembly.nodes.find(({ id }) => id === counterpartId);
  const parent = assembly.nodes.find(({ id }) => id === node.parentId);
  const relatedStep = steps.find(({ componentIds }) => componentIds.includes(node.id));
  const role = purposeSpecification(node) ?? outgoing?.whyConnected;
  const material = humanizeMaterial(node.materialHint);
  const specification = Object.entries(node.specifications).find(
    ([key]) => !['brepFaces', 'purpose', 'function', 'role'].includes(key),
  );
  const name = `${humanizeName(node.name)}${node.level === 'subsystem' ? ' group' : ''}`;

  return {
    ...identity,
    summary: `The ${name} measures ${formatDimensions(node.dimensionsMm)}${material === null ? '' : ` and is made of ${material}`}.`,
    purpose:
      role !== undefined
        ? describePurpose(role)
        : connection === undefined
          ? 'You can look at it on its own to see its shape.'
          : 'It works with the connected parts to support the whole build.',
    operatingPrinciple:
      connection !== undefined
        ? formatConnection(counterpart?.name, connection.howConnected)
        : specification === undefined
          ? 'The model shows its shape as it fits into the build.'
          : formatSpecification(...specification),
    systemRole:
      relatedStep !== undefined
        ? `It goes on in step ${relatedStep.order} (${humanizeName(relatedStep.title)}).`
        : `It is part of the ${humanizeName(parent?.name ?? assembly.title)}.`,
  };
}
