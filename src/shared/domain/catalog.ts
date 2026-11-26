import { z } from 'zod';

import {
  type AssemblyInstructionStep,
  type AssemblyNode,
  type AssemblyParameter,
  type AssetChecksum,
  type CatalogArchetypeId,
  type ComponentId,
  type ComponentRelationship,
  type GeometryOrigin,
  type ValidationReport,
  type VerificationStatus,
  assemblyInstructionStepSchema,
  assemblyNodeFieldsSchema,
  assemblyParameterSchema,
  canClassifyAsVerified,
  canInspectSourceAssembly,
  componentRelationshipSchema,
  hasVerifiedUpstreamProvenance,
  isAssetChecksum,
  isCatalogArchetypeId,
  isComponentId,
  isGeometryOrigin,
  isVerifiedStatus,
} from './assembly';
import openQuadrupedCatalog from './catalog/assemblies/open_quadruped_v1.json' with { type: 'json' };
import roverCatalog from './catalog/assemblies/open_source_rover_v1.json' with { type: 'json' };
import parametricMultirotorCatalog from './catalog/assemblies/parametric_multirotor_v1.json' with { type: 'json' };
import poppyCatalog from './catalog/assemblies/poppy_humanoid_v1.json' with { type: 'json' };
import quadcopterCatalog from './catalog/assemblies/quadcopter_drone_v1.json' with { type: 'json' };
import reachyMiniCatalog from './catalog/assemblies/reachy_mini_v1.json' with { type: 'json' };
import roboticArmCatalog from './catalog/assemblies/robotic_arm_3dof_v1.json' with { type: 'json' };

export type CatalogComponentBlueprint = Omit<
  AssemblyNode,
  'provenance' | 'glbNodeName' | 'usdzPrimPath'
> & {
  readonly origin: GeometryOrigin;
  readonly spdxLicense: string;
  readonly sourceUrl: string;
  readonly sourceName: string;
  readonly stepFixtureName: string | null;
  readonly expectedStepSha256?: AssetChecksum;
};

export type CatalogArchetypeDefinition = {
  readonly semantics?: 'documented_assembly' | 'source_inspection';
  readonly archetypeId: CatalogArchetypeId;
  readonly title: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  readonly rootNodeId: ComponentId;
  readonly generationMode?: 'reference_catalog' | 'parametric_family';
  readonly spdxLicense?: string;
  readonly nodes: readonly CatalogComponentBlueprint[];
  readonly relationships: readonly ComponentRelationship[];
  readonly assemblySteps: readonly AssemblyInstructionStep[];
  readonly parameters?: readonly AssemblyParameter[];
};

const nonEmptyString = z.string().min(1);
const catalogComponentSchema = z.strictObject({
  ...assemblyNodeFieldsSchema.shape,
  origin: z.custom<GeometryOrigin>(isGeometryOrigin),
  spdxLicense: nonEmptyString,
  sourceUrl: nonEmptyString,
  sourceName: nonEmptyString,
  stepFixtureName: nonEmptyString.nullable(),
  expectedStepSha256: z.custom<AssetChecksum>(isAssetChecksum).optional(),
});

const catalogArchetypeSchema = z.strictObject({
  semantics: z.enum(['documented_assembly', 'source_inspection']).optional(),
  archetypeId: z.custom<CatalogArchetypeId>(isCatalogArchetypeId),
  title: nonEmptyString,
  summary: nonEmptyString,
  keywords: z.array(nonEmptyString),
  rootNodeId: z.custom<ComponentId>(isComponentId),
  generationMode: z.enum(['reference_catalog', 'parametric_family']).optional(),
  spdxLicense: nonEmptyString.optional(),
  nodes: z.array(catalogComponentSchema),
  relationships: z.array(componentRelationshipSchema.strict()),
  assemblySteps: z.array(assemblyInstructionStepSchema.strict()),
  parameters: z.array(assemblyParameterSchema).optional(),
});

export function parseCatalogArchetype(raw: unknown): CatalogArchetypeDefinition {
  return catalogArchetypeSchema.parse(raw);
}

export const QUADCOPTER_ARCHETYPE = parseCatalogArchetype(quadcopterCatalog);
export const ROBOTIC_ARM_ARCHETYPE = parseCatalogArchetype(roboticArmCatalog);
export const ROVER_ARCHETYPE = parseCatalogArchetype(roverCatalog);
export const OPEN_QUADRUPED_ARCHETYPE = parseCatalogArchetype(openQuadrupedCatalog);
export const PARAMETRIC_MULTIROTOR_ARCHETYPE = parseCatalogArchetype(parametricMultirotorCatalog);
export const REACHY_MINI_ARCHETYPE = parseCatalogArchetype(reachyMiniCatalog);
export const POPPY_ARCHETYPE = parseCatalogArchetype(poppyCatalog);

export const CATALOG_ARCHETYPES: readonly CatalogArchetypeDefinition[] = [
  QUADCOPTER_ARCHETYPE,
  ROBOTIC_ARM_ARCHETYPE,
  ROVER_ARCHETYPE,
  OPEN_QUADRUPED_ARCHETYPE,
  PARAMETRIC_MULTIROTOR_ARCHETYPE,
  REACHY_MINI_ARCHETYPE,
  POPPY_ARCHETYPE,
];

export function listCatalogArchetypes(): readonly CatalogArchetypeDefinition[] {
  return CATALOG_ARCHETYPES;
}

export function getCatalogArchetypeById(
  archetypeId: string,
): CatalogArchetypeDefinition | undefined {
  return CATALOG_ARCHETYPES.find((entry) => entry.archetypeId === archetypeId);
}

export function isAllowedProjectAssembly(assembly: {
  readonly archetypeId: string;
  readonly nodes: readonly AssemblyNode[];
  readonly validation: ValidationReport;
  readonly verificationStatus: VerificationStatus;
}): boolean {
  if (
    isVerifiedStatus(assembly.verificationStatus) &&
    canClassifyAsVerified(assembly.validation, assembly.verificationStatus) &&
    hasVerifiedUpstreamProvenance(assembly.nodes, assembly.verificationStatus)
  ) {
    return true;
  }
  return (
    getCatalogArchetypeById(assembly.archetypeId)?.semantics === 'source_inspection' &&
    canInspectSourceAssembly(assembly)
  );
}

export function matchProjectArchetypeFromPrompt(prompt: string): CatalogArchetypeDefinition {
  const normalized = prompt.trim().toLowerCase();
  if (PARAMETRIC_MULTIROTOR_ARCHETYPE.keywords.some((keyword) => normalized.includes(keyword))) {
    return PARAMETRIC_MULTIROTOR_ARCHETYPE;
  }
  let bestArchetype = QUADCOPTER_ARCHETYPE;
  let bestScore = -1;

  for (const candidate of CATALOG_ARCHETYPES) {
    let score = 0;
    for (const keyword of candidate.keywords) {
      if (normalized.includes(keyword)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestArchetype = candidate;
    }
  }

  return bestArchetype;
}
