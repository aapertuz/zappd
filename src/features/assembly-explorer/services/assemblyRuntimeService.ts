import {
  type AiProviderId,
  type VerifiedProjectAssembly,
  canClassifyAsVerified,
  getAiProviderDescriptor,
  matchProjectArchetypeFromPrompt,
  parseVerifiedProjectAssembly,
  toCatalogArchetypeId,
  toProjectId,
} from '@/shared/domain';
import {
  type FirebaseEmulatorRepository,
  defaultFirebaseEmulatorRepository,
} from '@/shared/firebase';

export type LoadedAssemblyBundle = {
  readonly assembly: VerifiedProjectAssembly;
  readonly glbArrayBuffer: ArrayBuffer;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadVerifiedAssemblyForPrompt(args: {
  readonly prompt: string;
  readonly provider: AiProviderId;
  readonly repository?: FirebaseEmulatorRepository;
}): Promise<LoadedAssemblyBundle> {
  const archetype = matchProjectArchetypeFromPrompt(args.prompt);
  const descriptor = getAiProviderDescriptor(args.provider);
  const repository = args.repository ?? defaultFirebaseEmulatorRepository;

  const baseUrl = `/assemblies/${archetype.archetypeId}`;
  const [pipelineResponse, glbResponse] = await Promise.all([
    fetch(`${baseUrl}/pipeline_result.json`),
    fetch(`${baseUrl}/model.glb`),
  ]);

  if (!pipelineResponse.ok) {
    throw new Error(
      `Failed to load CAD pipeline metadata for ${archetype.archetypeId}: HTTP ${pipelineResponse.status}`,
    );
  }
  if (!glbResponse.ok) {
    throw new Error(
      `Failed to load GLB geometry for ${archetype.archetypeId}: HTTP ${glbResponse.status}`,
    );
  }

  const rawPipeline: unknown = await pipelineResponse.json();
  if (!isRecord(rawPipeline) || !isRecord(rawPipeline.manifest)) {
    throw new Error(`Invalid pipeline_result.json payload for ${archetype.archetypeId}`);
  }

  const manifestHash =
    typeof rawPipeline.manifest.manifestHash === 'string'
      ? rawPipeline.manifest.manifestHash
      : '0'.repeat(64);
  const glbArrayBuffer = await glbResponse.arrayBuffer();

  const assembly = parseVerifiedProjectAssembly({
    projectId: toProjectId(`proj_${archetype.archetypeId}_${manifestHash.slice(0, 8)}`),
    archetypeId: toCatalogArchetypeId(archetype.archetypeId),
    title: archetype.title,
    userPrompt: args.prompt,
    verificationStatus: rawPipeline.verificationStatus,
    rootNodeId: archetype.rootNodeId,
    nodes: rawPipeline.nodes,
    relationships: archetype.relationships,
    assemblySteps: archetype.assemblySteps,
    manifest: rawPipeline.manifest,
    validation: rawPipeline.validation,
    orchestration: {
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      apiFormat: descriptor.apiFormat,
      baseUrl: descriptor.defaultBaseUrl,
      executionMode: 'local_catalog_planner',
      plannedSubsystems: archetype.nodes
        .filter((node) => node.level === 'subsystem')
        .map((node) => node.name),
    },
  });

  if (!canClassifyAsVerified(assembly.validation, assembly.verificationStatus)) {
    throw new Error(`Assembly ${assembly.archetypeId} failed OpenCascade validation checks`);
  }

  await repository.saveProjectAssembly(
    assembly,
    {
      glb: new Uint8Array(glbArrayBuffer),
    },
    { syncLiveEmulator: false },
  );

  return {
    assembly,
    glbArrayBuffer,
  };
}
