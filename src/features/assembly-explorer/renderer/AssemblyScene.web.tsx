import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  type ComponentId,
  type ExplodeStageFilter,
  type Vector3Tuple,
  isComponentId,
} from '@/shared/domain';

import {
  LearningCallouts,
  type LearningCalloutsHandle,
  type LearningCalloutPlacement,
  type PartAnchors,
} from '@/features/learning';

import classes from './AssemblyScene.web.module.css';
import {
  type AnimatedNodePose,
  type AssemblyAnimationController,
  type AssemblyAnimationTargets,
  type AssemblyFrameSnapshot,
  type NodeAssemblyWindow,
  createAssemblyAnimationController,
  settleAssemblyPlayback,
} from '../model/assemblyAnimation';
import {
  orbitExplorerCamera,
  reconcileCameraTarget,
  zoomExplorerCamera,
} from '../model/explorerState';
import type { AssemblySceneProps, ExplorerCameraState } from '../types';

type ScreenPoint = readonly [number, number];

type FocusedPartCallout = {
  readonly componentId: ComponentId;
  readonly name: string;
  readonly anchorPx: ScreenPoint;
  readonly labelPx: ScreenPoint;
};

declare global {
  interface Window {
    __zappdAssemblyDiagnostics?: {
      readonly projectId: string;
      readonly archetypeId: string;
      readonly title: string;
      readonly provider: string;
      readonly apiFormat: string;
      readonly verificationStatus: string;
      readonly validationPassed: boolean;
      readonly interferenceCount: number;
      readonly nodeCount: number;
      readonly glbNodeIds: readonly string[];
      readonly viewMode: AssemblySceneProps['state']['viewMode']['kind'];
      readonly focusedPartCallout: FocusedPartCallout | null;
      readonly nodeScreenPositions: Readonly<Record<string, ScreenPoint>>;
      readonly selectedComponentId: string | null;
      readonly isolatedComponentId: string | null;
      readonly explodeFactor: number;
      readonly activeExplodeStage: ExplodeStageFilter;
      readonly camera: AssemblySceneProps['state']['camera'];
      readonly separatedOffsets: Readonly<Record<string, Vector3Tuple>>;
      readonly nodePositionsMeters: Readonly<Record<string, Vector3Tuple>>;
      readonly webglActive: boolean;
      readonly animatedExplodeFactor: number;
      readonly assemblyStatus: AssemblyFrameSnapshot['assemblyStatus'];
      readonly assemblyProgress: number;
      readonly reactRenderCount: number;
      readonly framesRendered: number;
    };
  }
}

type PhysicalSurfaceProfile = {
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly envMapIntensity: number;
  readonly ior: number;
};

const SURFACE_PROFILES: Readonly<Record<string, PhysicalSurfaceProfile>> = {
  carbon_fiber: { clearcoat: 0.45, clearcoatRoughness: 0.25, envMapIntensity: 1.15, ior: 1.5 },
  carbon_fiber_composite: {
    clearcoat: 0.45,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1.15,
    ior: 1.5,
  },
  anodized_aluminum: {
    clearcoat: 0.15,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.35,
    ior: 1.5,
  },
  machined_aluminum: {
    clearcoat: 0.1,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.4,
    ior: 1.5,
  },
  brass: { clearcoat: 0.12, clearcoatRoughness: 0.16, envMapIntensity: 1.45, ior: 1.5 },
  polycarbonate: { clearcoat: 0.65, clearcoatRoughness: 0.14, envMapIntensity: 1.15, ior: 1.58 },
  fr4_pcb: { clearcoat: 0.28, clearcoatRoughness: 0.35, envMapIntensity: 0.95, ior: 1.5 },
  pla_3d_printed: { clearcoat: 0.14, clearcoatRoughness: 0.42, envMapIntensity: 0.9, ior: 1.46 },
  abs_3d_printed: { clearcoat: 0.16, clearcoatRoughness: 0.4, envMapIntensity: 0.95, ior: 1.52 },
  servo_housing: { clearcoat: 0.2, clearcoatRoughness: 0.36, envMapIntensity: 1.0, ior: 1.5 },
};

const DEFAULT_SURFACE_PROFILE: PhysicalSurfaceProfile = {
  clearcoat: 0.15,
  clearcoatRoughness: 0.35,
  envMapIntensity: 1.0,
  ior: 1.5,
};

function isThreeMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return 'isMesh' in obj && obj.isMesh === true;
}

function isThreeLine(obj: THREE.Object3D): obj is THREE.Line {
  return 'isLine' in obj && obj.isLine === true;
}

