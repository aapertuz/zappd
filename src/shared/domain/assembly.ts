import { z } from 'zod';

import type { AiApiFormat, AiProviderId } from './aiProvider';

export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type ComponentId = string & { readonly __brand: 'ComponentId' };
export type PortId = string & { readonly __brand: 'PortId' };
export type MountingInterfaceId = string & { readonly __brand: 'MountingInterfaceId' };
export type ParameterName = string & { readonly __brand: 'ParameterName' };
export type RelationshipId = string & { readonly __brand: 'RelationshipId' };
export type AssemblyStepId = string & { readonly __brand: 'AssemblyStepId' };
export type AssetChecksum = string & { readonly __brand: 'AssetChecksum' };
export type CatalogArchetypeId = string & { readonly __brand: 'CatalogArchetypeId' };

export type Vector3Tuple = readonly [number, number, number];

export type VerificationStatus = 'sourced_verified' | 'composed_validated' | 'unverified';

export const GEOMETRY_ORIGINS = [
  'open_step_catalog',
  'cots_library_step',
  'kicad_pcb_step',
  'procedural_harness',
  'parametric_cad',
] as const;

export type GeometryOrigin = (typeof GEOMETRY_ORIGINS)[number];

export const GEOMETRY_ORIGIN_POLICY: Readonly<
  Record<
    GeometryOrigin,
    {
      readonly allowedUriPrefixes: readonly string[];
      readonly targetVerifiedStatus: Exclude<VerificationStatus, 'unverified'>;
    }
  >
> = {
  open_step_catalog: {
    allowedUriPrefixes: ['https://'],
    targetVerifiedStatus: 'sourced_verified',
  },
  cots_library_step: {
    allowedUriPrefixes: ['https://'],
    targetVerifiedStatus: 'sourced_verified',
  },
  kicad_pcb_step: {
    allowedUriPrefixes: ['https://', 'kicad://'],
    targetVerifiedStatus: 'composed_validated',
  },
  procedural_harness: {
    allowedUriPrefixes: ['https://', 'harness://'],
    targetVerifiedStatus: 'composed_validated',
  },
  parametric_cad: {
    allowedUriPrefixes: ['https://', 'parametric://'],
    targetVerifiedStatus: 'composed_validated',
  },
};

const hierarchyLevelSchema = z.enum(['project', 'subsystem', 'component', 'subcomponent']);
export type HierarchyLevel = z.infer<typeof hierarchyLevelSchema>;

export type ExplodeStageFilter = 'all' | 1 | 2 | 3;

export const ASSEMBLY_ENCLOSURE_ROLES = ['shell', 'internal'] as const;
export type AssemblyEnclosureRole = (typeof ASSEMBLY_ENCLOSURE_ROLES)[number];
export const assemblyEnclosureRoleSchema = z.enum(ASSEMBLY_ENCLOSURE_ROLES);

export const SHELL_PEEL_END_EXPLODE_FACTOR = 0.4;

const relationshipConnectionTypeSchema = z.enum([
  'assembly_mount',
  'rigid_fastener',
  'axial_mount',
  'electrical_bus',
  'power_bus',
  'revolute_joint',
]);
export type RelationshipConnectionType = z.infer<typeof relationshipConnectionTypeSchema>;

const electricalBusKindSchema = z.enum([
  'dc_power',
  'brushless_phase',
  'ttl_serial',
  'usb_data',
  'pwm_signal',
  'i2c_spi_uart',
  'can_bus',
  'analog_audio',
  'pdm_audio',
  'mipi_csi2',
]);
export type ElectricalBusKind = z.infer<typeof electricalBusKindSchema>;

const connectorPortRoleSchema = z.enum(['source', 'sink', 'bidirectional']);
export type ConnectorPortRole = z.infer<typeof connectorPortRoleSchema>;

