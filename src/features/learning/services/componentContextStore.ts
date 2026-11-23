import {
  type ComponentId,
  type ComponentLearningContext,
  type LearningContextSource,
  type ProjectLearningDocuments,
  type ResolvedComponentRelationship,
  type VerifiedProjectAssembly,
  getCatalogArchetypeById,
  parseProjectLearningDocuments,
} from '@/shared/domain';
import {
  type FirebaseEmulatorRepository,
  type StoredBinaryFormat,
  defaultFirebaseEmulatorRepository,
} from '@/shared/firebase';

import { buildGroundedComponentExplanation } from '../model/catalogExplanations';

export type LearningContextRepository = Pick<
  FirebaseEmulatorRepository,
  'tryFetchProjectLearningDocsFromFirestore'
>;

export type LearningOfflineStorage = Pick<Storage, 'getItem' | 'setItem'>;

const memoryCache = new Map<string, ProjectLearningDocuments>();

function getBrowserStorage(): LearningOfflineStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function cacheKey({ projectId, manifest }: VerifiedProjectAssembly): string {
  return `zappd:learning:v1:${projectId}:${manifest.manifestHash}`;
}

function readCache(
  key: string,
  storage: LearningOfflineStorage | undefined,
): ProjectLearningDocuments | null {
  const memory = memoryCache.get(key);
  if (memory !== undefined) return memory;
  try {
    const raw = storage?.getItem(key);
    return raw == null ? null : parseProjectLearningDocuments(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCache(
  key: string,
  storage: LearningOfflineStorage | undefined,
  documents: ProjectLearningDocuments,
): void {
  if (storage !== undefined) {
    try {
      storage.setItem(key, JSON.stringify(documents));
      memoryCache.delete(key);
      return;
    } catch {
      memoryCache.set(key, documents);
      return;
    }
  }
  memoryCache.set(key, documents);
}

function buildLearningDocuments(assembly: VerifiedProjectAssembly): ProjectLearningDocuments {
  return {
    nodes: assembly.nodes,
    relationships: assembly.relationships,
    assemblySteps: assembly.assemblySteps,
    explanations: assembly.nodes.map((node) =>
      buildGroundedComponentExplanation(
        assembly,
        node,
        assembly.relationships,
        assembly.assemblySteps,
      ),
    ),
  };
}

export async function hydrateComponentLearningContext({
  assembly,
  repository = defaultFirebaseEmulatorRepository,
  offlineStorage = getBrowserStorage(),
  binaries,
  syncLearningDocuments = true,
}: {
  readonly assembly: VerifiedProjectAssembly;
  readonly repository?: Pick<FirebaseEmulatorRepository, 'saveProjectAssembly'>;
  readonly offlineStorage?: LearningOfflineStorage;
  readonly binaries?: Partial<Record<StoredBinaryFormat, Uint8Array>>;
  readonly syncLearningDocuments?: boolean;
}): Promise<void> {
  const documents = buildLearningDocuments(assembly);
  await repository.saveProjectAssembly(assembly, binaries, {
    componentExplanations: documents.explanations,
    syncLearningDocuments,
  });
  const key = cacheKey(assembly);
  const cached = readCache(key, offlineStorage);
  const cachedIds = new Set(cached?.explanations.map(({ componentId }) => componentId));
  writeCache(key, offlineStorage, {
    ...(cached ?? documents),
    explanations: [
      ...(cached?.explanations ?? []),
      ...documents.explanations.filter(({ componentId }) => !cachedIds.has(componentId)),
    ],
  });
}

function resolveContext(
  assembly: VerifiedProjectAssembly,
  componentId: ComponentId,
  documents: ProjectLearningDocuments,
  contextSource: LearningContextSource,
): ComponentLearningContext | null {
  const nodes = new Map(documents.nodes.map((node) => [node.id, node]));
  const component = nodes.get(componentId);
  const storedExplanation = documents.explanations.find(
    (record) => record.componentId === componentId,
  );
  if (
    component?.provenance.verificationStatus !== 'sourced_verified' ||
    storedExplanation?.verificationStatus !== 'sourced_verified'
  )
    return null;

  const relationships: ResolvedComponentRelationship[] = [];
  for (const relationship of documents.relationships) {
    const outgoing = relationship.fromComponentId === componentId;
    if (!outgoing && relationship.toComponentId !== componentId) continue;
    const counterpartId = outgoing ? relationship.toComponentId : relationship.fromComponentId;
    const counterpart = nodes.get(counterpartId);
    if (counterpart === undefined) return null;
    relationships.push({
      id: relationship.id,
      direction: outgoing ? 'outgoing' : 'incoming',
      counterpartId,
      counterpartName: counterpart.name,
      connectionType: relationship.connectionType,
      howConnected: relationship.howConnected,
      whyConnected: relationship.whyConnected,
    });
  }

  const parent = component.parentId === null ? null : nodes.get(component.parentId);
  if (parent === undefined) return null;
  const relationshipIds = new Set(relationships.map(({ id }) => id));
  return {
    projectId: assembly.projectId,
    archetypeId: assembly.archetypeId,
    projectTitle: assembly.title,
    projectSummary: getCatalogArchetypeById(assembly.archetypeId)?.summary ?? assembly.title,
    component,
    parentComponentName: parent?.name ?? null,
    childComponentNames: documents.nodes
      .filter(({ parentId }) => parentId === component.id)
      .map(({ name }) => name),
    relationships,
    assemblySteps: documents.assemblySteps
      .filter(
        (step) =>
          component.id === assembly.rootNodeId ||
          step.componentIds.includes(component.id) ||
          step.relationshipIds.some((id) => relationshipIds.has(id)),
      )
      .toSorted((left, right) => left.order - right.order),
    storedExplanation,
    contextSource,
  };
}

export async function retrieveComponentLearningContext({
  assembly,
  componentId,
  repository = defaultFirebaseEmulatorRepository,
  offlineStorage = getBrowserStorage(),
}: {
  readonly assembly: VerifiedProjectAssembly;
  readonly componentId: ComponentId;
  readonly repository?: LearningContextRepository;
  readonly offlineStorage?: LearningOfflineStorage;
}): Promise<ComponentLearningContext> {
  const key = cacheKey(assembly);
  let liveDocuments: ProjectLearningDocuments | null;
  try {
    liveDocuments = await repository.tryFetchProjectLearningDocsFromFirestore(
      assembly.projectId,
      componentId,
    );
  } catch {
    liveDocuments = null;
  }

  if (liveDocuments !== null) {
    const context = resolveContext(assembly, componentId, liveDocuments, 'firestore');
    if (context !== null) {
      const cached = readCache(key, offlineStorage);
      writeCache(key, offlineStorage, {
        ...liveDocuments,
        explanations: [
          ...(cached?.explanations.filter((record) => record.componentId !== componentId) ?? []),
          context.storedExplanation,
        ],
      });
      return context;
    }
  }

  const cached = readCache(key, offlineStorage);
  const offlineContext =
    cached === null ? null : resolveContext(assembly, componentId, cached, 'offline_cache');
  if (offlineContext !== null) return offlineContext;

  throw new Error(`No verified learning records are available for component “${componentId}”.`);
}
