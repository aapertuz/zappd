import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  type AssemblyNode,
  type CatalogArchetypeDefinition,
  type VerifiedProjectAssembly,
  canClassifyAsVerified,
  getAiProviderDescriptor,
  hasVerifiedUpstreamProvenance,
  isAllowedProjectAssembly,
  isVerifiedStatus,
  parseVerifiedProjectAssembly,
  toProjectId,
  verifyOneToOneNodeMapping,
} from '@/shared/domain';

export const PUBLISHED_ASSEMBLY_FILE_NAMES = [
  'model.glb',
  'model.step',
  'model.usdz',
  'manifest.json',
  'pipeline_result.json',
] as const;

export const OPTIONAL_INSPECTION_REPORT_FILE_NAMES = [
  'interference.json',
  'engineering.json',
] as const;

export type CadWorkerPayload = Pick<
  VerifiedProjectAssembly,
  | 'archetypeId'
  | 'verificationStatus'
  | 'nodes'
  | 'relationships'
  | 'assemblySteps'
  | 'manifest'
  | 'validation'
  | 'parameters'
  | 'parameterValues'
> & {
  readonly glbNodeIds: readonly string[];
  readonly usdzPrimPaths: readonly string[];
};

export type AssemblyIdentity = Pick<
  VerifiedProjectAssembly,
  'title' | 'userPrompt' | 'orchestration'
>;

export function matchesCatalogPlacements(
  catalogNodes: readonly Pick<AssemblyNode, 'id' | 'restPositionMeters'>[],
  workerNodes: readonly Pick<AssemblyNode, 'id' | 'restPositionMeters'>[],
): boolean {
  if (catalogNodes.length !== workerNodes.length) {
    return false;
  }
  const byId = new Map(workerNodes.map((node) => [node.id, node]));
  for (const expected of catalogNodes) {
    const actual = byId.get(expected.id);
    if (actual === undefined) {
      return false;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const expectedValue = expected.restPositionMeters[axis];
      const actualValue = actual.restPositionMeters[axis];
      if (
        expectedValue === undefined ||
        actualValue === undefined ||
        Math.abs(expectedValue - actualValue) > 1e-6
      ) {
        return false;
      }
    }
  }
  return true;
}

const workerMetadataSchema = z.object({
  glbNodeIds: z.array(z.string()),
  usdzPrimPaths: z.array(z.string()),
});

export const assetFormats = ['step', 'glb', 'usdz'] as const;

export function parseCadWorkerPayload(
  raw: unknown,
  archetype: CatalogArchetypeDefinition,
): CadWorkerPayload {
  const metadata = workerMetadataSchema.parse(raw);
  const rawPayload = z.record(z.string(), z.unknown()).parse(raw);
  const {
    archetypeId,
    verificationStatus,
    nodes,
    relationships,
    assemblySteps,
    parameters,
    parameterValues,
    manifest,
    validation,
  } = parseVerifiedProjectAssembly({
    ...rawPayload,
    projectId: 'proj_check',
    ...defaultCatalogIdentity(archetype),
    rootNodeId: archetype.rootNodeId,
    relationships: rawPayload.relationships ?? archetype.relationships,
    assemblySteps: rawPayload.assemblySteps ?? archetype.assemblySteps,
  });

  if (archetypeId !== archetype.archetypeId || manifest.archetypeId !== archetypeId) {
    throw new Error('CAD worker exported a different archetype');
  }
  return {
    archetypeId,
    verificationStatus,
    nodes,
    relationships,
    assemblySteps,
    parameters,
    parameterValues,
    manifest,
    validation,
    ...metadata,
  };
}

export function usesContentAddressedUrls({
  manifest,
}: Pick<CadWorkerPayload, 'manifest'>): boolean {
  return assetFormats.every(
    (format) =>
      manifest.files[format].storagePath ===
        `assemblies/${manifest.manifestHash}/model.${format}` &&
      manifest.files[format].publicUrl === `/${manifest.files[format].storagePath}`,
  );
}

export async function readExportedArtifacts(
  workDir: string,
  { manifest }: Pick<CadWorkerPayload, 'manifest'>,
) {
  const [step, glb, usdz, manifestBytes] = await Promise.all([
    fs.readFile(path.join(workDir, 'model.step')),
    fs.readFile(path.join(workDir, 'model.glb')),
    fs.readFile(path.join(workDir, 'model.usdz')),
    fs.readFile(path.join(workDir, 'manifest.json')),
  ]);
  const artifacts = { step, glb, usdz };
  for (const format of assetFormats) {
    const bytes = artifacts[format];
    const file = manifest.files[format];
    if (
      bytes.length === 0 ||
      bytes.length !== file.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    ) {
      throw new Error(`CAD worker exported an invalid ${format.toUpperCase()} artifact`);
    }
  }
  return { ...artifacts, manifest: manifestBytes };
}

