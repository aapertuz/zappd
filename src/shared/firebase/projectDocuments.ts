import { z } from 'zod';

import {
  type ComponentExplanationRecord,
  type ComponentRelationship,
  type Vector3Tuple,
  type VerifiedProjectAssembly,
} from '@/shared/domain';

export const LEARNING_DOCUMENT_VERSION = 1;

const firestoreRelationshipSchema = z.looseObject({
  routingWaypointsMeters: z
    .array(z.strictObject({ x: z.number(), y: z.number(), z: z.number() }))
    .transform((waypoints) => waypoints.map(({ x, y, z }): Vector3Tuple => [x, y, z])),
});

export function decodeFirestoreRelationship(raw: unknown): unknown {
  const decoded = firestoreRelationshipSchema.safeParse(raw);
  return decoded.success ? decoded.data : raw;
}

function createRelationshipRecord({
  routingWaypointsMeters,
  ...relationship
}: ComponentRelationship) {
  return routingWaypointsMeters === undefined
    ? relationship
    : {
        ...relationship,
        routingWaypointsMeters: routingWaypointsMeters.map(([x, y, z]) => ({ x, y, z })),
      };
}

export function createProjectRecord(assembly: VerifiedProjectAssembly) {
  return {
    projectId: assembly.projectId,
    archetypeId: assembly.archetypeId,
    title: assembly.title,
    userPrompt: assembly.userPrompt,
    verificationStatus: assembly.verificationStatus,
    rootNodeId: assembly.rootNodeId,
    manifest: assembly.manifest,
    validation: assembly.validation,
    orchestration: assembly.orchestration,
  };
}

type ProjectDocument = {
  readonly path: string;
  readonly data: object;
};

export async function writeProjectDocumentBatches(
  assembly: VerifiedProjectAssembly,
  explanations: readonly ComponentExplanationRecord[],
  commit: (documents: readonly ProjectDocument[]) => Promise<unknown>,
): Promise<number> {
  const project = `projects/${assembly.projectId}`;
  const documents: ProjectDocument[] = [
    ...assembly.nodes.map((data) => ({ path: `${project}/nodes/${data.id}`, data })),
    ...assembly.relationships.map((relationship) => ({
      path: `${project}/relationships/${relationship.id}`,
      data: createRelationshipRecord(relationship),
    })),
    ...assembly.assemblySteps.map((data) => ({ path: `${project}/steps/${data.id}`, data })),
    ...explanations.map((data) => ({
      path: `${project}/explanations/${data.componentId}`,
      data,
    })),
    {
      path: project,
      data: {
        payload: createProjectRecord(assembly),
        learningDocumentVersion: LEARNING_DOCUMENT_VERSION,
      },
    },
  ];
  for (let offset = 0; offset < documents.length; offset += 400) {
    await commit(documents.slice(offset, offset + 400));
  }
  return documents.length;
}
