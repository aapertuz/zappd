import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'genkit';

import {
  type AiProviderId,
  type CatalogArchetypeDefinition,
  type VerifiedProjectAssembly,
  canClassifyAsVerified,
  clampAssemblyParameterValues,
  getCatalogArchetypeById,
  hasVerifiedUpstreamProvenance,
  isAllowedProjectAssembly,
  isVerifiedStatus,
  matchProjectArchetypeFromPrompt,
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

import {
  type AssemblyIdentity,
  type CadWorkerPayload,
  OPTIONAL_INSPECTION_REPORT_FILE_NAMES,
  PUBLISHED_ASSEMBLY_FILE_NAMES,
  createProjectAssembly,
  defaultCatalogIdentity,
  matchesCatalogPlacements,
  matchesVerifiedCatalogExport,
  parseCadWorkerPayload,
  readExportedArtifacts,
  readOptionalInspectionReports,
  readVerifiedCatalogExport,
  usesContentAddressedUrls,
} from './cadExports';

import {
  fetchCloudCatalogPayload,
  matchesCloudArtifactRecords,
  tryPublishAssemblyToFirebaseCloud,
} from './firebaseCloudStore';
import { requestWarmCadBuild } from './warmCadClient';

export { matchesCatalogPlacements } from './cadExports';

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
  syncCloudStorage: z.boolean().optional(),
});

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

type CadBuildOptions = {
  readonly archetypeId: string;
  readonly outputDir: string;
  readonly injectCollisionTest?: boolean;
  readonly allowUnverified?: boolean;
};

type CadParameters = Readonly<Record<string, number>>;

type CadOperation =
  | { readonly cmd: 'build'; readonly parameterValues?: CadParameters }
  | { readonly cmd: 'rebuild_params'; readonly parameterValues: CadParameters };

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
    const { payload } = await readVerifiedCatalogExport(precomputedDir, args.archetype);
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
    return payload;
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

async function tryReuseCloudCatalogExports(
  archetype: CatalogArchetypeDefinition,
): Promise<CadWorkerPayload | null> {
  try {
    const result = await fetchCloudCatalogPayload(archetype.archetypeId);
    if (result === null) return null;

    const { pointer, rawPipelineResult } = result;
    const payload = parseCadWorkerPayload(rawPipelineResult, archetype);
    return payload.verificationStatus === pointer.verificationStatus &&
      matchesVerifiedCatalogExport(payload, archetype) &&
      matchesCloudArtifactRecords(payload.manifest, pointer)
      ? payload
      : null;
  } catch {
    return null;
  }
}

type CadRunResult = {
  readonly payload: CadWorkerPayload;
  readonly source: 'local_export' | 'cloud_catalog' | 'local_build';
};

async function runCadAssemblyAndValidation(
  { archetypeId, outputDir, injectCollisionTest, allowUnverified }: CadBuildOptions,
  operation: CadOperation,
): Promise<CadRunResult> {
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
    if (reused !== null) return { payload: reused, source: 'local_export' };

    const cloud = await tryReuseCloudCatalogExports(archetype);
    if (cloud !== null) return { payload: cloud, source: 'cloud_catalog' };
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

  return { payload: workerResult, source: 'local_build' };
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
  options: Omit<CadBuildOptions, 'outputDir'> &
    AssemblyIdentity & { readonly syncCloudStorage?: boolean },
  operation: CadOperation,
  repository: FirebaseEmulatorRepository,
): Promise<VerifiedProjectAssembly> {
  const archetype = getCatalogArchetypeById(options.archetypeId);
  if (archetype === undefined) {
    throw new Error(`Unknown CAD archetype "${options.archetypeId}"`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zappd-cad-run-'));
  try {
    const { payload: cadResult, source } = await runCadAssemblyAndValidation(
      { ...options, outputDir: workDir },
      operation,
    );
    const assembly = createProjectAssembly(cadResult, archetype, options);

    if (source === 'cloud_catalog') {
      await repository.saveProjectAssembly(assembly, undefined, {
        allowUnverified: options.allowUnverified,
        syncLiveEmulator: false,
      });
      return assembly;
    }

    const artifacts = await readExportedArtifacts(workDir, cadResult);
    await publishAssemblyArtifacts(workDir, cadResult);
    await repository.saveProjectAssembly(assembly, artifacts, {
      allowUnverified: options.allowUnverified,
      syncLiveEmulator: false,
    });
    if (
      source === 'local_build' &&
      (options.syncCloudStorage ?? repository === defaultFirebaseEmulatorRepository) &&
      process.env.ZAPPD_DISABLE_FIREBASE_CLOUD !== '1' &&
      isAllowedProjectAssembly(assembly)
    ) {
      try {
        const [rawPipelineResult, optionalReports] = await Promise.all([
          fs.readFile(path.join(workDir, 'pipeline_result.json')),
          readOptionalInspectionReports(workDir),
        ]);
        await tryPublishAssemblyToFirebaseCloud({
          assembly: createProjectAssembly(cadResult, archetype),
          rawPipelineResult,
          artifacts,
          optionalReports,
          updateCatalogPointer: false,
        });
      } catch (error) {
        console.error('Could not prepare CAD artifacts for Firebase publishing', error);
      }
    }
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
      syncCloudStorage: args.syncCloudStorage,
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

export async function loadCatalogProjectAssembly({
  archetypeId,
  allowUnverified,
  repository = defaultFirebaseEmulatorRepository,
  syncCloudStorage,
}: {
  readonly archetypeId: string;
  readonly allowUnverified?: boolean;
  readonly repository?: FirebaseEmulatorRepository;
  readonly syncCloudStorage?: boolean;
}): Promise<VerifiedProjectAssembly> {
  const archetype = getCatalogArchetypeById(archetypeId);
  if (archetype === undefined) {
    throw new Error(`Unknown CAD archetype "${archetypeId}"`);
  }
  return buildProjectAssembly(
    { ...defaultCatalogIdentity(archetype), archetypeId, allowUnverified, syncCloudStorage },
    { cmd: 'build' },
    repository,
  );
}

export async function rebuildAssemblyWithParameters(
  args: AssemblyIdentity & {
    readonly archetypeId: string;
    readonly parameterValues: CadParameters;
    readonly allowUnverified?: boolean;
    readonly repository?: FirebaseEmulatorRepository;
    readonly syncCloudStorage?: boolean;
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
      (
        await runCadAssemblyAndValidation(input, {
          cmd: 'build',
          parameterValues: input.parameterValues,
        })
      ).payload,
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