function readUserDataString(userData: unknown, key: string): string | null {
  if (typeof userData !== 'object' || userData === null) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(userData, key);
  const candidate: unknown = descriptor?.value;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function findAncestorUserDataString(obj: THREE.Object3D | null, key: string): string | null {
  let cursor: THREE.Object3D | null = obj;
  while (cursor !== null) {
    const candidate = readUserDataString(cursor.userData, key);
    if (candidate !== null) {
      return candidate;
    }
    cursor = cursor.parent;
  }
  return null;
}

function findAncestorComponentId(obj: THREE.Object3D | null): ComponentId | null {
  let cursor: THREE.Object3D | null = obj;
  while (cursor !== null) {
    const candidate = readUserDataString(cursor.userData, 'componentId');
    if (candidate !== null && isComponentId(candidate)) {
      return candidate;
    }
    cursor = cursor.parent;
  }
  return null;
}

function updateCameraFromSpherical(
  camera: THREE.PerspectiveCamera,
  stateCamera: AssemblySceneProps['state']['camera'],
): void {
  const azRad = (stateCamera.azimuthDeg * Math.PI) / 180;
  const elRad = (stateCamera.elevationDeg * Math.PI) / 180;
  const radius = stateCamera.distanceMeters;
  const [tx, ty, tz] = stateCamera.targetMeters;

  const cosEl = Math.cos(elRad);
  const x = tx + radius * cosEl * Math.sin(azRad);
  const y = ty + radius * Math.sin(elRad);
  const z = tz + radius * cosEl * Math.cos(azRad);

  camera.position.set(x, y, z);
  camera.lookAt(tx, ty, tz);
  camera.updateMatrixWorld();
}

function configureCameraViewport(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): void {
  camera.aspect = width / height;
  const portraitFov = THREE.MathUtils.radToDeg(
    2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(17)) / camera.aspect),
  );
  camera.fov = THREE.MathUtils.clamp(portraitFov, 40, 84);
  camera.updateProjectionMatrix();
}

function projectPart(
  part: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  { width, height }: DOMRectReadOnly,
  bounds: THREE.Box3,
  projection: THREE.Vector3,
): ScreenPoint | null {
  bounds.setFromObject(part);
  if (bounds.isEmpty()) return null;

  bounds.getCenter(projection).project(camera);
  const { x, y, z } = projection;
  if (!(Math.abs(x) <= 1 && Math.abs(y) <= 1 && Math.abs(z) <= 1)) return null;
  return [((x + 1) * width) / 2, ((1 - y) * height) / 2];
}

function sampleMeshScreenPoints(
  part: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  projection: THREE.Vector3,
): { readonly x: number; readonly y: number }[] {
  const points: { readonly x: number; readonly y: number }[] = [];
  const meshes: THREE.Mesh[] = [];
  part.traverse((obj) => {
    if (obj.visible && isThreeMesh(obj)) meshes.push(obj);
  });
  const totalVertices = meshes.reduce(
    (sum, mesh) => sum + (mesh.geometry.getAttribute('position')?.count ?? 0),
    0,
  );
  if (totalVertices === 0) return points;
  const stride = Math.max(1, Math.floor(totalVertices / 96));
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    if (position === undefined) continue;
    for (let index = 0; index < position.count; index += stride) {
      projection
        .set(position.getX(index), position.getY(index), position.getZ(index))
        .applyMatrix4(mesh.matrixWorld)
        .project(camera);
      if (Math.abs(projection.z) > 1) continue;
      if (projection.x < -1 || projection.x > 1 || projection.y < -1 || projection.y > 1) continue;
      points.push({
        x: ((projection.x + 1) * width) / 2,
        y: ((1 - projection.y) * height) / 2,
      });
    }
  }
  return points;
}

function insetAnchorTowardCenter(
  extreme: { readonly x: number; readonly y: number },
  center: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  return {
    x: extreme.x + (center.x - extreme.x) * 0.14,
    y: extreme.y + (center.y - extreme.y) * 0.14,
  };
}

function projectPartAnchors(
  part: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  { width, height }: DOMRectReadOnly,
  bounds: THREE.Box3,
  projection: THREE.Vector3,
): PartAnchors | null {
  bounds.setFromObject(part);
  if (bounds.isEmpty()) return null;

  bounds.getCenter(projection).project(camera);
  if (Math.abs(projection.z) > 1) return null;
  const center = {
    x: THREE.MathUtils.clamp(((projection.x + 1) * width) / 2, 0, width),
    y: THREE.MathUtils.clamp(((1 - projection.y) * height) / 2, 0, height),
  };

  const sampled = sampleMeshScreenPoints(part, camera, width, height, projection);
  if (sampled.length > 0) {
    const first = sampled[0];
    if (first !== undefined) {
      let left = first;
      let right = first;
      let top = first;
      let bottom = first;
      for (const point of sampled) {
        if (point.x < left.x) left = point;
        if (point.x > right.x) right = point;
        if (point.y < top.y) top = point;
        if (point.y > bottom.y) bottom = point;
      }
      return {
        center,
        left: insetAnchorTowardCenter(left, center),
        right: insetAnchorTowardCenter(right, center),
        top: insetAnchorTowardCenter(top, center),
        bottom: insetAnchorTowardCenter(bottom, center),
      };
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const { min, max } = bounds;
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        projection.set(x, y, z).project(camera);
        if (projection.z > 1) continue;
        minX = Math.min(minX, projection.x);
        maxX = Math.max(maxX, projection.x);
        minY = Math.min(minY, projection.y);
        maxY = Math.max(maxY, projection.y);
      }
    }
  }
  if (minX > 1 || maxX < -1 || minY > 1 || maxY < -1) return null;
  const projectX = (x: number) => ((THREE.MathUtils.clamp(x, -1, 1) + 1) * width) / 2;
  const projectY = (y: number) => ((1 - THREE.MathUtils.clamp(y, -1, 1)) * height) / 2;
  return {
    center,
    left: { x: projectX(minX), y: center.y },
    right: { x: projectX(maxX), y: center.y },
    top: { x: center.x, y: projectY(maxY) },
    bottom: { x: center.x, y: projectY(minY) },
  };
}

