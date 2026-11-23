import {
  type AssemblyInstructionStep,
  type AssemblyNode,
  type ComponentExplanationRecord,
  type ComponentRelationship,
  type VerifiedProjectAssembly,
} from '@/shared/domain';

function finishSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function buildGroundedComponentExplanation(
  assembly: VerifiedProjectAssembly,
  node: AssemblyNode,
  relationships: readonly ComponentRelationship[],
  steps: readonly AssemblyInstructionStep[],
): ComponentExplanationRecord {
  const outgoing = relationships.find((relationship) => relationship.fromComponentId === node.id);
  const connections = relationships.filter(
    (relationship) =>
      relationship.fromComponentId === node.id || relationship.toComponentId === node.id,
  );
  const documentedConnection = outgoing ?? connections[0];
  const parent = assembly.nodes.find(({ id }) => id === node.parentId);
  const relatedStep = steps.find(({ componentIds }) => componentIds.includes(node.id));
  const role =
    node.specifications.purpose ?? node.specifications.function ?? node.specifications.role;
  const purpose =
    typeof role === 'string' && role.trim().length > 0
      ? finishSentence(role.trim())
      : (outgoing?.whyConnected ?? 'The component records do not specify a separate purpose.');
  const material = node.materialHint.replaceAll('_', ' ');
  const specification = Object.entries(node.specifications).find(([key]) => key !== 'brepFaces');
  const recordedDetails =
    specification === undefined
      ? ''
      : ` The recorded ${specification[0]} value is ${String(specification[1])}.`;

  const summary = `${node.name} is listed in ${assembly.title}. Its recorded material is ${material} and its dimensions are ${node.dimensionsMm.join(' × ')} mm.`;
  const operatingPrinciple =
    documentedConnection === undefined
      ? `The records describe the component's physical properties.${recordedDetails}`
      : finishSentence(documentedConnection.howConnected);
  const systemRole =
    relatedStep !== undefined
      ? `The assembly guide lists ${node.name} in step ${relatedStep.order}, “${relatedStep.title}”.`
      : parent === undefined
        ? `${node.name} is the top-level assembly in ${assembly.title}.`
        : `${node.name} is part of ${parent.name}.`;

  return {
    componentId: node.id,
    summary,
    purpose,
    operatingPrinciple,
    systemRole,
    verificationStatus: node.provenance.verificationStatus,
  };
}