export function matchesVerifiedCatalogExport(
  workerResult: CadWorkerPayload,
  archetype: CatalogArchetypeDefinition,
): boolean {
  if (!usesContentAddressedUrls(workerResult) || !isAllowedProjectAssembly(workerResult)) {
    return false;
  }
  if (archetype.semantics === 'source_inspection') {
    if (!matchesCatalogPlacements(archetype.nodes, workerResult.nodes)) {
      return false;
    }
  } else {
    if (
      !isVerifiedStatus(workerResult.verificationStatus) ||
      !canClassifyAsVerified(workerResult.validation, workerResult.verificationStatus) ||
      workerResult.validation.connectivityValid !== true ||
      workerResult.validation.electricalValid !== true
    ) {
      return false;
    }
    if (!hasVerifiedUpstreamProvenance(workerResult.nodes, workerResult.verificationStatus)) {
      return false;
    }
    const expectedNodesById = new Map(archetype.nodes.map((node) => [node.id, node]));
    const matchesCatalogContract =
      workerResult.nodes.length === expectedNodesById.size &&
      workerResult.nodes.every((actual) => {
        const expected = expectedNodesById.get(actual.id);
        if (expected === undefined) {
          return false;
        }
        return (
          actual.category === expected.category &&
          actual.provenance.origin === expected.origin &&
          actual.provenance.sourceUrl === expected.sourceUrl &&
          actual.provenance.spdxLicense === expected.spdxLicense &&
          (expected.expectedStepSha256 === undefined ||
            actual.provenance.stepSha256 === expected.expectedStepSha256) &&
          JSON.stringify(actual.restPositionMeters) ===
            JSON.stringify(expected.restPositionMeters) &&
          JSON.stringify(actual.restRotationDeg ?? null) ===
            JSON.stringify(expected.restRotationDeg ?? null) &&
          JSON.stringify(actual.ports ?? null) === JSON.stringify(expected.ports ?? null) &&
          JSON.stringify(actual.mountingInterfaces ?? null) ===
            JSON.stringify(expected.mountingInterfaces ?? null)
        );
      }) &&
      JSON.stringify(workerResult.relationships) === JSON.stringify(archetype.relationships) &&
      JSON.stringify(workerResult.assemblySteps) === JSON.stringify(archetype.assemblySteps) &&
      !archetype.parameters?.some(
        ({ name, defaultValue }) => workerResult.parameterValues?.[name] !== defaultValue,
      );
    if (!matchesCatalogContract) {
      return false;
    }
  }
  return verifyOneToOneNodeMapping(
    workerResult.nodes,
    workerResult.glbNodeIds,
    workerResult.usdzPrimPaths,
    { allowUnavailableNodes: archetype.semantics === 'source_inspection' },
  );
}

export type CadExportArtifacts = Awaited<ReturnType<typeof readExportedArtifacts>>;
export type InspectionReportName = (typeof OPTIONAL_INSPECTION_REPORT_FILE_NAMES)[number];

export async function readOptionalInspectionReports(
  dir: string,
): Promise<Partial<Record<InspectionReportName, Uint8Array>>> {
  const reports: Partial<Record<InspectionReportName, Uint8Array>> = {};
  for (const name of OPTIONAL_INSPECTION_REPORT_FILE_NAMES) {
    try {
      reports[name] = await fs.readFile(path.join(dir, name));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return reports;
}

export async function readVerifiedCatalogExport(
  dir: string,
  archetype: CatalogArchetypeDefinition,
) {
  const rawPipelineResult = await fs.readFile(path.join(dir, 'pipeline_result.json'));
  const raw: unknown = JSON.parse(rawPipelineResult.toString('utf8'));
  const payload = parseCadWorkerPayload(raw, archetype);
  if (!matchesVerifiedCatalogExport(payload, archetype)) {
    throw new Error(`CAD export does not match the catalog contract for ${archetype.archetypeId}`);
  }
  const artifacts = await readExportedArtifacts(dir, payload);
  const rawManifest: unknown = JSON.parse(artifacts.manifest.toString('utf8'));
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('manifest' in raw) ||
    !isDeepStrictEqual(rawManifest, raw.manifest)
  ) {
    throw new Error(`CAD manifest does not match the pipeline result for ${archetype.archetypeId}`);
  }
  return { payload, artifacts, rawPipelineResult };
}

export function defaultCatalogIdentity({ title }: CatalogArchetypeDefinition): AssemblyIdentity {
  const { provider, modelId, apiFormat, defaultBaseUrl } = getAiProviderDescriptor('gemini');
  return {
    title,
    userPrompt: title,
    orchestration: {
      provider,
      modelId,
      apiFormat,
      baseUrl: defaultBaseUrl,
      executionMode: 'local_catalog_planner',
      plannedSubsystems: [],
    },
  };
}

export function createProjectAssembly(
  cadResult: CadWorkerPayload,
  archetype: CatalogArchetypeDefinition,
  identity: AssemblyIdentity = defaultCatalogIdentity(archetype),
): VerifiedProjectAssembly {
  const {
    manifest,
    validation,
    verificationStatus,
    nodes,
    relationships,
    assemblySteps,
    parameters,
    parameterValues,
  } = cadResult;
  const catalogNodesById =
    archetype.generationMode === 'parametric_family'
      ? null
      : new Map(archetype.nodes.map((node) => [node.id, node]));
  const resolvedNodes =
    catalogNodesById === null
      ? nodes
      : nodes.map((node) => {
          const catalogNode = catalogNodesById.get(node.id);
          if (catalogNode === undefined) return node;

          const { enclosureRole: _cachedRole, ...geometryNode } = node;
          const { enclosureRole, explodeDirection, explodeDistanceMeters } = catalogNode;
          return {
            ...geometryNode,
            explodeDirection,
            explodeDistanceMeters,
            ...(enclosureRole === undefined ? {} : { enclosureRole }),
          };
        });
  return {
    projectId: toProjectId(`proj_${archetype.archetypeId}_${manifest.manifestHash.slice(0, 8)}`),
    archetypeId: archetype.archetypeId,
    rootNodeId: archetype.rootNodeId,
    title: identity.title,
    userPrompt: identity.userPrompt,
    orchestration: identity.orchestration,
    manifest,
    validation,
    verificationStatus,
    nodes: resolvedNodes,
    relationships,
    assemblySteps,
    parameters,
    parameterValues,
  };
}