export type ConnectorPort = {
  readonly portId: PortId;
  readonly label: string;
  readonly connectorType: string;
  readonly busKind: ElectricalBusKind;
  readonly localPositionMeters: Vector3Tuple;
  readonly exitDirection: Vector3Tuple;
  readonly wireGaugeAwg?: number;
  readonly wireColorsHex?: readonly string[];
  readonly nominalVoltageV?: number;
  readonly role?: ConnectorPortRole;
  readonly minVoltageV?: number;
  readonly maxVoltageV?: number;
  readonly maxCurrentA?: number;
  readonly compatibleBusKinds?: readonly ElectricalBusKind[];
};

const mountingInterfaceKindSchema = z.enum([
  'm2_standoff',
  'm2_5_standoff',
  'm3_standoff',
  'slot',
  'flange',
  'clamp',
]);
export type MountingInterfaceKind = z.infer<typeof mountingInterfaceKindSchema>;

export type MountingInterface = {
  readonly interfaceId: MountingInterfaceId;
  readonly label: string;
  readonly kind: MountingInterfaceKind;
  readonly holeDiameterMm: number;
  readonly boltPitchMm?: readonly [number, number];
  readonly localPositionMeters: Vector3Tuple;
  readonly normalDirection: Vector3Tuple;
};

const parameterUnitSchema = z.enum(['mm', 'deg', 'count']);
export type ParameterUnit = z.infer<typeof parameterUnitSchema>;
export type AssemblyParameter = Readonly<z.infer<typeof assemblyParameterSchema>>;

export type AssetFileFormat = 'step' | 'glb' | 'usdz';

export type CadProvenance = {
  readonly origin: GeometryOrigin;
  readonly verificationStatus: VerificationStatus;
  readonly spdxLicense: string;
  readonly sourceUrl: string;
  readonly sourceName: string;
  readonly stepSha256: AssetChecksum;
};

export type ComponentGeometry =
  | { readonly kind: 'assembly' }
  | { readonly kind: 'available'; readonly role: 'solid' | 'surface' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'visual_only';
      readonly cadRejectionReason: string;
      readonly sourceUrl: string;
      readonly archiveSha256: AssetChecksum;
      readonly memberPath: string;
      readonly sha256: AssetChecksum;
      readonly spdxLicense: string;
      readonly sourceOccurrencePath: string;
      readonly sourceCoordinateFrame: 'assembly_y_up_millimeters';
    };

export type AssemblyNode = {
  readonly geometry?: ComponentGeometry;
  readonly id: ComponentId;
  readonly parentId: ComponentId | null;
  readonly name: string;
  readonly level: HierarchyLevel;
  readonly depth: number;
  readonly category: string;
  readonly colorHex: string;
  readonly dimensionsMm: Vector3Tuple;
  readonly restPositionMeters: Vector3Tuple;
  readonly restRotationDeg?: Vector3Tuple;
  readonly explodeDirection: Vector3Tuple;
  readonly explodeDistanceMeters: number;
  readonly materialHint: string;
  readonly specifications: Readonly<Record<string, string | number | boolean>>;
  readonly ports?: readonly ConnectorPort[];
  readonly mountingInterfaces?: readonly MountingInterface[];
  readonly enclosureRole?: AssemblyEnclosureRole;
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
  readonly fromPortId?: PortId;
  readonly toPortId?: PortId;
  readonly routingStyle?: 'filleted_polyline';
  readonly routingWaypointsMeters?: readonly Vector3Tuple[];
  readonly wireBundleDiameterMm?: number;
};

export type AssemblyInstructionStep = {
  readonly id: AssemblyStepId;
  readonly order: number;
  readonly title: string;
  readonly summary: string;
  readonly componentIds: readonly ComponentId[];
  readonly relationshipIds: readonly RelationshipId[];
};

