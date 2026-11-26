import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'genkit';

import {
  type AiProviderId,
  type AssemblyNode,
  type VerificationStatus,
  type VerifiedProjectAssembly,
  canClassifyAsVerified,
  getCatalogArchetypeById,
  hasVerifiedUpstreamProvenance,
  isVerifiedStatus,
  matchProjectArchetypeFromPrompt,
  parseVerifiedProjectAssembly,
  toCatalogArchetypeId,
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

const execFileAsync = promisify(execFile);

const OrchestrationInputSchema = z.object({
  prompt: z.string().min(1),
  provider: z.enum(['gemini', 'openai', 'deepseek']).default('gemini'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  injectCollisionTest: z.boolean().optional(),
  requireLiveApiKey: z.boolean().optional(),
});

const PUBLISHED_ASSEMBLY_FILE_NAMES = [
  'model.glb',
  'model.step',
  'model.usdz',
  'manifest.json',
  'pipeline_result.json',
] as const;

const RetrievalInputSchema = z.object({
  archetypeId: z.string().min(1),
});

const CadValidationInputSchema = z.object({
  archetypeId: z.string().min(1),
  outputDir: z.string().min(1),
  injectCollisionTest: z.boolean().optional(),
});

export type ComponentRetrievalSummary = {
  readonly archetypeId: string;
  readonly title: string;
  readonly totalNodes: number;
  readonly openCatalogCount: number;
  readonly relationshipsCount: number;
  readonly assemblyStepsCount: number;
};

type CadWorkerPayload = {
  readonly archetypeId: string;
  readonly verificationStatus: VerificationStatus;
  readonly nodes: readonly AssemblyNode[];
  readonly manifest: VerifiedProjectAssembly['manifest'];
  readonly validation: VerifiedProjectAssembly['validation'];
  readonly glbNodeIds: readonly string[];
  readonly usdzPrimPaths: readonly string[];
};

function resolveRepoRoot(): string {
  return path.resolve(process.cwd());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCadWorkerPayload(raw: unknown): CadWorkerPayload {
  if (!isRecord(raw)) {
    throw new Error('CAD worker result must be an object');
  }
  const nodes = raw.nodes;
  const glbNodeIds = raw.glbNodeIds;
  const usdzPrimPaths = raw.usdzPrimPaths;
  if (!Array.isArray(nodes) || !Array.isArray(glbNodeIds) || !Array.isArray(usdzPrimPaths)) {
    throw new Error('CAD worker result missing nodes, glbNodeIds, or usdzPrimPaths');
  }
  const dummyAssembly = parseVerifiedProjectAssembly({
    projectId: 'proj_check',
    archetypeId: raw.archetypeId,
    title: 'Validation Check',
    userPrompt: 'Validation Check',
    verificationStatus: raw.verificationStatus,
    rootNodeId: 'proj_root',
    nodes,
    relationships: [],
    assemblySteps: [],
    manifest: raw.manifest,
    validation: raw.validation,
    orchestration: {
      provider: 'gemini',
      modelId: 'googleai/gemini-2.5-flash',
      apiFormat: 'google_genai',
      baseUrl: 'https://generativelanguage.googleapis.com',
      executionMode: 'local_catalog_planner',
      plannedSubsystems: [],
    },
  });
  return {
    archetypeId: dummyAssembly.archetypeId,
    verificationStatus: dummyAssembly.verificationStatus,
    nodes: dummyAssembly.nodes,
    manifest: dummyAssembly.manifest,
    validation: dummyAssembly.validation,
    glbNodeIds: glbNodeIds.map(String),
    usdzPrimPaths: usdzPrimPaths.map(String),
  };
}

async function fileSha256Hex(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function tryReuseVerifiedExports(args: {
  readonly archetypeId: string;
  readonly outputDir: string;
}): Promise<CadWorkerPayload | null> {
  const precomputedDir = path.join(
    resolveRepoRoot(),
    'backend',
    'data',
    'exports',
    args.archetypeId,
  );
  const catalogArchetype = getCatalogArchetypeById(args.archetypeId);
  if (catalogArchetype === undefined) {
    return null;
  }

  try {
    await Promise.all(
      PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) =>
        fs.access(path.join(precomputedDir, fileName)),
      ),
    );
    const rawJson: unknown = JSON.parse(
      await fs.readFile(path.join(precomputedDir, 'pipeline_result.json'), 'utf8'),
    );
    const workerResult = parseCadWorkerPayload(rawJson);
    if (!isVerifiedStatus(workerResult.verificationStatus)) {
      return null;
    }
    if (!canClassifyAsVerified(workerResult.validation, workerResult.verificationStatus)) {
      return null;
    }
    if (!hasVerifiedUpstreamProvenance(workerResult.nodes, workerResult.verificationStatus)) {
      return null;
    }
    const expectedIds = new Set(catalogArchetype.nodes.map((node) => node.id));
    const actualIds = new Set(workerResult.nodes.map((node) => node.id));
    if (expectedIds.size !== actualIds.size) {
      return null;
    }
    for (const id of expectedIds) {
      if (!actualIds.has(id)) {
        return null;
      }
    }
    const mappingOk = verifyOneToOneNodeMapping(
      workerResult.nodes,
      workerResult.glbNodeIds,
      workerResult.usdzPrimPaths,
    );
    if (!mappingOk) {
      return null;
    }
    const [stepSha, glbSha, usdzSha] = await Promise.all([
      fileSha256Hex(path.join(precomputedDir, 'model.step')),
      fileSha256Hex(path.join(precomputedDir, 'model.glb')),
      fileSha256Hex(path.join(precomputedDir, 'model.usdz')),
    ]);
    if (
      stepSha !== workerResult.manifest.files.step.sha256 ||
      glbSha !== workerResult.manifest.files.glb.sha256 ||
      usdzSha !== workerResult.manifest.files.usdz.sha256
    ) {
      return null;
    }
    await fs.mkdir(args.outputDir, { recursive: true });
    await Promise.all(
      PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) =>
        fs.copyFile(path.join(precomputedDir, fileName), path.join(args.outputDir, fileName)),
      ),
    );
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

async function runCadAssemblyAndValidation(args: {
  readonly archetypeId: string;
  readonly outputDir: string;
  readonly injectCollisionTest?: boolean;
}): Promise<CadWorkerPayload> {
  if (args.injectCollisionTest !== true) {
    const reused = await tryReuseVerifiedExports(args);
    if (reused !== null) {
      return reused;
    }
  }

  const repoRoot = resolveRepoRoot();
  const pythonBin = path.join(repoRoot, 'backend', '.venv', 'bin', 'python');
  const cliScript = path.join(repoRoot, 'backend', 'cad_worker', 'cli.py');
  const jsonOutPath = path.join(args.outputDir, 'pipeline_result.json');

  const cliArgs = [
    cliScript,
    '--archetype',
    args.archetypeId,
    '--output-dir',
    args.outputDir,
    '--json-out',
    jsonOutPath,
  ];
  if (args.injectCollisionTest === true) {
    cliArgs.push('--inject-collision-test');
  }

  await execFileAsync(pythonBin, cliArgs, { cwd: repoRoot });
  const rawJson: unknown = JSON.parse(await fs.readFile(jsonOutPath, 'utf8'));
  const workerResult = parseCadWorkerPayload(rawJson);

  const { verificationStatus, validation, nodes } = workerResult;
  const mappingOk = verifyOneToOneNodeMapping(
    nodes,
    workerResult.glbNodeIds,
    workerResult.usdzPrimPaths,
  );
  if (
    !isVerifiedStatus(verificationStatus) ||
    !canClassifyAsVerified(validation, verificationStatus) ||
    !mappingOk ||
    !hasVerifiedUpstreamProvenance(nodes, verificationStatus)
  ) {
    throw new Error(
      `OpenCascade validation rejected assembly "${args.archetypeId}": ${workerResult.validation.failures.join('; ')}`,
    );
  }

  return workerResult;
}

async function publishAssemblyArtifacts(workDir: string, archetypeId: string): Promise<void> {
  const publicDir = path.join(resolveRepoRoot(), 'public', 'assemblies', archetypeId);
  await fs.mkdir(publicDir, { recursive: true });
  await Promise.all(
    PUBLISHED_ASSEMBLY_FILE_NAMES.map((fileName) =>
      fs.copyFile(path.join(workDir, fileName), path.join(publicDir, fileName)),
    ),
  );
}

async function executeProjectOrchestration(
  args: {
    readonly prompt: string;
    readonly provider: AiProviderId;
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly injectCollisionTest?: boolean;
    readonly requireLiveApiKey?: boolean;
  },
  repository: FirebaseEmulatorRepository,
): Promise<VerifiedProjectAssembly> {
  const plan: ProviderPlanResolution = await planProjectWithProvider({
    prompt: args.prompt,
    provider: args.provider,
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    requireLiveApiKey: args.requireLiveApiKey,
  });
  const retrieval = await runComponentRetrieval(plan.archetypeId);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zappd-cad-run-'));
  try {
    const cadResult = await runCadAssemblyAndValidation({
      archetypeId: retrieval.archetypeId,
      outputDir: workDir,
      injectCollisionTest: args.injectCollisionTest,
    });

    const archetype =
      getCatalogArchetypeById(retrieval.archetypeId) ??
      matchProjectArchetypeFromPrompt(args.prompt);

    const catalogNodesById = new Map(archetype.nodes.map((node) => [node.id, node]));
    const assembly: VerifiedProjectAssembly = {
      projectId: toProjectId(
        `proj_${archetype.archetypeId}_${cadResult.manifest.manifestHash.slice(0, 8)}`,
      ),
      archetypeId: toCatalogArchetypeId(archetype.archetypeId),
      title: plan.projectTitle,
      userPrompt: args.prompt,
      verificationStatus: cadResult.verificationStatus,
      rootNodeId: archetype.rootNodeId,
      nodes: cadResult.nodes.map((node) => {
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
      }),
      relationships: archetype.relationships,
      assemblySteps: archetype.assemblySteps,
      manifest: cadResult.manifest,
      validation: cadResult.validation,
      orchestration: {
        provider: plan.provider,
        modelId: plan.modelId,
        apiFormat: plan.apiFormat,
        baseUrl: plan.baseUrl,
        executionMode: plan.executionMode,
        plannedSubsystems: plan.plannedSubsystems,
      },
    };

    const [stepBytes, glbBytes, usdzBytes, manifestBytes] = await Promise.all([
      fs.readFile(path.join(workDir, 'model.step')),
      fs.readFile(path.join(workDir, 'model.glb')),
      fs.readFile(path.join(workDir, 'model.usdz')),
      fs.readFile(path.join(workDir, 'manifest.json')),
    ]);

    await repository.saveProjectAssembly(
      assembly,
      {
        step: new Uint8Array(stepBytes),
        glb: new Uint8Array(glbBytes),
        usdz: new Uint8Array(usdzBytes),
        manifest: new Uint8Array(manifestBytes),
      },
      { syncLiveEmulator: false },
    );
    await publishAssemblyArtifacts(workDir, archetype.archetypeId);

    return assembly;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
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
      runCadAssemblyAndValidation({
        archetypeId: input.archetypeId,
        outputDir: input.outputDir,
        injectCollisionTest: input.injectCollisionTest,
      }),
  );

  const orchestrateProjectFlow = ai.defineFlow(
    {
      name: 'orchestrateProjectAssemblyCreation',
      inputSchema: OrchestrationInputSchema,
    },
    async (input) =>
      executeProjectOrchestration(
        {
          prompt: input.prompt,
          provider: input.provider,
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          injectCollisionTest: input.injectCollisionTest,
          requireLiveApiKey: input.requireLiveApiKey,
        },
        repository,
      ),
  );

  return {
    ai,
    projectPlanningFlow,
    componentRetrievalFlow,
    cadAssemblyAndValidationFlow,
    orchestrateProjectFlow,
  };
}

export async function orchestrateProjectAssemblyCreation(args: {
  readonly prompt: string;
  readonly provider?: AiProviderId;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly injectCollisionTest?: boolean;
  readonly requireLiveApiKey?: boolean;
  readonly repository?: FirebaseEmulatorRepository;
}): Promise<VerifiedProjectAssembly> {
  const repository = args.repository ?? defaultFirebaseEmulatorRepository;
  createZappdOrchestratorFlows(repository);
  return executeProjectOrchestration(
    {
      prompt: args.prompt,
      provider: args.provider ?? 'gemini',
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      injectCollisionTest: args.injectCollisionTest,
      requireLiveApiKey: args.requireLiveApiKey,
    },
    repository,
  );
}