function updateFocusedCallout({
  overlay,
  label,
  leader,
  arrow,
  reticle,
  anchor,
  viewport,
}: {
  readonly overlay: HTMLDivElement | null;
  readonly label: HTMLDivElement | null;
  readonly leader: SVGPathElement | null;
  readonly arrow: SVGPathElement | null;
  readonly reticle: SVGGElement | null;
  readonly anchor: ScreenPoint | null;
  readonly viewport: DOMRectReadOnly;
}): LearningCalloutPlacement['rect'] | null {
  if (overlay === null || label === null || leader === null || arrow === null || reticle === null) {
    return null;
  }
  if (anchor === null) {
    overlay.style.visibility = 'hidden';
    return null;
  }

  const [anchorX, anchorY] = anchor;
  const labelWidth = label.offsetWidth;
  const labelHeight = label.offsetHeight;
  const placeOnRight = anchorX <= viewport.width / 2 + 4;
  const labelX = THREE.MathUtils.clamp(
    placeOnRight ? anchorX + 76 : anchorX - 76 - labelWidth,
    16,
    viewport.width - 16 - labelWidth,
  );
  const topSafeInset = viewport.width <= 800 ? 122 : 84;
  const bottomSafeY = Math.max(topSafeInset, viewport.height - 194 - labelHeight);
  const labelY = THREE.MathUtils.clamp(anchorY - 128, topSafeInset, bottomSafeY);

  const startX = placeOnRight ? labelX : labelX + labelWidth;
  const startY = labelY + labelHeight / 2;
  const directionX = anchorX - startX;
  const elbowX = startX + Math.sign(directionX) * Math.min(22, Math.abs(directionX) / 3);
  const remainingX = anchorX - elbowX;
  const remainingY = anchorY - startY;
  const remainingLength = Math.hypot(remainingX, remainingY);
  if (remainingLength < 18) {
    leader.setAttribute('d', '');
    arrow.setAttribute('d', '');
  } else {
    const unitX = remainingX / remainingLength;
    const unitY = remainingY / remainingLength;
    const tipX = anchorX - 10 * unitX;
    const tipY = anchorY - 10 * unitY;
    const baseX = tipX - 7 * unitX;
    const baseY = tipY - 7 * unitY;
    leader.setAttribute('d', `M ${startX} ${startY} H ${elbowX} L ${baseX} ${baseY}`);
    arrow.setAttribute(
      'd',
      `M ${tipX} ${tipY} L ${baseX - 3 * unitY} ${baseY + 3 * unitX} L ${baseX + 3 * unitY} ${baseY - 3 * unitX} Z`,
    );
  }
  reticle.setAttribute('transform', `translate(${anchorX} ${anchorY})`);
  label.style.transform = `translate(${labelX}px, ${labelY}px)`;
  overlay.style.visibility = 'visible';
  return { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
}

const HUD_ICON_PATHS = {
  back: 'm13 4-6 6 6 6M7 10h10',
  explode: 'M7.5 3.5h-4v4m9-4h4v4m0 5v4h-4m-5 0h-4v-4m0-9 4 4m9-4-4 4m4 9-4-4m-9 4 4-4',
  zoomIn: 'M14.5 14.5 18 18M6.5 9.5h6m-3-3v6M15.5 9.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  zoomOut: 'M14.5 14.5 18 18M6.5 9.5h6m3 0a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
};

function HudIcon({ kind }: { readonly kind: keyof typeof HUD_ICON_PATHS }) {
  return (
    <svg
      className={classes.hudIcon}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d={HUD_ICON_PATHS[kind]} />
    </svg>
  );
}

function resolveStudioFloorY(archetypeId: string): number {
  switch (archetypeId) {
    case 'robotic_arm_3dof_v1':
      return -0.002;
    case 'open_source_rover_v1':
      return -0.036;
    default:
      return -0.016;
  }
}

function disposeMeshOrLine(
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
): void {
  geometry.dispose();
  if (Array.isArray(material)) {
    for (const mat of material) {
      mat.dispose();
    }
  } else {
    material.dispose();
  }
}

function disposeObjectSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (isThreeMesh(obj)) {
      disposeMeshOrLine(obj.geometry, obj.material);
      return;
    }
    if (isThreeLine(obj)) {
      disposeMeshOrLine(obj.geometry, obj.material);
    }
  });
}

function buildPhysicalCadMaterial(
  baseMaterial: THREE.Material,
  materialHint: string,
): THREE.MeshPhysicalMaterial {
  const profile = SURFACE_PROFILES[materialHint] ?? DEFAULT_SURFACE_PROFILE;
  if (baseMaterial instanceof THREE.MeshStandardMaterial) {
    const upgraded = new THREE.MeshPhysicalMaterial({
      color: baseMaterial.color.clone(),
      metalness: baseMaterial.metalness,
      roughness: baseMaterial.roughness,
      clearcoat: profile.clearcoat,
      clearcoatRoughness: profile.clearcoatRoughness,
      envMapIntensity: profile.envMapIntensity,
      ior: profile.ior,
    });
    baseMaterial.dispose();
    return upgraded;
  }
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#71717a'),
    metalness: 0.35,
    roughness: 0.45,
    clearcoat: profile.clearcoat,
    clearcoatRoughness: profile.clearcoatRoughness,
    envMapIntensity: profile.envMapIntensity,
    ior: profile.ior,
  });
}

