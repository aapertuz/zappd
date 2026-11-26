import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';

import { type App } from 'firebase-admin/app';
import { type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import {
  type AssemblyAssetManifest,
  type AssetChecksum,
  type VerificationStatus,
  type VerifiedProjectAssembly,
  isAllowedProjectAssembly,
  isAssetChecksum,
  isVerificationStatus,
} from '@/shared/domain';
import {
  DEFAULT_FIREBASE_PROJECT,
  buildFirebaseStorageMediaUrl,
} from '@/shared/firebase/firebaseProject';
import {
  LEARNING_DOCUMENT_VERSION,
  writeProjectDocumentBatches,
} from '@/shared/firebase/projectDocuments';

import { buildGroundedComponentExplanation } from '@/features/learning/catalog';

import {
  type CadExportArtifacts,
  type InspectionReportName,
  assetFormats,
  usesContentAddressedUrls,
} from './cadExports';

const cloudCatalogFileNames = {
  step: 'model.step',
  glb: 'model.glb',
  usdz: 'model.usdz',
  manifest: 'manifest.json',
  pipelineResult: 'pipeline_result.json',
} as const;

const checksumSchema = z.custom<AssetChecksum>(isAssetChecksum);
const fileSchema = z.strictObject({
  storagePath: z.string().min(1),
  sha256: checksumSchema,
  sizeBytes: z.number().int().positive(),
});

export const cloudCatalogPointerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    archetypeId: z.string().regex(/^[a-z0-9_]+$/),
    manifestHash: checksumSchema,
    verificationStatus: z.custom<VerificationStatus>(isVerificationStatus),
    storagePrefix: z.string().min(1),
    publishedAtIso: z.iso.datetime(),
    files: z.strictObject({
      step: fileSchema,
      glb: fileSchema,
      usdz: fileSchema,
      manifest: fileSchema,
      pipelineResult: fileSchema,
    }),
  })
  .refine(
    ({ manifestHash, storagePrefix, files }) =>
      storagePrefix === `assemblies/${manifestHash}` &&
      Object.entries(cloudCatalogFileNames).every(([format, name]) =>
        Object.entries(files).some(
          ([key, file]) => key === format && file.storagePath === `${storagePrefix}/${name}`,
        ),
      ),
    { message: 'Catalog pointer uses non-canonical Storage paths' },
  );

export type CloudCatalogPointer = z.infer<typeof cloudCatalogPointerSchema>;

export function matchesCloudArtifactRecords(
  manifest: AssemblyAssetManifest,
  pointer: CloudCatalogPointer,
): boolean {
  return (
    manifest.manifestHash === pointer.manifestHash &&
    assetFormats.every((format) => {
      const exported = manifest.files[format];
      const published = pointer.files[format];
      return (
        exported.storagePath === published.storagePath &&
        exported.sha256 === published.sha256 &&
        exported.sizeBytes === published.sizeBytes
      );
    })
  );
}

export type FirebaseCloudConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly projectId: string; readonly storageBucket: string };

