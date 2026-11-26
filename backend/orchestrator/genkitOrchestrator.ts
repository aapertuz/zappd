import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'genkit';

import {
  type AiProviderId,
  type AssemblyNode,
  type CatalogArchetypeDefinition,
  type VerifiedProjectAssembly,
  canClassifyAsVerified,
  clampAssemblyParameterValues,
  getCatalogArchetypeById,
  hasVerifiedUpstreamProvenance,
  isAllowedProjectAssembly,
  isVerifiedStatus,
  matchProjectArchetypeFromPrompt,
  parseVerifiedProjectAssembly,
  toProjectId,
  verifyOneToOneNodeMapping,
} from '@/shared/domain';
import {
  type FirebaseEmulatorRepository,
  defaultFirebaseEmulatorRepository,
} from '@/shared/firebase';

import {
  type ProviderPlanResolution,
  createMultiProviderGenkitInstance,
  planProjectWithProvider,
} from './aiProviders';

import { requestWarmCadBuild } from './warmCadClient';

const parameterValuesSchema = z.record(z.string(), z.number());

const OrchestrationInputSchema = z.object({
  prompt: z.string().min(1),
  provider: z.enum(['gemini', 'openai', 'deepseek']).default('gemini'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  injectCollisionTest: z.boolean().optional(),
  allowUnverified: z.boolean().optional(),
  parameterValues: parameterValuesSchema.optional(),
  requireLiveApiKey: z.boolean().optional(),
});

const PUBLISHED_ASSEMBLY_FILE_NAMES = [
  'model.glb',
  'model.step',
  'model.usdz',
  'manifest.json',
  'pipeline_result.json',
] as const;

const OPTIONAL_INSPECTION_REPORT_FILE_NAMES = ['interference.json', 'engineering.json'] as const;

const RetrievalInputSchema = z.object({
  archetypeId: z.string().min(1),
});

const CadValidationInputSchema = z.object({
  archetypeId: z.string().min(1),
  outputDir: z.string().min(1),
  injectCollisionTest: z.boolean().optional(),
  allowUnverified: z.boolean().optional(),
  parameterValues: parameterValuesSchema.optional(),
});

export type ComponentRetrievalSummary = {
  readonly archetypeId: string;
  readonly title: string;
  readonly totalNodes: number;
  readonly openCatalogCount: number;
  readonly relationshipsCount: number;
  readonly assemblyStepsCount: number;
};

type CadWorkerPayload = Pick<
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

type CadBuildOptions = {
  readonly archetypeId: string;
  readonly outputDir: string;
  readonly injectCollisionTest?: boolean;
  readonly allowUnverified?: boolean;
};

type CadParameters = Readonly<Record<string, number>>;

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

type CadOperation =
  | { readonly cmd: 'build'; readonly parameterValues?: CadParameters }
  | { readonly cmd: 'rebuild_params'; readonly parameterValues: CadParameters };

type AssemblyIdentity = Pick<VerifiedProjectAssembly, 'title' | 'userPrompt' | 'orchestration'>;

const workerMetadataSchema = z.object({
  glbNodeIds: z.array(z.string()),
  usdzPrimPaths: z.array(z.string()),
});

const assetFormats = ['step', 'glb', 'usdz'] as const;

function parseCadWorkerPayload(
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
    title: archetype.title,
    userPrompt: archetype.title,
    rootNodeId: archetype.rootNodeId,
    relationships: rawPayload.relationships ?? archetype.relationships,
    assemblySteps: rawPayload.assemblySteps ?? archetype.assemblySteps,
    orchestration: {
      provider: 'gemini',
      modelId: 'googleai/gemini-2.5-flash',
      apiFormat: 'google_genai',
      baseUrl: 'https://generativelanguage.googleapis.com',
      executionMode: 'local_catalog_planner',
      plannedSubsystems: [],
    },
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

function usesContentAddressedUrls({ manifest }: CadWorkerPayload): boolean {
  return assetFormats.every(
    (format) =>
      manifest.files[format].publicUrl === `/assemblies/${manifest.manifestHash}/model.${format}`,
  );
}

async function readExportedArtifacts(workDir: string, { manifest }: CadWorkerPayload) {
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

async function tryReuseVerifiedExports(args: {
  readonly archetype: CatalogArchetypeDefinition;
  readonly outputDir: string;
}): Promise<CadWorkerPayload | null> {
  const precomputedDir = path.join(
    process.cwd(),
    'backend',
    'data',
    'exports',
    args.archetype.archetypeId,
  );

  try {
    await Promise.all(
      PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) =>
        fs.access(path.join(precomputedDir, fileName)),
      ),
    );
    const rawJson: unknown = JSON.parse(
      await fs.readFile(path.join(precomputedDir, 'pipeline_result.json'), 'utf8'),
    );
    const workerResult = parseCadWorkerPayload(rawJson, args.archetype);
    if (!usesContentAddressedUrls(workerResult) || !isAllowedProjectAssembly(workerResult)) {
      return null;
    }
    if (args.archetype.semantics === 'source_inspection') {
      if (!matchesCatalogPlacements(args.archetype.nodes, workerResult.nodes)) {
        return null;
      }
    } else {
      if (
        !isVerifiedStatus(workerResult.verificationStatus) ||
        !canClassifyAsVerified(workerResult.validation, workerResult.verificationStatus) ||
        workerResult.validation.connectivityValid !== true ||
        workerResult.validation.electricalValid !== true
      ) {
        return null;
      }
      if (!hasVerifiedUpstreamProvenance(workerResult.nodes, workerResult.verificationStatus)) {
        return null;
      }
      const expectedNodesById = new Map(args.archetype.nodes.map((node) => [node.id, node]));
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
        JSON.stringify(workerResult.relationships) ===
          JSON.stringify(args.archetype.relationships) &&
        JSON.stringify(workerResult.assemblySteps) ===
          JSON.stringify(args.archetype.assemblySteps) &&
        !args.archetype.parameters?.some(
          ({ name, defaultValue }) => workerResult.parameterValues?.[name] !== defaultValue,
        );
      if (!matchesCatalogContract) {
        return null;
      }
    }
    const mappingOk = verifyOneToOneNodeMapping(
      workerResult.nodes,
      workerResult.glbNodeIds,
      workerResult.usdzPrimPaths,
      { allowUnavailableNodes: args.archetype.semantics === 'source_inspection' },
    );
    if (!mappingOk) {
      return null;
    }
    await readExportedArtifacts(precomputedDir, workerResult);
    await fs.mkdir(args.outputDir, { recursive: true });
    await Promise.all([
      ...PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) =>
        fs.copyFile(path.join(precomputedDir, fileName), path.join(args.outputDir, fileName)),
      ),
      ...OPTIONAL_INSPECTION_REPORT_FILE_NAMES.map(async (fileName) => {
        try {
          await fs.copyFile(
            path.join(precomputedDir, fileName),
            path.join(args.outputDir, fileName),
          );
        } catch {}
      }),
    ]);
    return workerResult;
  } catch {
    return null;
  }
}