type MeshBinding = {
  readonly mesh: THREE.Mesh;
  readonly ownerId: ComponentId;
  readonly restScale: THREE.Vector3;
  edgeMaterial?: THREE.LineBasicMaterial;
};

type WebAssemblyModel = {
  readonly glbNodeIds: readonly string[];
  readonly objectsById: ReadonlyMap<ComponentId, THREE.Object3D>;
  readonly meshes: readonly MeshBinding[];
  readonly edgeQueue: readonly MeshBinding[];
  nextEdgeIndex: number;
  hasPainted: boolean;
  lastPoses: AssemblyFrameSnapshot['nodePoses'] | undefined;
  selectedComponentId: ComponentId | null;
};

type SceneRuntime = {
  readonly camera: THREE.PerspectiveCamera;
  readonly rootGroup: THREE.Group;
  readonly gridHelper: THREE.GridHelper;
  readonly shadowFloor: THREE.Mesh;
  readonly webglActive: boolean;
  readonly requestRender: () => void;
  model: WebAssemblyModel | null;
  shadowDirty: boolean;
};

type PointerDrag = {
  readonly id: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
};

function separateMeshFromPartAnchor(mesh: THREE.Mesh): THREE.Group {
  const anchor = new THREE.Group();
  anchor.position.copy(mesh.position);
  anchor.quaternion.copy(mesh.quaternion);
  anchor.scale.copy(mesh.scale);
  anchor.userData = mesh.userData;
  mesh.parent?.add(anchor);
  anchor.add(mesh);
  for (const child of [...mesh.children]) {
    anchor.add(child);
  }
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
  mesh.scale.set(1, 1, 1);
  return anchor;
}

function bindAssemblyModel(
  root: THREE.Group,
  schedule: readonly NodeAssemblyWindow[],
  buildEdges: boolean,
): WebAssemblyModel {
  const objectsById = new Map<ComponentId, THREE.Object3D>();
  const meshes: { readonly mesh: THREE.Mesh; readonly ownerId: ComponentId }[] = [];
  root.traverse((obj) => {
    const id = readUserDataString(obj.userData, 'componentId');
    if (isComponentId(id)) objectsById.set(id, obj);
    if (!isThreeMesh(obj)) return;
    const ownerId = findAncestorComponentId(obj);
    if (ownerId !== null) meshes.push({ mesh: obj, ownerId });
  });

  const bindings = meshes.map(({ mesh, ownerId }): MeshBinding => {
    const materialHint = findAncestorUserDataString(mesh, 'materialHint') ?? 'default';
    if (objectsById.get(ownerId) === mesh) {
      const anchor = separateMeshFromPartAnchor(mesh);
      objectsById.set(ownerId, anchor);
    }
    mesh.userData.componentId = ownerId;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => buildPhysicalCadMaterial(material, materialHint))
      : buildPhysicalCadMaterial(mesh.material, materialHint);
    mesh.receiveShadow = true;
    return { mesh, ownerId, restScale: mesh.scale.clone() };
  });

  const startTimes = new Map(schedule.map(({ nodeId, startSec }) => [nodeId, startSec]));
  return {
    glbNodeIds: [...objectsById.keys()],
    objectsById,
    meshes: bindings,
    edgeQueue: buildEdges
      ? [...bindings].sort(
          (a, b) =>
            (startTimes.get(a.ownerId) ?? Infinity) - (startTimes.get(b.ownerId) ?? Infinity),
        )
      : [],
    nextEdgeIndex: 0,
    hasPainted: false,
    lastPoses: undefined,
    selectedComponentId: null,
  };
}

function buildQueuedEdges(model: WebAssemblyModel): void {
  const deadline = performance.now() + 4;
  do {
    const binding = model.edgeQueue[model.nextEdgeIndex];
    if (binding === undefined) return;
    model.nextEdgeIndex += 1;
    const geometry = new THREE.EdgesGeometry(binding.mesh.geometry, 32);
    const selected = model.selectedComponentId === binding.ownerId;
    const material = new THREE.LineBasicMaterial({
      color: selected ? '#f5c451' : '#a8a29e',
      transparent: true,
      depthWrite: false,
      opacity: (selected ? 0.8 : 0.18) * (model.lastPoses?.[binding.ownerId]?.opacity ?? 1),
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.raycast = () => {};
    binding.mesh.add(lines);
    binding.edgeMaterial = material;
  } while (performance.now() < deadline);
}

function applyMeshPose(binding: MeshBinding, pose: AnimatedNodePose, isSelected: boolean): void {
  const { mesh, restScale, edgeMaterial } = binding;
  mesh.visible = pose.visible;
  mesh.castShadow = pose.visible && !pose.isAnimatingOpacity;
  mesh.scale.copy(restScale).multiplyScalar(pose.scale);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    if (material.transparent !== pose.isAnimatingOpacity) {
      material.transparent = pose.isAnimatingOpacity;
      material.depthWrite = !pose.isAnimatingOpacity;
      material.needsUpdate = true;
    }
    const opacity = pose.isAnimatingOpacity ? pose.opacity : 1;
    if (material.opacity !== opacity) material.opacity = opacity;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.emissive.setHex(isSelected ? 0xeab308 : 0x000000);
      material.emissiveIntensity = isSelected ? 0.26 : 0;
    }
  }
  if (edgeMaterial !== undefined) {
    edgeMaterial.color.set(isSelected ? '#f5c451' : '#a8a29e');
    edgeMaterial.opacity = (isSelected ? 0.8 : 0.18) * pose.opacity;
  }
}

