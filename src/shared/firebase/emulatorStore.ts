import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';

import { canClassifyAsVerified, type VerifiedProjectAssembly } from '@/shared/domain';

import { FIREBASE_EMULATOR_CONFIG, getFirebaseEmulatorClients } from './firebaseClient';

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

async function isPortReachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'GET', signal: controller.signal });
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
  private readonly storageObjects = new Map<string, StoredStorageObject>();

  async probeLiveEmulators(timeoutMs = 150): Promise<EmulatorProbeStatus> {
    const firestoreUrl = `http://${FIREBASE_EMULATOR_CONFIG.firestoreHost}:${FIREBASE_EMULATOR_CONFIG.firestorePort}/`;
    const storageUrl = `http://${FIREBASE_EMULATOR_CONFIG.storageHost}:${FIREBASE_EMULATOR_CONFIG.storagePort}/`;
    const [firestoreReachable, storageReachable] = await Promise.all([
      isPortReachable(firestoreUrl, timeoutMs),
      isPortReachable(storageUrl, timeoutMs),
    ]);
    return { firestoreReachable, storageReachable };
  }

  async saveProjectAssembly(
    assembly: VerifiedProjectAssembly,
    binaries?: Partial<Record<StoredBinaryFormat, Uint8Array>>,
    options?: { readonly syncLiveEmulator?: boolean },
  ): Promise<void> {
    if (!canClassifyAsVerified(assembly.validation, assembly.verificationStatus)) {
      throw new Error(
        `Refusing to persist unverified or invalid assembly "${assembly.projectId}": ${assembly.validation.failures.join('; ')}`,
      );
    }

    const projectDocPath = `projects/${assembly.projectId}`;
    this.projects.set(assembly.projectId, assembly);
    this.documents.set(projectDocPath, {
      projectId: assembly.projectId,
      archetypeId: assembly.archetypeId,
      title: assembly.title,
      userPrompt: assembly.userPrompt,
      verificationStatus: assembly.verificationStatus,
      rootNodeId: assembly.rootNodeId,
      manifest: assembly.manifest,
      validation: assembly.validation,
      orchestration: assembly.orchestration,
    });

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

    if (options?.syncLiveEmulator === true) {
      const probe = await this.probeLiveEmulators();
      if (probe.firestoreReachable || probe.storageReachable) {
        await this.flushToLiveEmulator(assembly, binaries, probe);
      }
    }
  }

  private async flushToLiveEmulator(
    assembly: VerifiedProjectAssembly,
    binaries: Partial<Record<StoredBinaryFormat, Uint8Array>> | undefined,
    probe: EmulatorProbeStatus,
  ): Promise<void> {
    const { firestore, storage } = getFirebaseEmulatorClients();
    if (probe.firestoreReachable) {
      const projectDoc = this.documents.get(`projects/${assembly.projectId}`);
      await setDoc(doc(firestore, 'projects', assembly.projectId), { payload: projectDoc });
      for (const node of assembly.nodes) {
        await setDoc(doc(firestore, 'projects', assembly.projectId, 'nodes', node.id), node);
      }
      for (const relationship of assembly.relationships) {
        await setDoc(
          doc(firestore, 'projects', assembly.projectId, 'relationships', relationship.id),
          relationship,
        );
      }
      for (const step of assembly.assemblySteps) {
        await setDoc(doc(firestore, 'projects', assembly.projectId, 'steps', step.id), step);
      }
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