async function runComponentRetrieval(archetypeId: string): Promise<ComponentRetrievalSummary> {
  const archetype =
    getCatalogArchetypeById(archetypeId) ?? matchProjectArchetypeFromPrompt(archetypeId);
  const openCatalogCount = archetype.nodes.filter(
    (node) => node.origin === 'open_step_catalog',
  ).length;
  return {
    archetypeId: archetype.archetypeId,
    title: archetype.title,
    totalNodes: archetype.nodes.length,
    openCatalogCount,
    relationshipsCount: archetype.relationships.length,
    assemblyStepsCount: archetype.assemblySteps.length,
  };
}

async function runCadAssemblyAndValidation(
  { archetypeId, outputDir, injectCollisionTest, allowUnverified }: CadBuildOptions,
  operation: CadOperation,
): Promise<CadWorkerPayload> {
  const archetype = getCatalogArchetypeById(archetypeId);
  if (archetype === undefined) {
    throw new Error(`Unknown CAD archetype "${archetypeId}"`);
  }

  const { parameterValues } = operation;
  if (parameterValues !== undefined && archetype.parameters === undefined) {
    throw new Error(`CAD archetype "${archetypeId}" does not support parameters`);
  }
  if (
    operation.cmd === 'build' &&
    injectCollisionTest !== true &&
    (parameterValues === undefined ||
      archetype.parameters?.every(
        ({ name, defaultValue }) => parameterValues[name] === defaultValue,
      ))
  ) {
    const reused = await tryReuseVerifiedExports({ archetype, outputDir });
    if (reused !== null) {
      return reused;
    }
  }

  await requestWarmCadBuild({
    ...operation,
    archetypeId,
    outputDir,
    injectCollisionTest,
    cacheDir: path.resolve('backend/data/open_step_cache'),
  });
  const raw: unknown = JSON.parse(
    await fs.readFile(path.join(outputDir, 'pipeline_result.json'), 'utf8'),
  );
  const workerResult = parseCadWorkerPayload(raw, archetype);
  if (!usesContentAddressedUrls(workerResult)) {
    throw new Error('CAD worker exported non-canonical asset URLs');
  }

  const { verificationStatus, validation, nodes, glbNodeIds, usdzPrimPaths } = workerResult;
  const isSourceInspection = archetype.semantics === 'source_inspection';
  const mappingOk = verifyOneToOneNodeMapping(nodes, glbNodeIds, usdzPrimPaths, {
    allowUnavailableNodes: isSourceInspection,
  });
  const placementsMatch =
    archetype.generationMode === 'parametric_family' ||
    matchesCatalogPlacements(archetype.nodes, nodes);
  const accepted =
    injectCollisionTest === true
      ? allowUnverified === true && verificationStatus === 'unverified'
      : isVerifiedStatus(verificationStatus)
        ? canClassifyAsVerified(validation, verificationStatus) &&
          hasVerifiedUpstreamProvenance(nodes, verificationStatus) &&
          mappingOk
        : (isSourceInspection &&
            isAllowedProjectAssembly(workerResult) &&
            mappingOk &&
            placementsMatch) ||
          allowUnverified === true;
  if (!accepted) {
    throw new Error(
      `OpenCascade validation rejected assembly "${archetypeId}": ${validation.failures.join('; ')}`,
    );
  }

  return workerResult;
}