export const sourceInterferenceSchema = z
  .object({
    status: z.literal('partial'),
    solidCount: z.number().int().nonnegative(),
    possiblePairCount: z.number().int().nonnegative(),
    candidatePairCount: z.number().int().nonnegative(),
    intersectionCount: z.number().int().nonnegative(),
    unresolvedPairCount: z.number().int().nonnegative(),
    volumeThresholdMm3: z.number().nonnegative(),
    aabbToleranceMm: z.number().nonnegative(),
    excludedComponents: z.array(z.object({ componentId: z.string() })),
    pairs: z.array(
      z.discriminatedUnion('status', [
        z.object({
          componentIds: z.tuple([z.string(), z.string()]),
          status: z.literal('intersection'),
          volumeMm3: z.number().finite().nonnegative(),
          error: z.null(),
        }),
        z.object({
          componentIds: z.tuple([z.string(), z.string()]),
          status: z.literal('contact_or_below_threshold'),
          volumeMm3: z.number().finite().nonnegative(),
          error: z.null(),
        }),
        z.object({
          componentIds: z.tuple([z.string(), z.string()]),
          status: z.enum(['failed', 'timeout']),
          volumeMm3: z.null(),
          error: z.string().nullable(),
        }),
      ]),
    ),
    limitations: z.array(z.string()),
  })
  .refine(
    (report) =>
      report.pairs.length === report.candidatePairCount &&
      report.pairs.filter((pair) => pair.status === 'intersection').length ===
        report.intersectionCount &&
      report.pairs.filter((pair) => pair.status === 'failed' || pair.status === 'timeout')
        .length === report.unresolvedPairCount &&
      new Set(report.pairs.map((pair) => [...pair.componentIds].sort().join(':'))).size ===
        report.pairs.length,
    'Inconsistent source interference coverage',
  );

export const engineeringReportSchema = z.object({
  status: z.literal('unverified'),
  manufacturingReadiness: z.literal('not_established'),
  materials: z.literal('unknown'),
  manufacturingTolerances: z.literal('unknown'),
  loadsAndConstraints: z.literal('not_verified'),
  renderDimensionComparison: z.object({
    maximumErrorMm: z.number().finite().nonnegative(),
    thresholdMm: z.number().finite().nonnegative(),
    meaning: z.string(),
  }),
  nodeMappingComplete: z.boolean(),
  rejectedCadComponentIds: z.array(z.string()),
  surfaceComponentIds: z.array(z.string()),
});

export type ValidationReport = {
  readonly sourceInterferenceReport?: z.infer<typeof sourceInterferenceSchema>;
  readonly engineeringReport?: z.infer<typeof engineeringReportSchema>;
  readonly valid: boolean;
  readonly brepValid: boolean;
  readonly interferenceCount: number;
  readonly maxDimensionalErrorMm: number;
  readonly nodeMappingComplete: boolean;
  readonly unitSystem: 'meters_y_up';
  readonly checkedAtIso: string;
  readonly failures: readonly string[];
  readonly connectivityValid?: boolean;
  readonly floatingComponentIds?: readonly ComponentId[];
  readonly electricalValid?: boolean;
  readonly electricalFailures?: readonly string[];
  readonly repairAttempts?: number;
  readonly visualRenderPaths?: readonly string[];
  readonly buildTimingMs?: {
    readonly totalMs: number;
    readonly cacheMode: 'cold_step' | 'xbf_disk' | 'warm_ram';
  };
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
  readonly parameters?: readonly AssemblyParameter[];
  readonly parameterValues?: Readonly<Record<string, number>>;
};

const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
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

export function isPortId(value: unknown): value is PortId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toPortId(value: string): PortId {
  if (isPortId(value)) {
    return value;
  }
  throw new Error(`Invalid PortId: ${value}`);
}

export function isMountingInterfaceId(value: unknown): value is MountingInterfaceId {
  return typeof value === 'string' && SAFE_SLUG_PATTERN.test(value);
}

export function toMountingInterfaceId(value: string): MountingInterfaceId {
  if (isMountingInterfaceId(value)) {
    return value;
  }
  throw new Error(`Invalid MountingInterfaceId: ${value}`);
}

export function isParameterName(value: unknown): value is ParameterName {
  return typeof value === 'string' && PARAMETER_NAME_PATTERN.test(value);
}

export function toParameterName(value: string): ParameterName {
  if (isParameterName(value)) {
    return value;
  }
  throw new Error(`Invalid ParameterName: ${value}`);
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
  return isVerifiedStatus(value) || value === 'unverified';
}

