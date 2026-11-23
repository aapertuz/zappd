import type { AiApiFormat, AiProviderId } from './aiProvider';

export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type ComponentId = string & { readonly __brand: 'ComponentId' };
export type RelationshipId = string & { readonly __brand: 'RelationshipId' };
export type AssemblyStepId = string & { readonly __brand: 'AssemblyStepId' };
export type AssetChecksum = string & { readonly __brand: 'AssetChecksum' };
export type CatalogArchetypeId = string & { readonly __brand: 'CatalogArchetypeId' };

export type Vector3Tuple = readonly [number, number, number];

export type VerificationStatus = 'sourced_verified' | 'unverified';

export type GeometryOrigin = 'open_step_catalog';

export type HierarchyLevel = 'project' | 'subsystem' | 'component' | 'subcomponent';

export type ExplodeStageFilter = 'all' | 1 | 2 | 3;

export type RelationshipConnectionType =
  'rigid_fastener' | 'axial_mount' | 'electrical_bus' | 'power_bus' | 'revolute_joint';

export type AssetFileFormat = 'step' | 'glb' | 'usdz';

export type CadProvenance = {
  readonly origin: GeometryOrigin;
  readonly verificationStatus: VerificationStatus;
  readonly spdxLicense: string;
  readonly sourceUrl: string;
  readonly sourceName: string;
  readonly stepSha256: AssetChecksum;
};

export type AssemblyNode = {
  readonly id: ComponentId;
  readonly parentId: ComponentId | null;
  readonly name: string;
  readonly level: HierarchyLevel;
  readonly depth: number;
  readonly category: string;
  readonly colorHex: string;
  readonly dimensionsMm: Vector3Tuple;
  readonly restPositionMeters: Vector3Tuple;
  readonly explodeDirection: Vector3Tuple;
  readonly explodeDistanceMeters: number;
  readonly materialHint: string;
  readonly specifications: Readonly<Record<string, string | number | boolean>>;
  readonly provenance: CadProvenance;
  readonly glbNodeName: string;
  readonly usdzPrimPath: string;
};

export type ComponentRelationship = {
  readonly id: RelationshipId;
  readonly fromComponentId: ComponentId;
  readonly toComponentId: ComponentId;
  readonly connectionType: RelationshipConnectionType;
  readonly howConnected: string;
  readonly whyConnected: string;
};

export type AssemblyInstructionStep = {
  readonly id: AssemblyStepId;
  readonly order: number;
  readonly title: string;
  readonly summary: string;
  readonly componentIds: readonly ComponentId[];
  readonly relationshipIds: readonly RelationshipId[];
};

export type ValidationReport = {
  readonly valid: boolean;
  readonly brepValid: boolean;
  readonly interferenceCount: number;
  readonly maxDimensionalErrorMm: number;
  readonly nodeMappingComplete: boolean;
  readonly unitSystem: 'meters_y_up';
  readonly checkedAtIso: string;
  readonly failures: readonly string[];
};

export type AssetFileRecord = {
  readonly format: AssetFileFormat;
  readonly storagePath: string;
  readonly publicUrl: string;
  readonly sha256: AssetChecksum;
  readonly sizeBytes: number;
};

export type AssemblyAssetManifest = {
  readonly manifestHash: AssetChecksum;
  readonly archetypeId: CatalogArchetypeId;
  readonly generatedAtIso: string;
  readonly files: Readonly<Record<AssetFileFormat, AssetFileRecord>>;
};

export type AiOrchestrationMetadata = {
  readonly provider: AiProviderId;
  readonly modelId: string;
  readonly apiFormat: AiApiFormat;
  readonly baseUrl: string;
  readonly executionMode: 'live_api' | 'local_catalog_planner';
  readonly plannedSubsystems: readonly string[];
};