function applyModelPoses(
  model: WebAssemblyModel,
  poses: AssemblyFrameSnapshot['nodePoses'],
  selectedComponentId: ComponentId | null,
): void {
  if (model.lastPoses !== poses) {
    for (const [id, object] of model.objectsById) {
      const pose = poses[id];
      if (pose !== undefined) object.position.set(...pose.localPositionMeters);
    }
  }
  if (model.lastPoses !== poses || model.selectedComponentId !== selectedComponentId) {
    for (const binding of model.meshes) {
      const pose = poses[binding.ownerId];
      if (pose !== undefined) applyMeshPose(binding, pose, selectedComponentId === binding.ownerId);
    }
  }
  model.lastPoses = poses;
  model.selectedComponentId = selectedComponentId;
}

export function AssemblyScene({
  assembly,
  glbArrayBuffer,
  state,
  onSetCamera,
  onSetExplodeFactor,
  onToggleExplodePreset,
  onFocusComponent,
  onExitPartFocus,
  learningState,
  onDismissLearningAnswer,
}: AssemblySceneProps) {
  const learningCalloutsRef = useRef<LearningCalloutsHandle>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGPathElement>(null);
  const arrowRef = useRef<SVGPathElement>(null);
  const reticleRef = useRef<SVGGElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const animationRef = useRef<AssemblyAnimationController | null>(null);
  const playbackInterruptedRef = useRef(false);
  const targetsRef = useRef<AssemblyAnimationTargets>(state);
  const leafPartIds = useMemo(() => {
    const parents = new Set(assembly.nodes.map(({ parentId }) => parentId));
    return assembly.nodes
      .filter(
        ({ id, level }) => !parents.has(id) && (level === 'component' || level === 'subcomponent'),
      )
      .map(({ id }) => id);
  }, [assembly.nodes]);
  const focusedId = state.viewMode.kind === 'part_focus' ? state.viewMode.componentId : null;
  const focusedNode =
    focusedId === null ? null : (assembly.nodes.find(({ id }) => id === focusedId) ?? null);
  const propsRef = useRef({
    assembly,
    glbArrayBuffer,
    state,
    leafPartIds,
    focusedNode,
    learningState,
  });
  const lastCommittedCameraRef = useRef<ExplorerCameraState | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const wheelCommitRef = useRef<number | null>(null);
  const reactRenderCount = useRef(0);
  const [webglActive, setWebglActive] = useState(true);
  const syncCamera = useCallback(() => {
    const { camera } = targetsRef.current;
    lastCommittedCameraRef.current = camera;
    onSetCamera(camera);
  }, [onSetCamera]);

  useLayoutEffect(() => {
    reactRenderCount.current += 1;
    const previous = propsRef.current;
    propsRef.current = { assembly, glbArrayBuffer, state, leafPartIds, focusedNode, learningState };
    const modelChanged =
      previous.assembly !== assembly || previous.glbArrayBuffer !== glbArrayBuffer;
    const { nextCamera, nextLastCommittedCamera, externalCameraChanged } = reconcileCameraTarget({
      previousStateCamera: previous.state.camera,
      stateCamera: state.camera,
      liveCamera: targetsRef.current.camera,
      lastCommittedCamera: lastCommittedCameraRef.current,
      modelChanged,
    });
    lastCommittedCameraRef.current = nextLastCommittedCamera;
    if (modelChanged) {
      playbackInterruptedRef.current = false;
      if (wheelCommitRef.current !== null) {
        window.clearTimeout(wheelCommitRef.current);
        wheelCommitRef.current = null;
      }
      dragRef.current = null;
    }
    targetsRef.current = {
      camera: nextCamera,
      explodeFactor: state.explodeFactor,
      activeExplodeStage: state.activeExplodeStage,
      isolatedComponentId: state.isolatedComponentId,
      focusedComponentId: focusedId,
      separatedOffsets: state.separatedOffsets,
    };

    if (
      modelChanged ||
      externalCameraChanged ||
      previous.state.explodeFactor !== state.explodeFactor ||
      previous.state.activeExplodeStage !== state.activeExplodeStage ||
      previous.state.selectedComponentId !== state.selectedComponentId ||
      previous.state.viewMode !== state.viewMode ||
      previous.state.isolatedComponentId !== state.isolatedComponentId ||
      previous.state.separatedOffsets !== state.separatedOffsets ||
      previous.state.selectedProvider !== state.selectedProvider ||
      previous.learningState !== learningState
    ) {
      runtimeRef.current?.requestRender();
    }
  });

  const interruptPlayback = useCallback(() => {
    playbackInterruptedRef.current = true;
    if (animationRef.current !== null) settleAssemblyPlayback(animationRef.current);
    runtimeRef.current?.requestRender();
  }, []);

  const exitPartFocus = useCallback(() => {
    interruptPlayback();
    onExitPartFocus();
  }, [interruptPlayback, onExitPartFocus]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        propsRef.current.state.viewMode.kind === 'part_focus'
      ) {
        exitPartFocus();
      }
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [exitPartFocus]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) {
      return;
    }

    const width = Math.max(mount.clientWidth, 1);
    const height = Math.max(mount.clientHeight, 1);
    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.008, 25);
    configureCameraViewport(camera, width, height);
    updateCameraFromSpherical(camera, targetsRef.current.camera);

    const hemiLight = new THREE.HemisphereLight('#fff8e7', '#1c1917', 0.88);
    const keyLight = new THREE.DirectionalLight('#fffcf5', 1.95);
    keyLight.position.set(0.8, 1.6, 1.1);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.2;
    keyLight.shadow.camera.far = 5.0;
    keyLight.shadow.camera.left = -0.35;
    keyLight.shadow.camera.right = 0.35;
    keyLight.shadow.camera.top = 0.35;
    keyLight.shadow.camera.bottom = -0.35;
    keyLight.shadow.bias = -0.0003;

    const fillLight = new THREE.DirectionalLight('#fef3c7', 0.55);
    fillLight.position.set(0.9, -0.4, -0.9);

    const rimLight = new THREE.DirectionalLight('#f5c451', 1.05);
    rimLight.position.set(-1, 0.85, -0.95);

    const gridHelper = new THREE.GridHelper(0.8, 16, '#5c4b27', '#262118');
    for (const material of [gridHelper.material].flat()) {
      material.transparent = true;
      material.opacity = 0.42;
      material.depthWrite = false;
    }

    const shadowPlaneGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.34 });
    const shadowFloor = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowFloor.rotation.x = -Math.PI / 2;
    shadowFloor.receiveShadow = true;

    const rootGroup = new THREE.Group();
    scene.add(hemiLight, keyLight, fillLight, rimLight, gridHelper, shadowFloor, rootGroup);

    let renderer: THREE.WebGLRenderer | null = null;
    let pmremGenerator: THREE.PMREMGenerator | null = null;
    let roomEnvironment: RoomEnvironment | null = null;
    let envRenderTarget: THREE.WebGLRenderTarget | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.18;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.shadowMap.autoUpdate = false;
      pmremGenerator = new THREE.PMREMGenerator(renderer);
      roomEnvironment = new RoomEnvironment();
      envRenderTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
      scene.environment = envRenderTarget.texture;
      mount.replaceChildren(renderer.domElement);
    } catch {
      renderer?.dispose();
      renderer = null;
      queueMicrotask(() => {
        if (!disposed) setWebglActive(false);
      });
    }

    let disposed = false;
    let frameId: number | null = null;
    let lastFrameTime: number | null = null;
    let framesRendered = 0;
    const partBounds = new THREE.Box3();
    const projectedPoint = new THREE.Vector3();
    let publishedDiagnostics: Window['__zappdAssemblyDiagnostics'];
    const runtime: SceneRuntime = {
      camera,
      rootGroup,
      gridHelper,
      shadowFloor,
      webglActive: renderer !== null,
      requestRender,
      model: null,
      shadowDirty: true,
    };
    runtimeRef.current = runtime;

    function requestRender(): void {
      if (!disposed && frameId === null) {
        frameId = window.requestAnimationFrame(renderFrame);
      }
    }

    const renderFrame = (now: number): void => {
      frameId = null;
      const dtSec = lastFrameTime === null ? 0 : (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      const { assembly, state, leafPartIds, focusedNode, learningState } = propsRef.current;
      const targets = targetsRef.current;
      const model = runtime.model;
      const snapshot = animationRef.current?.step(model?.hasPainted ? dtSec : 0, targets);
      if (model !== null && snapshot !== undefined) {
        if (model.hasPainted && model.nextEdgeIndex < model.edgeQueue.length)
          buildQueuedEdges(model);
        applyModelPoses(model, snapshot.nodePoses, state.selectedComponentId);
        if (!model.hasPainted || snapshot.cameraChanged) {
          updateCameraFromSpherical(camera, snapshot.animatedCamera);
        }
        model.hasPainted = true;
      } else {
        updateCameraFromSpherical(camera, targets.camera);
      }

      if (renderer !== null) {
        if (runtime.shadowDirty || snapshot?.geometryChanged) {
          renderer.shadowMap.needsUpdate = true;
          runtime.shadowDirty = false;
        }
        renderer.render(scene, camera);
        framesRendered += 1;
      }

      const nodePositionsMeters: Record<string, Vector3Tuple> = {};
      if (snapshot !== undefined) {
        for (const [id, pose] of Object.entries(snapshot.nodePoses)) {
          if (pose !== undefined) nodePositionsMeters[id] = pose.worldPositionMeters;
        }
      }
      const viewport = mount.getBoundingClientRect();
      const nodeScreenPositions: Record<string, ScreenPoint> = {};
      if (renderer !== null && model !== null && snapshot !== undefined) {
        for (const id of leafPartIds) {
          const part = model.objectsById.get(id);
          if (part === undefined || !snapshot.nodePoses[id]?.visible) continue;
          const point = projectPart(part, camera, viewport, partBounds, projectedPoint);
          if (point !== null) {
            nodeScreenPositions[id] = [viewport.left + point[0], viewport.top + point[1]];
          }
        }
      }

      const focusedPart =
        focusedNode !== null && snapshot?.nodePoses[focusedNode.id]?.visible
          ? model?.objectsById.get(focusedNode.id)
          : undefined;
      const anchor =
        renderer !== null && focusedPart !== undefined
          ? projectPart(focusedPart, camera, viewport, partBounds, projectedPoint)
          : null;
      const partLabelRect = updateFocusedCallout({
        overlay: calloutRef.current,
        label: labelRef.current,
        leader: leaderRef.current,
        arrow: arrowRef.current,
        reticle: reticleRef.current,
        anchor,
        viewport,
      });
      const explanationAnchors =
        renderer !== null &&
        focusedPart !== undefined &&
        learningState.explanation.kind !== 'idle' &&
        learningState.explanation.componentId === focusedNode?.id
          ? projectPartAnchors(focusedPart, camera, viewport, partBounds, projectedPoint)
          : null;
      const answerId =
        learningState.answer.kind === 'idle' ? null : learningState.answer.componentId;
      const answerPart =
        answerId === null || model === null || renderer === null
          ? undefined
          : answerId === assembly.rootNodeId && focusedNode === null
            ? rootGroup
            : snapshot?.nodePoses[answerId]?.visible
              ? model.objectsById.get(answerId)
              : undefined;
      const answerAnchors =
        answerPart === undefined
          ? null
          : answerPart === focusedPart && explanationAnchors !== null
            ? explanationAnchors
            : projectPartAnchors(answerPart, camera, viewport, partBounds, projectedPoint);

      learningCalloutsRef.current?.syncGeometry({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        partLabelRect,
        anchors: explanationAnchors,
        answerAnchors,
      });

      const focusedPartCallout =
        focusedNode !== null && anchor !== null && partLabelRect !== null
          ? {
              componentId: focusedNode.id,
              name: focusedNode.name,
              anchorPx: anchor,
              labelPx: [partLabelRect.x, partLabelRect.y] as const,
            }
          : null;

      publishedDiagnostics = {
        projectId: assembly.projectId,
        archetypeId: assembly.archetypeId,
        title: assembly.title,
        provider: state.selectedProvider,
        apiFormat: assembly.orchestration.apiFormat,
        verificationStatus: assembly.verificationStatus,
        validationPassed: assembly.validation.valid,
        interferenceCount: assembly.validation.interferenceCount,
        nodeCount: assembly.nodes.length,
        glbNodeIds: model?.glbNodeIds ?? [],
        viewMode: state.viewMode.kind,
        focusedPartCallout,
        nodeScreenPositions,
        selectedComponentId: state.selectedComponentId,
        isolatedComponentId: targets.isolatedComponentId,
        explodeFactor: targets.explodeFactor,
        activeExplodeStage: targets.activeExplodeStage,
        camera: targets.camera,
        separatedOffsets: targets.separatedOffsets,
        nodePositionsMeters,
        webglActive: runtime.webglActive,
        animatedExplodeFactor: snapshot?.animatedExplodeFactor ?? targets.explodeFactor,
        assemblyStatus: snapshot?.assemblyStatus ?? 'settled',
        assemblyProgress: snapshot?.assemblyProgress ?? 1,
        reactRenderCount: reactRenderCount.current,
        framesRendered,
      };
      window.__zappdAssemblyDiagnostics = publishedDiagnostics;

      if (snapshot?.isActive || (model !== null && model.nextEdgeIndex < model.edgeQueue.length)) {
        requestRender();
      } else {
        lastFrameTime = null;
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(mount.clientWidth, 1);
      const nextHeight = Math.max(mount.clientHeight, 1);
      configureCameraViewport(camera, nextWidth, nextHeight);
      renderer?.setSize(nextWidth, nextHeight);
      requestRender();
    });
    resizeObserver.observe(mount);
    requestRender();

    return () => {
      disposed = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      disposeObjectSubtree(rootGroup);
      rootGroup.clear();
      shadowPlaneGeo.dispose();
      shadowPlaneMat.dispose();
      gridHelper.dispose();
      keyLight.shadow.dispose();
      envRenderTarget?.dispose();
      roomEnvironment?.dispose();
      pmremGenerator?.dispose();
      renderer?.dispose();
      mount.replaceChildren();
      runtimeRef.current = null;
      if (window.__zappdAssemblyDiagnostics === publishedDiagnostics) {
        delete window.__zappdAssemblyDiagnostics;
      }
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime === null) return;
    const { rootGroup, gridHelper, shadowFloor } = runtime;
    const floorY = resolveStudioFloorY(assembly.archetypeId);
    gridHelper.position.y = floorY;
    shadowFloor.position.y = floorY + 0.0005;
    runtime.shadowDirty = true;
    runtime.requestRender();
    if (glbArrayBuffer === null) return;

    let cancelled = false;
    const loader = new GLTFLoader();
    loader.parse(
      glbArrayBuffer,
      '',
      (gltf) => {
        if (cancelled) {
          disposeObjectSubtree(gltf.scene);
          return;
        }
        const animation = createAssemblyAnimationController({
          assembly,
          targets: targetsRef.current,
          prefersReducedMotion:
            !runtime.webglActive || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        });
        if (playbackInterruptedRef.current) settleAssemblyPlayback(animation);
        animationRef.current = animation;
        runtime.model = bindAssemblyModel(gltf.scene, animation.schedule, runtime.webglActive);
        rootGroup.add(gltf.scene);
        runtime.shadowDirty = true;
        runtime.requestRender();
      },
      () => runtime.requestRender(),
    );

    return () => {
      cancelled = true;
      animationRef.current = null;
      runtime.model = null;
      disposeObjectSubtree(rootGroup);
      rootGroup.clear();
    };
  }, [assembly, glbArrayBuffer]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      targetsRef.current = {
        ...targetsRef.current,
        camera: zoomExplorerCamera(targetsRef.current.camera, event.deltaY * 0.0005),
      };
      runtimeRef.current?.requestRender();
      if (wheelCommitRef.current !== null) window.clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = window.setTimeout(() => {
        wheelCommitRef.current = null;
        syncCamera();
      }, 100);
    }

    mount.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      mount.removeEventListener('wheel', handleWheel);
      if (wheelCommitRef.current !== null) {
        window.clearTimeout(wheelCommitRef.current);
        wheelCommitRef.current = null;
      }
    };
  }, [syncCamera]);

  function setLiveCamera(camera: ExplorerCameraState) {
    targetsRef.current = { ...targetsRef.current, camera };
    runtimeRef.current?.requestRender();
  }

  function commitCamera(camera: ExplorerCameraState) {
    setLiveCamera(camera);
    syncCamera();
  }

  function changeExplodeFactor(explodeFactor: number) {
    targetsRef.current = { ...targetsRef.current, explodeFactor };
    interruptPlayback();
    onSetExplodeFactor(explodeFactor);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    const { clientX, clientY, pointerId } = event;
    dragRef.current = {
      id: pointerId,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.id !== event.pointerId) return;
    const { clientX, clientY } = event;
    drag.moved ||= Math.hypot(clientX - drag.startX, clientY - drag.startY) > 2;
    if (!drag.moved) return;
    setLiveCamera(
      orbitExplorerCamera(
        targetsRef.current.camera,
        (drag.lastX - clientX) * 0.5,
        (clientY - drag.lastY) * 0.4,
      ),
    );
    drag.lastX = clientX;
    drag.lastY = clientY;
  }

  function finishPointerDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.id !== event.pointerId) return null;
    dragRef.current = null;
    if (drag.moved) syncCamera();
    return drag;
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const drag = finishPointerDrag(event);
    if (drag === null || drag.moved || runtimeRef.current === null) return;

    const { camera, rootGroup } = runtimeRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hits = raycaster.intersectObjects(rootGroup.children, true);
    const hit = hits.find(({ object }) => object.visible && isThreeMesh(object));
    const componentId = hit === undefined ? null : findAncestorComponentId(hit.object);
    if (componentId === null) return;

    if (wheelCommitRef.current !== null) {
      window.clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = null;
      syncCamera();
    }
    interruptPlayback();
    onFocusComponent(componentId);
  }

  const explodePercent = Math.round(state.explodeFactor * 100);
  const sliderStyle: CSSProperties & { readonly '--explode-progress': string } = {
    '--explode-progress': `${state.explodeFactor * 100}%`,
  };

  return (
    <section className={classes.explorerRoot} aria-label="3D Assembly Explorer">
      <div
        ref={mountRef}
        className={classes.canvasMount}
        role="region"
        aria-label="Interactive 3D CAD Canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={finishPointerDrag}
        onLostPointerCapture={finishPointerDrag}
      />
      {!webglActive ? (
        <div className={classes.fallbackHint} role="status">
          3D rendering is unavailable in this browser.
        </div>
      ) : null}

      {focusedNode !== null ? (
        <div ref={calloutRef} className={classes.calloutOverlay}>
          <svg className={classes.calloutDrawing} width="100%" height="100%" aria-hidden="true">
            <path ref={leaderRef} className={classes.calloutLeader} />
            <path ref={arrowRef} className={classes.calloutArrow} />
            <g ref={reticleRef} className={classes.calloutReticle}>
              <circle r="7.5" />
              <circle r="3" />
              <circle r="1" fill="currentColor" />
            </g>
          </svg>
          <div
            ref={labelRef}
            className={classes.calloutLabel}
            role="status"
            aria-label="Focused component">
            <span className={classes.calloutEyebrow}>Part</span>
            <strong className={classes.calloutName}>{focusedNode.name}</strong>
          </div>
        </div>
      ) : null}

      <LearningCallouts
        ref={learningCalloutsRef}
        learningState={learningState}
        answeringInOverview={focusedId === null}
        onDismissAnswer={onDismissLearningAnswer}
      />

      {state.viewMode.kind === 'part_focus' ? (
        <button type="button" className={classes.backButton} onClick={exitPartFocus}>
          <HudIcon kind="back" />
          Back
        </button>
      ) : null}

      <div className={classes.hudBar} role="group" aria-label="Assembly controls">
        <button
          type="button"
          className={classes.explodeButton}
          aria-pressed={state.explodeFactor > 0.001}
          onClick={() => {
            interruptPlayback();
            onToggleExplodePreset();
          }}>
          <HudIcon kind="explode" />
          {`Explode (${explodePercent}%)`}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          aria-label="Explode factor"
          aria-valuetext={`${explodePercent}%`}
          className={classes.explodeSlider}
          style={sliderStyle}
          value={state.explodeFactor}
          onChange={(event) => changeExplodeFactor(event.currentTarget.valueAsNumber)}
        />
        <span className={classes.hudDivider} aria-hidden="true" />
        <button
          type="button"
          className={classes.zoomButton}
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => commitCamera(zoomExplorerCamera(targetsRef.current.camera, 0.07))}>
          <HudIcon kind="zoomOut" />
        </button>
        <button
          type="button"
          className={classes.zoomButton}
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => commitCamera(zoomExplorerCamera(targetsRef.current.camera, -0.07))}>
          <HudIcon kind="zoomIn" />
        </button>
      </div>
    </section>
  );
}