export function isVerifiedStatus(
  value: unknown,
): value is Exclude<VerificationStatus, 'unverified'> {
  return value === 'sourced_verified' || value === 'composed_validated';
}

export function isGeometryOrigin(value: unknown): value is GeometryOrigin {
  return GEOMETRY_ORIGINS.some((origin) => origin === value);
}

export function parseGeometryOrigin(value: unknown): GeometryOrigin {
  if (isGeometryOrigin(value)) {
    return value;
  }
  throw new Error(`Invalid GeometryOrigin: ${String(value)}`);
}

export function canClassifyAsVerified(
  report: ValidationReport,
  status: VerificationStatus,
): boolean {
  if (!isVerifiedStatus(status)) {
    return false;
  }
  return (
    report.valid &&
    report.brepValid &&
    report.interferenceCount === 0 &&
    report.maxDimensionalErrorMm <= 0.1 &&
    report.nodeMappingComplete &&
    report.failures.length === 0 &&
    report.connectivityValid !== false &&
    (report.floatingComponentIds?.length ?? 0) === 0 &&
    report.electricalValid !== false &&
    (report.electricalFailures?.length ?? 0) === 0
  );
}

export function hasVerifiedUpstreamProvenance(
  nodes: readonly AssemblyNode[],
  projectStatus?: VerificationStatus,
): boolean {
  if (nodes.length === 0) {
    return false;
  }
  let hasComposedNode = false;
  for (const node of nodes) {
    const { provenance, geometry } = node;
    if (geometry !== undefined) {
      const hasUnverifiableGeometry =
        geometry.kind === 'unavailable' ||
        geometry.kind === 'visual_only' ||
        (geometry.kind === 'available' && geometry.role === 'surface');
      const hasNonSolidLeafGeometry =
        (node.level === 'component' || node.level === 'subcomponent') &&
        (geometry.kind !== 'available' || geometry.role !== 'solid');
      if (hasUnverifiableGeometry || hasNonSolidLeafGeometry) {
        return false;
      }
    }
    if (!isGeometryOrigin(provenance.origin)) {
      return false;
    }
    const policy = GEOMETRY_ORIGIN_POLICY[provenance.origin];
    if (
      provenance.verificationStatus !== policy.targetVerifiedStatus ||
      !policy.allowedUriPrefixes.some((prefix) => provenance.sourceUrl.startsWith(prefix)) ||
      provenance.spdxLicense.trim().length === 0 ||
      !isAssetChecksum(provenance.stepSha256)
    ) {
      return false;
    }
    if (policy.targetVerifiedStatus === 'composed_validated') {
      hasComposedNode = true;
    }
  }
  if (projectStatus !== undefined) {
    const expectedProjectStatus = hasComposedNode ? 'composed_validated' : 'sourced_verified';
    return projectStatus === expectedProjectStatus;
  }
  return true;
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

export function clampAssemblyParameterValues(
  parameters: readonly AssemblyParameter[],
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    parameters.map(({ name, kind, value, min, max, step }) => {
      const override = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
      if (typeof override !== 'number' || !Number.isFinite(override)) {
        return [name, value];
      }
      const bounded = Math.min(max, Math.max(min, override));
      const snapped = min + Math.round((bounded - min) / step) * step;
      const clamped = Math.min(max, snapped);
      return [name, kind === 'int' ? Math.round(clamped) : clamped];
    }),
  );
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

export function isShellNode(node: Pick<AssemblyNode, 'enclosureRole'>): boolean {
  return node.enclosureRole === 'shell';
}

export function assemblyHasShellNodes(
  nodes: readonly Pick<AssemblyNode, 'enclosureRole'>[],
): boolean {
  return nodes.some(isShellNode);
}

export function computeNodeExplodeWeight(
  node: Pick<AssemblyNode, 'depth' | 'enclosureRole'>,
  explodeFactor: number,
  activeExplodeStage: ExplodeStageFilter,
  hasShellNodes: boolean,
): number {
  const { depth } = node;
  if (!hasShellNodes) {
    return computeExplodeStageWeight(depth, explodeFactor, activeExplodeStage);
  }

  const clamped = clampExplodeFactor(explodeFactor);
  if (clamped === 0 || depth <= 0) return 0;
  if (activeExplodeStage === 1 && depth > 1) return 0;
  if (activeExplodeStage === 2 && depth > 2) return 0;
  if (isShellNode(node)) {
    return Math.min(1, clamped / SHELL_PEEL_END_EXPLODE_FACTOR);
  }
  if (clamped <= SHELL_PEEL_END_EXPLODE_FACTOR) return 0;

  const internalFactor = clamped - SHELL_PEEL_END_EXPLODE_FACTOR;
  if (depth === 1) return Math.min(1, internalFactor / 0.35);
  if (depth === 2) return Math.min(1, internalFactor / 0.5);
  return Math.max(0, Math.min(1, (clamped - 0.55) / 0.45));
}

export function computeNodeWorldPositionMeters(
  node: AssemblyNode,
  nodesById: Readonly<Record<string, AssemblyNode>>,
  explodeFactor: number,
  separatedOffsets: Readonly<Record<string, Vector3Tuple>>,
  activeExplodeStage: ExplodeStageFilter = 'all',
): Vector3Tuple {
  const hasShellNodes = assemblyHasShellNodes(Object.values(nodesById));
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
    const weight = computeNodeExplodeWeight(
      ancestor,
      explodeFactor,
      activeExplodeStage,
      hasShellNodes,
    );
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
  options?: { readonly allowUnavailableNodes?: boolean },
): boolean {
  const allowUnavailableNodes = options?.allowUnavailableNodes === true;
  const leafNodes = nodes.filter(
    (node) =>
      (node.level === 'component' || node.level === 'subcomponent') &&
      (!allowUnavailableNodes || node.geometry?.kind !== 'unavailable'),
  );
  if (leafNodes.length === 0) {
    return false;
  }
  const glbSet = new Set(glbNodeIds);
  const usdzSet = new Set(usdzPrimPaths);
  if (glbSet.size !== leafNodes.length || usdzSet.size !== leafNodes.length) return false;
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

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite number field "${key}"`);
  }
  return value;
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

export function parseConnectionType(value: unknown): RelationshipConnectionType {
  return relationshipConnectionTypeSchema.parse(value);
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

const nonEmptyString = z.string().min(1);
const vector3TupleSchema = z.tuple([z.number(), z.number(), z.number()]);
const nonZeroVector3TupleSchema = vector3TupleSchema.refine(
  (vector) => vector.some((coordinate) => coordinate !== 0),
  'Expected non-zero direction',
);
const componentIdSchema = z.custom<ComponentId>(isComponentId);
const relationshipIdSchema = z.custom<RelationshipId>(isRelationshipId);
const portIdSchema = z.custom<PortId>(isPortId);
const parameterNameSchema = z.custom<ParameterName>(isParameterName);
const positiveNumber = z.number().positive();

export const connectorPortSchema = z
  .strictObject({
    portId: portIdSchema,
    label: z.string().refine((value) => value.trim().length > 0),
    connectorType: z.string().refine((value) => value.trim().length > 0),
    busKind: electricalBusKindSchema,
    localPositionMeters: vector3TupleSchema,
    exitDirection: nonZeroVector3TupleSchema,
    wireGaugeAwg: z.number().optional(),
    wireColorsHex: z.array(z.string().regex(/^#[a-f0-9]{6}$/i)).optional(),
    nominalVoltageV: z.number().optional(),
    role: connectorPortRoleSchema.optional(),
    minVoltageV: z.number().nonnegative().optional(),
    maxVoltageV: z.number().nonnegative().optional(),
    maxCurrentA: positiveNumber.optional(),
    compatibleBusKinds: z.array(electricalBusKindSchema).optional(),
  })
  .refine(
    ({ minVoltageV, maxVoltageV }) =>
      minVoltageV === undefined || maxVoltageV === undefined || minVoltageV <= maxVoltageV,
    { path: ['maxVoltageV'], message: 'Expected maxVoltageV to be at least minVoltageV' },
  );

export function parseConnectorPort(raw: unknown): ConnectorPort {
  return connectorPortSchema.parse(raw);
}

export const mountingInterfaceSchema = z.strictObject({
  interfaceId: z.custom<MountingInterfaceId>(isMountingInterfaceId),
  label: nonEmptyString,
  kind: mountingInterfaceKindSchema,
  holeDiameterMm: positiveNumber,
  boltPitchMm: z.tuple([positiveNumber, positiveNumber]).optional(),
  localPositionMeters: vector3TupleSchema,
  normalDirection: nonZeroVector3TupleSchema,
});

export function parseMountingInterface(raw: unknown): MountingInterface {
  return mountingInterfaceSchema.parse(raw);
}

export const assemblyParameterSchema = z
  .strictObject({
    name: parameterNameSchema,
    label: z.string().trim().min(1),
    kind: z.enum(['int', 'float']),
    defaultValue: z.number(),
    value: z.number(),
    min: z.number(),
    max: z.number(),
    step: positiveNumber,
    unit: parameterUnitSchema.optional(),
  })
  .refine(({ min, max }) => min < max, {
    path: ['max'],
    message: 'Expected max to be greater than min',
  })
  .refine(({ defaultValue, min, max }) => defaultValue >= min && defaultValue <= max, {
    path: ['defaultValue'],
    message: 'Expected defaultValue within the parameter range',
  })
  .refine(({ value, min, max }) => value >= min && value <= max, {
    path: ['value'],
    message: 'Expected value within the parameter range',
  })
  .refine(
    ({ kind, defaultValue, value, min, max, step }) =>
      kind === 'float' || [defaultValue, value, min, max, step].every(Number.isInteger),
    'Expected integer bounds, values, and step for an int parameter',
  );

export function parseAssemblyParameter(raw: unknown): AssemblyParameter {
  return assemblyParameterSchema.parse(raw);
}

const componentGeometrySchema: z.ZodType<ComponentGeometry> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('assembly') }),
  z.strictObject({ kind: z.literal('available'), role: z.enum(['solid', 'surface']) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: nonEmptyString }),
  z.strictObject({
    kind: z.literal('visual_only'),
    cadRejectionReason: nonEmptyString,
    sourceUrl: nonEmptyString.refine(
      (value) => value.startsWith('https://'),
      'Invalid visual source URL',
    ),
    archiveSha256: z.custom<AssetChecksum>(isAssetChecksum),
    memberPath: nonEmptyString,
    sha256: z.custom<AssetChecksum>(isAssetChecksum),
    spdxLicense: nonEmptyString,
    sourceOccurrencePath: nonEmptyString,
    sourceCoordinateFrame: z.literal('assembly_y_up_millimeters'),
  }),
]);

export function canInspectSourceAssembly(assembly: {
  readonly nodes: readonly AssemblyNode[];
  readonly validation: ValidationReport;
  readonly verificationStatus: string;
}): boolean {
  return (
    assembly.verificationStatus === 'unverified' &&
    assembly.validation.brepValid &&
    assembly.validation.nodeMappingComplete &&
    assembly.validation.sourceInterferenceReport !== undefined &&
    assembly.validation.engineeringReport !== undefined &&
    assembly.nodes.some((node) => node.geometry?.kind === 'available') &&
    assembly.nodes.every(
      (node) =>
        node.geometry !== undefined &&
        node.provenance.verificationStatus === 'unverified' &&
        node.provenance.origin === 'open_step_catalog' &&
        node.provenance.sourceUrl.startsWith('https://') &&
        isAssetChecksum(node.specifications.sourceSha256) &&
        isAssetChecksum(node.provenance.stepSha256),
    )
  );
}

export const assemblyNodeFieldsSchema = z.object({
  id: componentIdSchema,
  parentId: componentIdSchema.nullable(),
  name: nonEmptyString,
  level: hierarchyLevelSchema,
  depth: z.number(),
  category: nonEmptyString,
  colorHex: nonEmptyString,
  dimensionsMm: vector3TupleSchema,
  restPositionMeters: vector3TupleSchema,
  restRotationDeg: vector3TupleSchema.optional(),
  explodeDirection: vector3TupleSchema,
  explodeDistanceMeters: z.number(),
  materialHint: nonEmptyString,
  specifications: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  ports: z.array(connectorPortSchema).optional(),
  mountingInterfaces: z.array(mountingInterfaceSchema).optional(),
  enclosureRole: assemblyEnclosureRoleSchema.optional(),
  geometry: componentGeometrySchema.optional(),
});

const assemblyNodeSchema = assemblyNodeFieldsSchema.extend({
  provenance: z.unknown().transform(parseProvenance),
  glbNodeName: nonEmptyString,
  usdzPrimPath: nonEmptyString,
});

export function parseAssemblyNode(raw: unknown): AssemblyNode {
  return assemblyNodeSchema.parse(raw);
}

export const componentRelationshipSchema = z
  .object({
    id: relationshipIdSchema,
    fromComponentId: componentIdSchema,
    toComponentId: componentIdSchema,
    connectionType: relationshipConnectionTypeSchema,
    howConnected: nonEmptyString,
    whyConnected: nonEmptyString,
    fromPortId: portIdSchema.optional(),
    toPortId: portIdSchema.optional(),
    routingStyle: z.literal('filleted_polyline').optional(),
    routingWaypointsMeters: z.array(vector3TupleSchema).optional(),
    wireBundleDiameterMm: z.number().positive().optional(),
  })
  .refine(
    ({ fromPortId, toPortId }) => (fromPortId === undefined) === (toPortId === undefined),
    'Expected fromPortId and toPortId together',
  );

export function parseRelationship(raw: unknown): ComponentRelationship {
  return componentRelationshipSchema.parse(raw);
}

export const assemblyInstructionStepSchema = z.object({
  id: z.custom<AssemblyStepId>(isAssemblyStepId),
  order: z.number(),
  title: nonEmptyString,
  summary: nonEmptyString,
  componentIds: z.array(componentIdSchema),
  relationshipIds: z.array(relationshipIdSchema),
});

export function parseInstructionStep(raw: unknown): AssemblyInstructionStep {
  return assemblyInstructionStepSchema.parse(raw);
}

const validationReportSchema = z.object({
  sourceInterferenceReport: sourceInterferenceSchema.optional(),
  engineeringReport: engineeringReportSchema.optional(),
  valid: z.boolean(),
  brepValid: z.boolean(),
  interferenceCount: z.number(),
  maxDimensionalErrorMm: z.number(),
  nodeMappingComplete: z.boolean(),
  unitSystem: z.literal('meters_y_up'),
  checkedAtIso: nonEmptyString,
  failures: z.array(z.string()),
  connectivityValid: z.boolean().optional(),
  floatingComponentIds: z.array(componentIdSchema).optional(),
  electricalValid: z.boolean().optional(),
  electricalFailures: z.array(z.string()).optional(),
  repairAttempts: z.int().nonnegative().optional(),
  visualRenderPaths: z.array(nonEmptyString).optional(),
  buildTimingMs: z
    .strictObject({
      totalMs: z.number().nonnegative(),
      cacheMode: z.enum(['cold_step', 'xbf_disk', 'warm_ram']),
    })
    .optional(),
});

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

export function parseOrchestrationMetadata(raw: unknown): AiOrchestrationMetadata {
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

const assemblyParametersSchema = z.object({
  parameters: z.array(assemblyParameterSchema).optional(),
  parameterValues: z.record(parameterNameSchema, z.number()).optional(),
});

export function canRenderAssembly({
  nodes,
  validation,
  verificationStatus,
}: Pick<VerifiedProjectAssembly, 'nodes' | 'validation' | 'verificationStatus'>): boolean {
  return (
    verificationStatus === 'unverified' ||
    (canClassifyAsVerified(validation, verificationStatus) &&
      hasVerifiedUpstreamProvenance(nodes, verificationStatus))
  );
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
    validation: validationReportSchema.parse(raw.validation),
    orchestration: parseOrchestrationMetadata(raw.orchestration),
    ...assemblyParametersSchema.parse(raw),
  };
}