export type VerifiedProjectAssembly = {
  readonly projectId: ProjectId;
  readonly archetypeId: CatalogArchetypeId;
  readonly title: string;
  readonly userPrompt: string;
  readonly verificationStatus: VerificationStatus;
  readonly rootNodeId: ComponentId;
  readonly nodes: readonly AssemblyNode[];
  readonly relationships: readonly ComponentRelationship[];
  readonly assemblySteps: readonly AssemblyInstructionStep[];
  readonly manifest: AssemblyAssetManifest;
  readonly validation: ValidationReport;
  readonly orchestration: AiOrchestrationMetadata;
};

const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export function isProjectId(value: unknown): value is ProjectId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toProjectId(value: string): ProjectId {
  if (isProjectId(value)) {
    return value;
  }
  throw new Error(`Invalid ProjectId: ${value}`);
}

export function isComponentId(value: unknown): value is ComponentId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toComponentId(value: string): ComponentId {
  if (isComponentId(value)) {
    return value;
  }
  throw new Error(`Invalid ComponentId: ${value}`);
}

export function isRelationshipId(value: unknown): value is RelationshipId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toRelationshipId(value: string): RelationshipId {
  if (isRelationshipId(value)) {
    return value;
  }
  throw new Error(`Invalid RelationshipId: ${value}`);
}

export function isAssemblyStepId(value: unknown): value is AssemblyStepId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toAssemblyStepId(value: string): AssemblyStepId {
  if (isAssemblyStepId(value)) {
    return value;
  }
  throw new Error(`Invalid AssemblyStepId: ${value}`);
}

export function isAssetChecksum(value: unknown): value is AssetChecksum {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export function toAssetChecksum(value: string): AssetChecksum {
  if (isAssetChecksum(value)) {
    return value;
  }
  throw new Error(`Invalid AssetChecksum: ${value}`);
}

export function isCatalogArchetypeId(value: unknown): value is CatalogArchetypeId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toCatalogArchetypeId(value: string): CatalogArchetypeId {
  if (isCatalogArchetypeId(value)) {
    return value;
  }
  throw new Error(`Invalid CatalogArchetypeId: ${value}`);
}

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return value === 'sourced_verified' || value === 'unverified';
}

export function canClassifyAsVerified(
  report: ValidationReport,
  status: VerificationStatus,
): boolean {
  if (status === 'unverified') {
    return false;
  }
  return (
    report.valid &&
    report.brepValid &&
    report.interferenceCount === 0 &&
    report.maxDimensionalErrorMm <= 0.1 &&
    report.nodeMappingComplete &&
    report.failures.length === 0
  );
}

export function hasVerifiedUpstreamProvenance(nodes: readonly AssemblyNode[]): boolean {
  if (nodes.length === 0) {
    return false;
  }
  return nodes.every(
    (node) =>
      node.provenance.origin === 'open_step_catalog' &&
      node.provenance.verificationStatus === 'sourced_verified' &&
      node.provenance.sourceUrl.startsWith('https://') &&
      node.provenance.spdxLicense.trim().length > 0 &&
      isAssetChecksum(node.provenance.stepSha256),
  );
}

