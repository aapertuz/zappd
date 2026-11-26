import { type Firestore, collection, doc, getDoc, getDocs, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';

import {
  type AssemblyInstructionStep,
  type AssemblyNode,
  type ComponentExplanationRecord,
  type ComponentId,
  type ComponentRelationship,
  type ProjectId,
  type ProjectLearningDocuments,
  type VerifiedProjectAssembly,
  canRenderAssembly,
  isAllowedProjectAssembly,
  parseProjectLearningDocuments,
} from '@/shared/domain';

import {
  FIREBASE_EMULATOR_CONFIG,
  getFirebaseEmulatorClients,
  usesFirebaseEmulators,
} from './firebaseClient';
import {
  LEARNING_DOCUMENT_VERSION,
  createProjectRecord,
  decodeFirestoreRelationship,
  writeProjectDocumentBatches,
} from './projectDocuments';

export type StoredBinaryFormat = 'step' | 'glb' | 'usdz' | 'manifest';

export type StoredStorageObject = {
  readonly storagePath: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
};

export type EmulatorProbeStatus = {
  readonly firestoreReachable: boolean;
  readonly storageReachable: boolean;
};

const CONTENT_TYPES: Readonly<Record<StoredBinaryFormat, string>> = {
  step: 'application/step',
  glb: 'model/gltf-binary',
  usdz: 'model/vnd.usdz+zip',
  manifest: 'application/json',
};

const FIRESTORE_URL = `http://${FIREBASE_EMULATOR_CONFIG.firestoreHost}:${FIREBASE_EMULATOR_CONFIG.firestorePort}/`;
const EMULATOR_LEARNING_FIRESTORE_TIMEOUT_MS = 1200;
const CLOUD_LEARNING_FIRESTORE_TIMEOUT_MS = 5000;

async function withLearningFirestore<T>(
  operation: (firestore: Firestore) => Promise<T>,
): Promise<T | null> {
  if (globalThis.navigator?.onLine === false) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const isEmulator = usesFirebaseEmulators();
    if (isEmulator && !(await isPortReachable(FIRESTORE_URL, 150))) return null;
    const { firestore } = getFirebaseEmulatorClients();
    const timeoutMs = isEmulator
      ? EMULATOR_LEARNING_FIRESTORE_TIMEOUT_MS
      : CLOUD_LEARNING_FIRESTORE_TIMEOUT_MS;
    return await Promise.race([
      operation(firestore),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isPortReachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class FirebaseEmulatorRepository {
  private readonly documents = new Map<string, unknown>();
  private readonly projects = new Map<string, VerifiedProjectAssembly>();
  private readonly explanations = new Map<
    ProjectId,
    Map<ComponentId, ComponentExplanationRecord>
  >();
  private readonly storageObjects = new Map<string, StoredStorageObject>();

  async probeLiveEmulators(timeoutMs = 150): Promise<EmulatorProbeStatus> {
    const storageUrl = `http://${FIREBASE_EMULATOR_CONFIG.storageHost}:${FIREBASE_EMULATOR_CONFIG.storagePort}/`;
    const [firestoreReachable, storageReachable] = await Promise.all([
      isPortReachable(FIRESTORE_URL, timeoutMs),
      isPortReachable(storageUrl, timeoutMs),
    ]);
    return { firestoreReachable, storageReachable };
  }

  async saveProjectAssembly(
    assembly: VerifiedProjectAssembly,
    binaries?: Partial<Record<StoredBinaryFormat, Uint8Array>>,
    options?: {
      readonly allowUnverified?: boolean;
      readonly syncLiveEmulator?: boolean;
      readonly componentExplanations?: readonly ComponentExplanationRecord[];
      readonly syncLearningDocuments?: boolean;
    },
  ): Promise<void> {
    const allowed =
      isAllowedProjectAssembly(assembly) ||
      (options?.allowUnverified === true && canRenderAssembly(assembly));
    if (!allowed) {
      throw new Error(
        `Refusing to persist unverified or invalid assembly "${assembly.projectId}": ${assembly.validation.failures.join('; ')}`,
      );
    }

    const projectDocPath = `projects/${assembly.projectId}`;
    this.projects.set(assembly.projectId, assembly);
    this.documents.set(projectDocPath, createProjectRecord(assembly));

    for (const node of assembly.nodes) {
      this.documents.set(`${projectDocPath}/nodes/${node.id}`, node);
    }

    for (const relationship of assembly.relationships) {
      this.documents.set(`${projectDocPath}/relationships/${relationship.id}`, relationship);
    }

    for (const step of assembly.assemblySteps) {
      this.documents.set(`${projectDocPath}/steps/${step.id}`, step);
    }

    if (binaries !== undefined) {
      const formats: readonly StoredBinaryFormat[] = ['step', 'glb', 'usdz', 'manifest'];
      for (const format of formats) {
        const payload = binaries[format];
        if (payload === undefined) {
          continue;
        }
        const storagePath =
          format === 'manifest'
            ? `assemblies/${assembly.manifest.manifestHash}/manifest.json`
            : assembly.manifest.files[format].storagePath;
        const sha256 =
          format === 'manifest'
            ? assembly.manifest.manifestHash
            : assembly.manifest.files[format].sha256;
        this.storageObjects.set(storagePath, {
          storagePath,
          contentType: CONTENT_TYPES[format],
          sha256,
          sizeBytes: payload.byteLength,
          bytes: payload,
        });
      }
    }

    if (options?.componentExplanations !== undefined) {
      await this.saveComponentExplanations(assembly.projectId, options.componentExplanations);
    }
    if (options?.syncLiveEmulator === true && usesFirebaseEmulators()) {
      const probe = await this.probeLiveEmulators();
      if (probe.firestoreReachable || probe.storageReachable) {
        await this.flushToLiveEmulator(assembly, binaries, probe);
      }
    } else if (options?.syncLearningDocuments === true) {
      const explanations = options.componentExplanations ?? [];
      await withLearningFirestore((firestore) =>
        this.seedProjectLearningDocuments(firestore, assembly, explanations),
      );
    }
  }

  async saveComponentExplanations(
    projectId: ProjectId,
    records: readonly ComponentExplanationRecord[],
    options?: { readonly syncLiveEmulator?: boolean },
  ): Promise<void> {
    const explanations =
      this.explanations.get(projectId) ?? new Map<ComponentId, ComponentExplanationRecord>();
    for (const record of records) {
      explanations.set(record.componentId, record);
      this.documents.set(`projects/${projectId}/explanations/${record.componentId}`, record);
    }
    this.explanations.set(projectId, explanations);

    if (options?.syncLiveEmulator === true && usesFirebaseEmulators() && records.length > 0) {
      await withLearningFirestore((firestore) => {
        const batch = writeBatch(firestore);
        for (const record of records) {
          batch.set(
            doc(firestore, 'projects', projectId, 'explanations', record.componentId),
            record,
          );
        }
        return batch.commit();
      });
    }
  }

  readComponentExplanation(
    projectId: ProjectId,
    componentId: ComponentId,
  ): ComponentExplanationRecord | null {
    return this.explanations.get(projectId)?.get(componentId) ?? null;
  }

  readProjectNodes(projectId: ProjectId): readonly AssemblyNode[] {
    return this.projects.get(projectId)?.nodes ?? [];
  }

  readProjectRelationships(projectId: ProjectId): readonly ComponentRelationship[] {
    return this.projects.get(projectId)?.relationships ?? [];
  }

  readProjectSteps(projectId: ProjectId): readonly AssemblyInstructionStep[] {
    return this.projects.get(projectId)?.assemblySteps ?? [];
  }

  async tryFetchProjectLearningDocsFromFirestore(
    projectId: ProjectId,
    componentId: ComponentId,
  ): Promise<ProjectLearningDocuments | null> {
    return withLearningFirestore(async (firestore) => {
      const project = doc(firestore, 'projects', projectId);
      const [nodes, relationships, steps, explanation] = await Promise.all([
        getDocs(collection(project, 'nodes')),
        getDocs(collection(project, 'relationships')),
        getDocs(collection(project, 'steps')),
        getDoc(doc(project, 'explanations', componentId)),
      ]);
      if (
        [nodes, relationships, steps, explanation].some(
          ({ metadata }) => metadata.fromCache || metadata.hasPendingWrites,
        ) ||
        !explanation.exists()
      )
        return null;

      return parseProjectLearningDocuments({
        nodes: nodes.docs.map((snapshot) => snapshot.data()),
        relationships: relationships.docs.map((snapshot) =>
          decodeFirestoreRelationship(snapshot.data()),
        ),
        assemblySteps: steps.docs.map((snapshot) => snapshot.data()),
        explanations: [explanation.data()],
      });
    });
  }

  private async seedProjectLearningDocuments(
    firestore: Firestore,
    assembly: VerifiedProjectAssembly,
    explanations: readonly ComponentExplanationRecord[],
  ): Promise<void> {
    const snapshot = await getDoc(doc(firestore, 'projects', assembly.projectId));
    if (snapshot.get('learningDocumentVersion') === LEARNING_DOCUMENT_VERSION) return;
    if (!usesFirebaseEmulators()) return;

    await writeProjectDocumentBatches(assembly, explanations, (documents) => {
      const batch = writeBatch(firestore);
      for (const { path, data } of documents) {
        batch.set(doc(firestore, path), data, { merge: path === snapshot.ref.path });
      }
      return batch.commit();
    });
  }

  private async flushToLiveEmulator(
    assembly: VerifiedProjectAssembly,
    binaries: Partial<Record<StoredBinaryFormat, Uint8Array>> | undefined,
    probe: EmulatorProbeStatus,
  ): Promise<void> {
    const { firestore, storage } = getFirebaseEmulatorClients();
    if (probe.firestoreReachable) {
      const explanations = this.explanations.get(assembly.projectId)?.values() ?? [];
      await this.seedProjectLearningDocuments(firestore, assembly, [...explanations]);
    }
    if (probe.storageReachable && binaries !== undefined) {
      const formats: readonly StoredBinaryFormat[] = ['step', 'glb', 'usdz', 'manifest'];
      for (const format of formats) {
        const payload = binaries[format];
        if (payload === undefined) {
          continue;
        }
        const storagePath =
          format === 'manifest'
            ? `assemblies/${assembly.manifest.manifestHash}/manifest.json`
            : assembly.manifest.files[format].storagePath;
        await uploadBytes(ref(storage, storagePath), payload, {
          contentType: CONTENT_TYPES[format],
        });
      }
    }
  }

  getProjectAssembly(projectId: string): VerifiedProjectAssembly | null {
    return this.projects.get(projectId) ?? null;
  }

  findProjectByArchetype(archetypeId: string): VerifiedProjectAssembly | null {
    for (const project of this.projects.values()) {
      if (project.archetypeId === archetypeId) {
        return project;
      }
    }
    return null;
  }

  readDocument(docPath: string): unknown {
    return this.documents.get(docPath) ?? null;
  }

  listCollection(collectionPath: string): readonly unknown[] {
    const prefix = `${collectionPath}/`;
    const items: unknown[] = [];
    for (const [key, value] of this.documents.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      if (!rest.includes('/')) {
        items.push(value);
      }
    }
    return items;
  }

  readStorageObject(storagePath: string): StoredStorageObject | null {
    return this.storageObjects.get(storagePath) ?? null;
  }
}

export const defaultFirebaseEmulatorRepository = new FirebaseEmulatorRepository();