async function hasValidPublishedArtifacts(
  publicDir: string,
  cadResult: CadWorkerPayload,
): Promise<boolean> {
  try {
    await Promise.all(
      PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) => fs.access(path.join(publicDir, fileName))),
    );
    await readExportedArtifacts(publicDir, cadResult);
    return true;
  } catch {
    return false;
  }
}

async function publishAssemblyArtifacts(
  workDir: string,
  cadResult: CadWorkerPayload,
): Promise<void> {
  const assembliesDir = path.resolve('public/assemblies');
  const publicDir = path.join(assembliesDir, cadResult.manifest.manifestHash);
  await fs.mkdir(assembliesDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(assembliesDir, '.publish-'));
  try {
    await Promise.all([
      ...PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) =>
        fs.copyFile(path.join(workDir, fileName), path.join(stagingDir, fileName)),
      ),
      ...OPTIONAL_INSPECTION_REPORT_FILE_NAMES.map(async (fileName) => {
        try {
          await fs.copyFile(path.join(workDir, fileName), path.join(stagingDir, fileName));
        } catch {}
      }),
    ]);
    try {
      await fs.rename(stagingDir, publicDir);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
      )) {
        throw error;
      }
      if (!(await hasValidPublishedArtifacts(publicDir, cadResult))) {
        await fs.rm(publicDir, { recursive: true, force: true });
        await fs.rename(stagingDir, publicDir);
      }
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function buildProjectAssembly(
  options: Omit<CadBuildOptions, 'outputDir'> & AssemblyIdentity,
  operation: CadOperation,
  repository: FirebaseEmulatorRepository,
): Promise<VerifiedProjectAssembly> {
  const archetype = getCatalogArchetypeById(options.archetypeId);
  if (archetype === undefined) {
    throw new Error(`Unknown CAD archetype "${options.archetypeId}"`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zappd-cad-run-'));
  try {
    const cadResult = await runCadAssemblyAndValidation(
      { ...options, outputDir: workDir },
      operation,
    );
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
    const assembly: VerifiedProjectAssembly = {
      projectId: toProjectId(`proj_${archetype.archetypeId}_${manifest.manifestHash.slice(0, 8)}`),
      archetypeId: archetype.archetypeId,
      rootNodeId: archetype.rootNodeId,
      title: options.title,
      userPrompt: options.userPrompt,
      orchestration: options.orchestration,
      manifest,
      validation,
      verificationStatus,
      nodes: resolvedNodes,
      relationships,
      assemblySteps,
      parameters,
      parameterValues,
    };

    const artifacts = await readExportedArtifacts(workDir, cadResult);
    await publishAssemblyArtifacts(workDir, cadResult);
    await repository.saveProjectAssembly(assembly, artifacts, {
      allowUnverified: options.allowUnverified,
      syncLiveEmulator: false,
    });
    return assembly;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

type OrchestrationOptions = Omit<
  z.infer<typeof OrchestrationInputSchema>,
  'provider' | 'parameterValues'
> & {
  readonly provider?: AiProviderId;
  readonly parameterValues?: CadParameters;
};

async function executeProjectOrchestration(
  args: OrchestrationOptions,
  repository: FirebaseEmulatorRepository,
): Promise<VerifiedProjectAssembly> {
  const plan: ProviderPlanResolution = await planProjectWithProvider({
    ...args,
    provider: args.provider ?? 'gemini',
  });
  const archetype = getCatalogArchetypeById(plan.archetypeId);
  const parameterValues = archetype?.parameters
    ? clampAssemblyParameterValues(archetype.parameters, {
        ...plan.parameterValues,
        ...args.parameterValues,
      })
    : args.parameterValues;

  return buildProjectAssembly(
    {
      archetypeId: plan.archetypeId,
      title: plan.projectTitle,
      userPrompt: args.prompt,
      injectCollisionTest: args.injectCollisionTest,
      allowUnverified: args.allowUnverified,
      orchestration: {
        provider: plan.provider,
        modelId: plan.modelId,
        apiFormat: plan.apiFormat,
        baseUrl: plan.baseUrl,
        executionMode: plan.executionMode,
        plannedSubsystems: plan.plannedSubsystems,
      },
    },
    { cmd: 'build', parameterValues },
    repository,
  );
}

export async function rebuildAssemblyWithParameters(
  args: AssemblyIdentity & {
    readonly archetypeId: string;
    readonly parameterValues: CadParameters;
    readonly allowUnverified?: boolean;
    readonly repository?: FirebaseEmulatorRepository;
  },
): Promise<VerifiedProjectAssembly> {
  const parameters = getCatalogArchetypeById(args.archetypeId)?.parameters;
  if (parameters === undefined || parameters.length === 0) {
    throw new Error(`CAD archetype "${args.archetypeId}" does not support parameters`);
  }
  return buildProjectAssembly(
    args,
    {
      cmd: 'rebuild_params',
      parameterValues: clampAssemblyParameterValues(parameters, args.parameterValues),
    },
    args.repository ?? defaultFirebaseEmulatorRepository,
  );
}

export function createZappdOrchestratorFlows(repository: FirebaseEmulatorRepository) {
  const ai = createMultiProviderGenkitInstance();

  const projectPlanningFlow = ai.defineFlow(
    {
      name: 'projectPlanningAgent',
      inputSchema: OrchestrationInputSchema,
    },
    async (input) =>
      planProjectWithProvider({
        prompt: input.prompt,
        provider: input.provider,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        requireLiveApiKey: input.requireLiveApiKey,
      }),
  );

  const componentRetrievalFlow = ai.defineFlow(
    {
      name: 'componentRetrievalAgent',
      inputSchema: RetrievalInputSchema,
    },
    async (input) => runComponentRetrieval(input.archetypeId),
  );

  const cadAssemblyAndValidationFlow = ai.defineFlow(
    {
      name: 'cadAssemblyAndValidationAgent',
      inputSchema: CadValidationInputSchema,
    },
    async (input) =>
      runCadAssemblyAndValidation(input, { cmd: 'build', parameterValues: input.parameterValues }),
  );

  const orchestrateProjectFlow = ai.defineFlow(
    {
      name: 'orchestrateProjectAssemblyCreation',
      inputSchema: OrchestrationInputSchema,
    },
    async (input) => executeProjectOrchestration(input, repository),
  );

  return {
    ai,
    projectPlanningFlow,
    componentRetrievalFlow,
    cadAssemblyAndValidationFlow,
    orchestrateProjectFlow,
  };
}

export function orchestrateProjectAssemblyCreation(
  args: OrchestrationOptions & { readonly repository?: FirebaseEmulatorRepository },
): Promise<VerifiedProjectAssembly> {
  return executeProjectOrchestration(args, args.repository ?? defaultFirebaseEmulatorRepository);
}