export function clampExplodeFactor(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export function computeExplodeStageWeight(
  depth: number,
  explodeFactor: number,
  activeExplodeStage: ExplodeStageFilter,
): number {
  const clamped = clampExplodeFactor(explodeFactor);
  if (clamped === 0 || depth <= 0) {
    return 0;
  }
  if (activeExplodeStage === 1 && depth > 1) {
    return 0;
  }
  if (activeExplodeStage === 2 && depth > 2) {
    return 0;
  }
  if (depth === 1) {
    return Math.min(1, clamped / 0.45);
  }
  if (depth === 2) {
    return Math.max(0, Math.min(1, (clamped - 0.15) / 0.55));
  }
  return Math.max(0, Math.min(1, (clamped - 0.4) / 0.6));
}

export function computeNodeWorldPositionMeters(
  node: AssemblyNode,
  nodesById: Readonly<Record<string, AssemblyNode>>,
  explodeFactor: number,
  separatedOffsets: Readonly<Record<string, Vector3Tuple>>,
  activeExplodeStage: ExplodeStageFilter = 'all',
): Vector3Tuple {
  let x = node.restPositionMeters[0];
  let y = node.restPositionMeters[1];
  let z = node.restPositionMeters[2];

  const chain: AssemblyNode[] = [];
  const visited = new Set<string>();
  let cursor: AssemblyNode | undefined = node;
  while (cursor !== undefined && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentId !== null ? nodesById[cursor.parentId] : undefined;
  }

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const ancestor = chain[index];
    if (ancestor === undefined) {
      continue;
    }
    const weight = computeExplodeStageWeight(ancestor.depth, explodeFactor, activeExplodeStage);
    if (weight > 0 && ancestor.explodeDistanceMeters !== 0) {
      const distance = ancestor.explodeDistanceMeters * weight;
      x += ancestor.explodeDirection[0] * distance;
      y += ancestor.explodeDirection[1] * distance;
      z += ancestor.explodeDirection[2] * distance;
    }
    const userOffset = separatedOffsets[ancestor.id];
    if (userOffset !== undefined) {
      x += userOffset[0];
      y += userOffset[1];
      z += userOffset[2];
    }
  }

  return [x, y, z];
}

