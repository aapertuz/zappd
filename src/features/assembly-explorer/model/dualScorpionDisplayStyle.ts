import type { AssemblyNode, ComponentId, VerifiedProjectAssembly } from '@/shared/domain';

export type DualScorpionDisplayStyle = {
  readonly role: 'base' | 'left_arm' | 'right_arm' | 'joint' | 'gripper';
  readonly colorHex: string;
  readonly metalness: number;
  readonly roughness: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly envMapIntensity: number;
  readonly ior: number;
  readonly edgeColorHex: string;
  readonly edgeOpacity: number;
};

type DisplayStyleNode = Pick<AssemblyNode, 'id' | 'parentId'>;

type DisplayStyleAssembly = Pick<VerifiedProjectAssembly, 'archetypeId'> & {
  readonly nodes: readonly DisplayStyleNode[];
};

const DISPLAY_STYLES = {
  base: {
    role: 'base',
    colorHex: '#64748B',
    metalness: 0.02,
    roughness: 0.88,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.08,
    ior: 1.5,
    edgeColorHex: '#475569',
    edgeOpacity: 0.24,
  },
  left_arm: {
    role: 'left_arm',
    colorHex: '#60A5FA',
    metalness: 0.02,
    roughness: 0.88,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.08,
    ior: 1.5,
    edgeColorHex: '#3B82F6',
    edgeOpacity: 0.24,
  },
  right_arm: {
    role: 'right_arm',
    colorHex: '#2DD4BF',
    metalness: 0.02,
    roughness: 0.88,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.08,
    ior: 1.5,
    edgeColorHex: '#14B8A6',
    edgeOpacity: 0.24,
  },
  joint: {
    role: 'joint',
    colorHex: '#475569',
    metalness: 0.02,
    roughness: 0.88,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.08,
    ior: 1.5,
    edgeColorHex: '#334155',
    edgeOpacity: 0.24,
  },
  gripper: {
    role: 'gripper',
    colorHex: '#FBBF24',
    metalness: 0.02,
    roughness: 0.88,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.08,
    ior: 1.5,
    edgeColorHex: '#D97706',
    edgeOpacity: 0.24,
  },
} satisfies Readonly<Record<DualScorpionDisplayStyle['role'], DualScorpionDisplayStyle>>;

const DUAL_SCORPION_PART_PREFIX = 'dual_scorpion_part_';
const JOINT_HARDWARE_PATTERN =
  /(?:^|_)(?:motor_case|motor_mount|mount|holder|horn_drive|horn_opposite)(?:_|$)/;

function findAncestorRole(
  node: DisplayStyleNode,
  nodesById: ReadonlyMap<ComponentId, DisplayStyleNode>,
): DualScorpionDisplayStyle['role'] | null {
  let cursor: DisplayStyleNode | undefined = node;
  while (cursor !== undefined) {
    if (cursor.id === 'dual_scorpion_left_arm') return 'left_arm';
    if (cursor.id === 'dual_scorpion_right_arm') return 'right_arm';
    if (cursor.id === 'dual_scorpion_base_link') return 'base';
    cursor = cursor.parentId === null ? undefined : nodesById.get(cursor.parentId);
  }
  return null;
}

function resolveRole(
  node: DisplayStyleNode,
  nodesById: ReadonlyMap<ComponentId, DisplayStyleNode>,
): DualScorpionDisplayStyle['role'] | null {
  if (!node.id.startsWith(DUAL_SCORPION_PART_PREFIX)) {
    return findAncestorRole(node, nodesById);
  }

  const sourcePartId = node.id.slice(DUAL_SCORPION_PART_PREFIX.length);
  if (/^joint8_ee_[lr]$/.test(sourcePartId)) return 'gripper';
  if (JOINT_HARDWARE_PATTERN.test(sourcePartId)) return 'joint';
  return findAncestorRole(node, nodesById);
}

export function resolveDualScorpionDisplayStyles(
  assembly: DisplayStyleAssembly,
): ReadonlyMap<ComponentId, DualScorpionDisplayStyle> {
  const styles = new Map<ComponentId, DualScorpionDisplayStyle>();
  if (assembly.archetypeId !== 'dual_scorpion_v1') return styles;

  const nodesById = new Map(assembly.nodes.map((node) => [node.id, node]));
  for (const node of assembly.nodes) {
    const role = resolveRole(node, nodesById);
    if (role !== null) styles.set(node.id, DISPLAY_STYLES[role]);
  }
  return styles;
}