function readDotEnv(fileName: string): Readonly<Record<string, string | undefined>> {
  try {
    return parseEnv(readFileSync(path.join(process.cwd(), fileName), 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

export function resolveFirebaseCloudConfig(): FirebaseCloudConfig {
  if (
    process.env.ZAPPD_DISABLE_FIREBASE_CLOUD === '1' ||
    process.env.EXPO_PUBLIC_FIREBASE_USE_EMULATORS === '1'
  ) {
    return { enabled: false };
  }

  const local = readDotEnv('.env.local');
  const fallback = readDotEnv('.env');
  const readValue = (key: string) =>
    [process.env[key], local[key], fallback[key]].map((value) => value?.trim()).find(Boolean);
  if (readValue('EXPO_PUBLIC_FIREBASE_USE_EMULATORS') === '1') return { enabled: false };

  const projectId =
    readValue('EXPO_PUBLIC_FIREBASE_PROJECT_ID') ?? DEFAULT_FIREBASE_PROJECT.projectId;
  const storageBucket =
    readValue('EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET') ??
    (projectId === DEFAULT_FIREBASE_PROJECT.projectId
      ? DEFAULT_FIREBASE_PROJECT.storageBucket
      : undefined);
  return storageBucket ? { enabled: true, projectId, storageBucket } : { enabled: false };
}

const restFieldsSchema = z.record(z.string(), z.unknown());
const restValueSchema = z.union([
  z.strictObject({ nullValue: z.null() }),
  z.strictObject({ booleanValue: z.boolean() }),
  z.strictObject({
    integerValue: z
      .string()
      .regex(/^-?\d+$/)
      .transform(Number)
      .refine(Number.isSafeInteger),
  }),
  z.strictObject({ doubleValue: z.number() }),
  z.strictObject({ stringValue: z.string() }),
  z.strictObject({ timestampValue: z.string() }),
  z.strictObject({ mapValue: z.strictObject({ fields: restFieldsSchema.optional() }) }),
  z.strictObject({ arrayValue: z.strictObject({ values: z.array(z.unknown()).optional() }) }),
]);

function decodeFirestoreRestValue(raw: unknown): unknown {
  const value = restValueSchema.parse(raw);
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeFirestoreRestValue);
  if ('mapValue' in value) return decodeFirestoreRestFields(value.mapValue.fields ?? {});
  return Object.values(value)[0];
}

export function decodeFirestoreRestFields(raw: unknown): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(restFieldsSchema.parse(raw)).map(([key, value]) => [
      key,
      decodeFirestoreRestValue(value),
    ]),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function fetchCloudCatalogPayload(
  archetypeId: string,
  config?: FirebaseCloudConfig,
  {
    fetchImpl = fetch,
    firestoreBaseUrl = 'https://firestore.googleapis.com',
    storageBaseUrl,
  }: {
    readonly fetchImpl?: typeof fetch;
    readonly firestoreBaseUrl?: string;
    readonly storageBaseUrl?: string;
  } = {},
): Promise<{ readonly pointer: CloudCatalogPointer; readonly rawPipelineResult: unknown } | null> {
  try {
    const cloud = config ?? resolveFirebaseCloudConfig();
    if (!cloud.enabled) return null;
    const firestoreUrl = `${firestoreBaseUrl}/v1/projects/${encodeURIComponent(cloud.projectId)}/databases/(default)/documents/catalogAssemblies/${encodeURIComponent(archetypeId)}`;
    const response = await fetchImpl(firestoreUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const { fields } = z.object({ fields: restFieldsSchema }).parse(await response.json());
    const pointer = cloudCatalogPointerSchema.parse(decodeFirestoreRestFields(fields));
    if (pointer.archetypeId !== archetypeId) return null;
    const file = pointer.files.pipelineResult;
    const publicUrl = new URL(buildFirebaseStorageMediaUrl(cloud.storageBucket, file.storagePath));
    const storageUrl =
      storageBaseUrl === undefined
        ? publicUrl
        : new URL(publicUrl.pathname + publicUrl.search, storageBaseUrl);
    const asset = await fetchImpl(storageUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!asset.ok) return null;
    const bytes = Buffer.from(await asset.arrayBuffer());
    if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== file.sha256) return null;
    const rawPipelineResult: unknown = JSON.parse(bytes.toString('utf8'));
    return { pointer, rawPipelineResult };
  } catch {
    return null;
  }
}

type EnabledConfig = Extract<FirebaseCloudConfig, { readonly enabled: true }>;

const adminApps = new Map<string, Promise<App>>();
const configuredAdminStores = new WeakSet<Firestore>();

function requireCloudConfig(): EnabledConfig {
  const config = resolveFirebaseCloudConfig();
  if (!config.enabled)
    throw new Error('Firebase cloud publishing is disabled or missing a Storage bucket.');
  return config;
}

async function getAdminApp({ projectId, storageBucket }: EnabledConfig): Promise<App> {
  const name = `zappd-cloud:${projectId}/${storageBucket}`;
  const pending = adminApps.get(name);
  if (pending !== undefined) return pending;
  const app = import('firebase-admin/app').then(
    async ({ applicationDefault, getApps, initializeApp }) => {
      const existing = getApps().find((candidate) => candidate.name === name);
      if (existing !== undefined) return existing;
      const credential = applicationDefault();
      try {
        await credential.getAccessToken();
      } catch (error) {
        throw new Error(
          'Firebase Application Default Credentials are unavailable. Run gcloud auth application-default login or set GOOGLE_APPLICATION_CREDENTIALS.',
          { cause: error },
        );
      }
      return initializeApp({ projectId, storageBucket, credential }, name);
    },
  );
  adminApps.set(name, app);
  try {
    return await app;
  } catch (error) {
    adminApps.delete(name);
    throw error;
  }
}

export async function assertFirebaseCloudCredentials(): Promise<void> {
  await getAdminApp(requireCloudConfig());
}

const corsSchema = z.array(
  z.strictObject({
    origin: z.array(z.string()).min(1),
    method: z.array(z.enum(['GET', 'HEAD', 'OPTIONS'])).min(1),
    responseHeader: z.array(z.string()).min(1),
    maxAgeSeconds: z.number().int().nonnegative(),
  }),
);

async function getCloudBucket(app: App) {
  const { getStorage } = await import('firebase-admin/storage');
  return getStorage(app).bucket();
}

export async function configureStorageBucketCors(
  corsFilePath = path.resolve('storage.cors.json'),
): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(corsFilePath, 'utf8'));
  const cors = corsSchema.parse(raw).map((entry) => ({
    ...entry,
    method: entry.method.filter((method) => method !== 'OPTIONS'),
  }));
  const bucket = await getCloudBucket(await getAdminApp(requireCloudConfig()));
  const [metadata] = await bucket.getMetadata();
  const current = corsSchema.safeParse(metadata.cors);
  if (!current.success || !isDeepStrictEqual(current.data, cors)) {
    await bucket.setCorsConfiguration(cors);
  }
}

const immutableCacheControl = 'public, max-age=31536000, immutable';

function describeFile(storagePrefix: string, name: string, bytes: Uint8Array) {
  return fileSchema.parse({
    storagePath: `${storagePrefix}/${name}`,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  });
}

type PublishAssemblyInput = {
  readonly assembly: VerifiedProjectAssembly;
  readonly rawPipelineResult: Uint8Array;
  readonly artifacts: CadExportArtifacts;
  readonly optionalReports?: Partial<Record<InspectionReportName, Uint8Array>>;
  readonly updateCatalogPointer: boolean;
};

export async function publishAssemblyToFirebaseCloud({
  assembly,
  rawPipelineResult,
  artifacts,
  optionalReports = {},
  updateCatalogPointer,
}: PublishAssemblyInput): Promise<{
  readonly pointer: CloudCatalogPointer;
  readonly uploadedFiles: number;
  readonly skippedFiles: number;
  readonly firestoreDocsWritten: number;
}> {
  if (!isAllowedProjectAssembly(assembly) || !usesContentAddressedUrls(assembly)) {
    throw new Error(`Refusing to publish invalid cloud assembly ${assembly.archetypeId}`);
  }
  const { archetypeId, projectId, manifest, verificationStatus } = assembly;
  const { manifestHash } = manifest;
  const storagePrefix = `assemblies/${manifestHash}`;
  const pointer = cloudCatalogPointerSchema.parse({
    schemaVersion: 1,
    archetypeId,
    manifestHash,
    verificationStatus,
    storagePrefix,
    publishedAtIso: new Date().toISOString(),
    files: {
      step: describeFile(storagePrefix, cloudCatalogFileNames.step, artifacts.step),
      glb: describeFile(storagePrefix, cloudCatalogFileNames.glb, artifacts.glb),
      usdz: describeFile(storagePrefix, cloudCatalogFileNames.usdz, artifacts.usdz),
      manifest: describeFile(storagePrefix, cloudCatalogFileNames.manifest, artifacts.manifest),
      pipelineResult: describeFile(
        storagePrefix,
        cloudCatalogFileNames.pipelineResult,
        rawPipelineResult,
      ),
    },
  });
  if (!matchesCloudArtifactRecords(manifest, pointer)) {
    throw new Error(`CAD artifact bytes do not match the manifest for ${archetypeId}`);
  }

  const files = [
    { file: pointer.files.step, bytes: artifacts.step, contentType: 'application/step' },
    { file: pointer.files.glb, bytes: artifacts.glb, contentType: 'model/gltf-binary' },
    { file: pointer.files.usdz, bytes: artifacts.usdz, contentType: 'model/vnd.usdz+zip' },
    { file: pointer.files.manifest, bytes: artifacts.manifest, contentType: 'application/json' },
    {
      file: pointer.files.pipelineResult,
      bytes: rawPipelineResult,
      contentType: 'application/json',
    },
    ...Object.entries(optionalReports).map(([name, bytes]) => ({
      file: describeFile(storagePrefix, name, bytes),
      bytes,
      contentType: 'application/json',
    })),
  ];
  const app = await getAdminApp(requireCloudConfig());
  const [bucket, { getFirestore }] = await Promise.all([
    getCloudBucket(app),
    import('firebase-admin/firestore'),
  ]);
  const firestore = getFirestore(app);
  if (!configuredAdminStores.has(firestore)) {
    firestore.settings({ ignoreUndefinedProperties: true });
    configuredAdminStores.add(firestore);
  }

  let uploadedFiles = 0;
  for (const { file, bytes, contentType } of files) {
    const object = bucket.file(file.storagePath);
    try {
      const [metadata] = await object.getMetadata();
      if (metadata.metadata?.sha256 === file.sha256) continue;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 404)) throw error;
    }
    await object.save(Buffer.from(bytes), {
      metadata: {
        contentType,
        cacheControl: immutableCacheControl,
        metadata: { sha256: file.sha256 },
      },
    });
    uploadedFiles += 1;
  }

  let firestoreDocsWritten = 0;
  const project = await firestore.doc(`projects/${projectId}`).get();
  if (project.get('learningDocumentVersion') !== LEARNING_DOCUMENT_VERSION) {
    const explanations = assembly.nodes.map((node) =>
      buildGroundedComponentExplanation(
        assembly,
        node,
        assembly.relationships,
        assembly.assemblySteps,
      ),
    );
    firestoreDocsWritten = await writeProjectDocumentBatches(
      assembly,
      explanations,
      async (documents) => {
        const batch = firestore.batch();
        for (const { path: documentPath, data } of documents) {
          batch.set(firestore.doc(documentPath), data);
        }
        await batch.commit();
      },
    );
  }
  if (updateCatalogPointer) {
    const reference = firestore.doc(`catalogAssemblies/${archetypeId}`);
    const previous = cloudCatalogPointerSchema.safeParse((await reference.get()).data());
    if (
      previous.success &&
      isDeepStrictEqual(previous.data, { ...pointer, publishedAtIso: previous.data.publishedAtIso })
    ) {
      return {
        pointer: previous.data,
        uploadedFiles,
        skippedFiles: files.length - uploadedFiles,
        firestoreDocsWritten,
      };
    }
    await reference.set(pointer);
    firestoreDocsWritten += 1;
  }

  return {
    pointer,
    uploadedFiles,
    skippedFiles: files.length - uploadedFiles,
    firestoreDocsWritten,
  };
}

type PublishAttempt =
  { readonly published: true } | { readonly published: false; readonly reason: string };

export async function tryPublishAssemblyToFirebaseCloud(
  args: PublishAssemblyInput,
): Promise<PublishAttempt> {
  try {
    if (!resolveFirebaseCloudConfig().enabled) {
      return { published: false, reason: 'Firebase cloud publishing is disabled.' };
    }
    await publishAssemblyToFirebaseCloud(args);
    return { published: true };
  } catch (error) {
    return {
      published: false,
      reason: error instanceof Error ? error.message : 'Firebase cloud publishing failed.',
    };
  }
}