export function verifyOneToOneNodeMapping(
  nodes: readonly AssemblyNode[],
  glbNodeIds: readonly string[],
  usdzPrimPaths: readonly string[],
): boolean {
  const leafNodes = nodes.filter(
    (node) => node.level === 'component' || node.level === 'subcomponent',
  );
  if (leafNodes.length === 0) {
    return false;
  }
  const glbSet = new Set(glbNodeIds);
  const usdzSet = new Set(usdzPrimPaths);
  for (const node of leafNodes) {
    if (!glbSet.has(node.glbNodeName)) {
      return false;
    }
    if (!usdzSet.has(node.usdzPrimPath)) {
      return false;
    }
  }
  return true;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string field "${key}"`);
  }
  return value;
}

function readRequiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean field "${key}"`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite number field "${key}"`);
  }
  return value;
}

function readVector3Tuple(record: Record<string, unknown>, key: string): Vector3Tuple {
  const value = record[key];
  if (!isUnknownArray(value) || value.length !== 3) {
    throw new Error(`Expected 3-element vector array "${key}"`);
  }
  const x = value[0];
  const y = value[1];
  const z = value[2];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    throw new Error(`Expected finite numbers in vector "${key}"`);
  }
  return [x, y, z];
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!isUnknownArray(value)) {
    throw new Error(`Expected array field "${key}"`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`Expected string item in "${key}"`);
    }
    result.push(item);
  }
  return result;
}

function parseHierarchyLevel(value: unknown): HierarchyLevel {
  if (
    value === 'project' ||
    value === 'subsystem' ||
    value === 'component' ||
    value === 'subcomponent'
  ) {
    return value;
  }
  throw new Error(`Invalid HierarchyLevel: ${String(value)}`);
}

function parseGeometryOrigin(value: unknown): GeometryOrigin {
  if (value === 'open_step_catalog') {
    return value;
  }
  throw new Error(`Invalid GeometryOrigin: ${String(value)}`);
}

function parseConnectionType(value: unknown): RelationshipConnectionType {
  if (
    value === 'rigid_fastener' ||
    value === 'axial_mount' ||
    value === 'electrical_bus' ||
    value === 'power_bus' ||
    value === 'revolute_joint'
  ) {
    return value;
  }
  throw new Error(`Invalid RelationshipConnectionType: ${String(value)}`);
}

function parseProvenance(raw: unknown): CadProvenance {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected CadProvenance object');
  }
  const status = raw.verificationStatus;
  if (!isVerificationStatus(status)) {
    throw new Error(`Invalid verificationStatus: ${String(status)}`);
  }
  return {
    origin: parseGeometryOrigin(raw.origin),
    verificationStatus: status,
    spdxLicense: readRequiredString(raw, 'spdxLicense'),
    sourceUrl: readRequiredString(raw, 'sourceUrl'),
    sourceName: readRequiredString(raw, 'sourceName'),
    stepSha256: toAssetChecksum(readRequiredString(raw, 'stepSha256')),
  };
}

function parseSpecifications(raw: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected specifications object');
  }
  const parsed: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    ) {
      parsed[key] = value;
    } else {
      throw new Error(`Invalid specification value for "${key}"`);
    }
  }
  return parsed;
}

function parseAssemblyNode(raw: unknown): AssemblyNode {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected AssemblyNode object');
  }
  const rawParentId = raw.parentId;
  const parentId = rawParentId === null ? null : toComponentId(String(rawParentId));
  return {
    id: toComponentId(readRequiredString(raw, 'id')),
    parentId,
    name: readRequiredString(raw, 'name'),
    level: parseHierarchyLevel(raw.level),
    depth: readRequiredNumber(raw, 'depth'),
    category: readRequiredString(raw, 'category'),
    colorHex: readRequiredString(raw, 'colorHex'),
    dimensionsMm: readVector3Tuple(raw, 'dimensionsMm'),
    restPositionMeters: readVector3Tuple(raw, 'restPositionMeters'),
    explodeDirection: readVector3Tuple(raw, 'explodeDirection'),
    explodeDistanceMeters: readRequiredNumber(raw, 'explodeDistanceMeters'),
    materialHint: readRequiredString(raw, 'materialHint'),
    specifications: parseSpecifications(raw.specifications),
    provenance: parseProvenance(raw.provenance),
    glbNodeName: readRequiredString(raw, 'glbNodeName'),
    usdzPrimPath: readRequiredString(raw, 'usdzPrimPath'),
  };
}

function parseRelationship(raw: unknown): ComponentRelationship {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected ComponentRelationship object');
  }
  return {
    id: toRelationshipId(readRequiredString(raw, 'id')),
    fromComponentId: toComponentId(readRequiredString(raw, 'fromComponentId')),
    toComponentId: toComponentId(readRequiredString(raw, 'toComponentId')),
    connectionType: parseConnectionType(raw.connectionType),
    howConnected: readRequiredString(raw, 'howConnected'),
    whyConnected: readRequiredString(raw, 'whyConnected'),
  };
}

function parseInstructionStep(raw: unknown): AssemblyInstructionStep {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected AssemblyInstructionStep object');
  }
  const componentIds = readStringArray(raw, 'componentIds').map(toComponentId);
  const relationshipIds = readStringArray(raw, 'relationshipIds').map(toRelationshipId);
  return {
    id: toAssemblyStepId(readRequiredString(raw, 'id')),
    order: readRequiredNumber(raw, 'order'),
    title: readRequiredString(raw, 'title'),
    summary: readRequiredString(raw, 'summary'),
    componentIds,
    relationshipIds,
  };
}

function parseValidationReport(raw: unknown): ValidationReport {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected ValidationReport object');
  }
  if (raw.unitSystem !== 'meters_y_up') {
    throw new Error(`Invalid unitSystem: ${String(raw.unitSystem)}`);
  }
  return {
    valid: readRequiredBoolean(raw, 'valid'),
    brepValid: readRequiredBoolean(raw, 'brepValid'),
    interferenceCount: readRequiredNumber(raw, 'interferenceCount'),
    maxDimensionalErrorMm: readRequiredNumber(raw, 'maxDimensionalErrorMm'),
    nodeMappingComplete: readRequiredBoolean(raw, 'nodeMappingComplete'),
    unitSystem: 'meters_y_up',
    checkedAtIso: readRequiredString(raw, 'checkedAtIso'),
    failures: readStringArray(raw, 'failures'),
  };
}

function parseAssetFileRecord(raw: unknown, expectedFormat: AssetFileFormat): AssetFileRecord {
  if (!isObjectRecord(raw)) {
    throw new Error(`Expected AssetFileRecord object for ${expectedFormat}`);
  }
  if (raw.format !== expectedFormat) {
    throw new Error(`Mismatched asset format: expected ${expectedFormat}`);
  }
  return {
    format: expectedFormat,
    storagePath: readRequiredString(raw, 'storagePath'),
    publicUrl: readRequiredString(raw, 'publicUrl'),
    sha256: toAssetChecksum(readRequiredString(raw, 'sha256')),
    sizeBytes: readRequiredNumber(raw, 'sizeBytes'),
  };
}

function parseAssetManifest(raw: unknown): AssemblyAssetManifest {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected AssemblyAssetManifest object');
  }
  const filesRaw = raw.files;
  if (!isObjectRecord(filesRaw)) {
    throw new Error('Expected manifest.files object');
  }
  return {
    manifestHash: toAssetChecksum(readRequiredString(raw, 'manifestHash')),
    archetypeId: toCatalogArchetypeId(readRequiredString(raw, 'archetypeId')),
    generatedAtIso: readRequiredString(raw, 'generatedAtIso'),
    files: {
      step: parseAssetFileRecord(filesRaw.step, 'step'),
      glb: parseAssetFileRecord(filesRaw.glb, 'glb'),
      usdz: parseAssetFileRecord(filesRaw.usdz, 'usdz'),
    },
  };
}

function parseOrchestrationMetadata(raw: unknown): AiOrchestrationMetadata {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected AiOrchestrationMetadata object');
  }
  const provider = raw.provider;
  if (provider !== 'gemini' && provider !== 'openai' && provider !== 'deepseek') {
    throw new Error(`Invalid orchestration provider: ${String(provider)}`);
  }
  const apiFormat = raw.apiFormat;
  if (apiFormat !== 'google_genai' && apiFormat !== 'openai_compatible') {
    throw new Error(`Invalid orchestration apiFormat: ${String(apiFormat)}`);
  }
  const executionMode = raw.executionMode;
  if (executionMode !== 'live_api' && executionMode !== 'local_catalog_planner') {
    throw new Error(`Invalid executionMode: ${String(executionMode)}`);
  }
  return {
    provider,
    modelId: readRequiredString(raw, 'modelId'),
    apiFormat,
    baseUrl: readRequiredString(raw, 'baseUrl'),
    executionMode,
    plannedSubsystems: readStringArray(raw, 'plannedSubsystems'),
  };
}

export function parseVerifiedProjectAssembly(raw: unknown): VerifiedProjectAssembly {
  if (!isObjectRecord(raw)) {
    throw new Error('Expected VerifiedProjectAssembly object');
  }
  const status = raw.verificationStatus;
  if (!isVerificationStatus(status)) {
    throw new Error(`Invalid project verificationStatus: ${String(status)}`);
  }
  const rawNodes = raw.nodes;
  const rawRelationships = raw.relationships;
  const rawSteps = raw.assemblySteps;
  if (!isUnknownArray(rawNodes) || !isUnknownArray(rawRelationships) || !isUnknownArray(rawSteps)) {
    throw new Error('Expected array fields nodes, relationships, and assemblySteps');
  }
  return {
    projectId: toProjectId(readRequiredString(raw, 'projectId')),
    archetypeId: toCatalogArchetypeId(readRequiredString(raw, 'archetypeId')),
    title: readRequiredString(raw, 'title'),
    userPrompt: readRequiredString(raw, 'userPrompt'),
    verificationStatus: status,
    rootNodeId: toComponentId(readRequiredString(raw, 'rootNodeId')),
    nodes: rawNodes.map(parseAssemblyNode),
    relationships: rawRelationships.map(parseRelationship),
    assemblySteps: rawSteps.map(parseInstructionStep),
    manifest: parseAssetManifest(raw.manifest),
    validation: parseValidationReport(raw.validation),
    orchestration: parseOrchestrationMetadata(raw.orchestration),
  };
}
