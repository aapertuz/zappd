import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  GEOMETRY_ORIGIN_POLICY,
  QUADCOPTER_ARCHETYPE,
  getAiProviderDescriptor,
  parseVerifiedProjectAssembly,
} from '@/shared/domain';

export const glbBytes = Buffer.from('glTF fixture');
const formats = ['step', 'glb', 'usdz'];
const checksum = createHash('sha256').update(glbBytes).digest('hex');

export const catalog = QUADCOPTER_ARCHETYPE;
const archetypeId = catalog.archetypeId;
const manifestHash = createHash('sha256')
  .update([archetypeId, ...formats.map(() => checksum)].join(':'))
  .digest('hex');
const storagePrefix = `assemblies/${manifestHash}`;
const date = '2026-11-26T00:00:00.000Z';
const nodes = catalog.nodes.map((node) => ({
  ...node,
  glbNodeName: node.id,
  usdzPrimPath: `/Assembly/${node.id}`,
  provenance: {
    origin: node.origin,
    verificationStatus: GEOMETRY_ORIGIN_POLICY[node.origin].targetVerifiedStatus,
    sourceUrl: node.sourceUrl,
    sourceName: node.sourceName,
    spdxLicense: node.spdxLicense,
    stepSha256: node.expectedStepSha256 ?? checksum,
  },
}));
const leafNodes = nodes.filter(({ level }) => level === 'component' || level === 'subcomponent');

export const pipeline = {
  archetypeId,
  verificationStatus: 'composed_validated',
  nodes,
  relationships: catalog.relationships,
  assemblySteps: catalog.assemblySteps,
  glbNodeIds: leafNodes.map(({ glbNodeName }) => glbNodeName),
  usdzPrimPaths: leafNodes.map(({ usdzPrimPath }) => usdzPrimPath),
  validation: {
    valid: true,
    brepValid: true,
    interferenceCount: 0,
    maxDimensionalErrorMm: 0,
    nodeMappingComplete: true,
    unitSystem: 'meters_y_up',
    checkedAtIso: date,
    failures: [],
    connectivityValid: true,
    electricalValid: true,
  },
  manifest: {
    archetypeId,
    manifestHash,
    generatedAtIso: date,
    files: Object.fromEntries(
      formats.map((format) => {
        const storagePath = `${storagePrefix}/model.${format}`;
        return [
          format,
          {
            storagePath,
            format,
            publicUrl: `/${storagePath}`,
            sha256: checksum,
            sizeBytes: glbBytes.length,
          },
        ];
      }),
    ),
  },
};

const provider = getAiProviderDescriptor('gemini');

export const assembly = parseVerifiedProjectAssembly({
  ...pipeline,
  projectId: `proj_${archetypeId}_${manifestHash.slice(0, 8)}`,
  title: catalog.title,
  userPrompt: catalog.title,
  rootNodeId: catalog.rootNodeId,
  orchestration: {
    provider: provider.provider,
    modelId: provider.modelId,
    apiFormat: provider.apiFormat,
    baseUrl: provider.defaultBaseUrl,
    executionMode: 'local_catalog_planner',
    plannedSubsystems: [],
  },
});

export function createPointer(result = pipeline) {
  const describeJsonFile = (fileName, data) => {
    const bytes = Buffer.from(JSON.stringify(data));
    return {
      storagePath: `${storagePrefix}/${fileName}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    };
  };
  return {
    schemaVersion: 1,
    archetypeId,
    manifestHash,
    storagePrefix,
    verificationStatus: result.verificationStatus,
    publishedAtIso: date,
    files: {
      ...Object.fromEntries(
        formats.map((format) => {
          const { format: _format, publicUrl: _url, ...file } = result.manifest.files[format];
          return [format, file];
        }),
      ),
      manifest: describeJsonFile('manifest.json', result.manifest),
      pipelineResult: describeJsonFile('pipeline_result.json', result),
    },
  };
}

export function encodeFirestoreFields(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, encodeFirestoreValue(value)]),
  );
}

function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFirestoreFields(value) } };
  if (typeof value === 'number')
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  throw new Error(`Cannot encode ${typeof value} as a Firestore value`);
}
