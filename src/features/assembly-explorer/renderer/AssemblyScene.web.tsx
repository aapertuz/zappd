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
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  type ComponentId,
  type ExplodeStageFilter,
  type Vector3Tuple,
  isComponentId,
} from '@/shared/domain';

import {
  LearningCallouts,
  type CalloutRect,
  type LearningCalloutsHandle,
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
import { type CalloutAnchor, computePartCalloutRect } from '../model/calloutPlacement';
import {
  type AssemblyBoundingBoxMeters,
  computeAssemblyBoundingBoxMeters,
  computeCameraZoomLimits,
  computeCircuitComponentIds,
  computeFramedCameraForBoundingBox,
  DEFAULT_EXPLORER_CAMERA,
  orbitExplorerCamera,
  reconcileCameraTarget,
  zoomExplorerCamera,
} from '../model/explorerState';
import type { AssemblySceneProps, ExplorerCameraState, WiringVisibilityMode } from '../types';

type ScreenPoint = CalloutAnchor;

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
      readonly hoveredComponentId: ComponentId | null;
      readonly hoveredPartCallout: FocusedPartCallout | null;
      readonly nodeScreenPositions: Readonly<Record<string, ScreenPoint>>;
      readonly selectedComponentId: string | null;
      readonly isolatedComponentId: string | null;
      readonly explodeFactor: number;
      readonly activeExplodeStage: ExplodeStageFilter;
      readonly wiringVisibility: WiringVisibilityMode;
      readonly circuitHighlightIds: readonly ComponentId[];
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

const DEFAULT_SURFACE_PROFILE: PhysicalSurfaceProfile = {
  clearcoat: 0.12,
  clearcoatRoughness: 0.38,
  envMapIntensity: 1.0,
  ior: 1.5,
};
const CARBON_SURFACE_PROFILE: PhysicalSurfaceProfile = {
  clearcoat: 0.35,
  clearcoatRoughness: 0.28,
  envMapIntensity: 1.25,
  ior: 1.5,
};
const ANODIZED_SURFACE_PROFILE: PhysicalSurfaceProfile = {
  clearcoat: 0.14,
  clearcoatRoughness: 0.24,
  envMapIntensity: 1.35,
  ior: 1.5,
};
const PRINTED_SURFACE_PROFILE: PhysicalSurfaceProfile = {
  clearcoat: 0.08,
  clearcoatRoughness: 0.45,
  envMapIntensity: 0.95,
  ior: 1.5,
};
const SURFACE_PROFILES: Readonly<Partial<Record<string, PhysicalSurfaceProfile>>> = {
  carbon_fiber: CARBON_SURFACE_PROFILE,
  carbon_fiber_composite: CARBON_SURFACE_PROFILE,
  anodized_aluminum: ANODIZED_SURFACE_PROFILE,
  extruded_aluminum: ANODIZED_SURFACE_PROFILE,
  anodized_steel: ANODIZED_SURFACE_PROFILE,
  stainless_steel: ANODIZED_SURFACE_PROFILE,
  copper_winding: ANODIZED_SURFACE_PROFILE,
  machined_aluminum: {
    clearcoat: 0.1,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.45,
    ior: 1.5,
  },
  brass: { clearcoat: 0.14, clearcoatRoughness: 0.22, envMapIntensity: 1.45, ior: 1.5 },
  polycarbonate: { clearcoat: 0.25, clearcoatRoughness: 0.32, envMapIntensity: 1.1, ior: 1.58 },
  fr4_pcb: { clearcoat: 0.32, clearcoatRoughness: 0.28, envMapIntensity: 1.15, ior: 1.5 },
  silicone_wire: { clearcoat: 0.1, clearcoatRoughness: 0.4, envMapIntensity: 0.95, ior: 1.43 },
  braided_sleeve: { clearcoat: 0.04, clearcoatRoughness: 0.62, envMapIntensity: 0.85, ior: 1.5 },
  li_ion_battery: { clearcoat: 0.06, clearcoatRoughness: 0.52, envMapIntensity: 0.95, ior: 1.5 },
  pla_3d_printed: PRINTED_SURFACE_PROFILE,
  abs_3d_printed: PRINTED_SURFACE_PROFILE,
  acetal_polymer: DEFAULT_SURFACE_PROFILE,
  nylon_glass_filled: DEFAULT_SURFACE_PROFILE,
  servo_housing: { ...DEFAULT_SURFACE_PROFILE, envMapIntensity: 1.05 },
  optical_glass: { clearcoat: 0.45, clearcoatRoughness: 0.08, envMapIntensity: 1.15, ior: 1.5 },
};

const CAD_EDGE_COLOR = '#cbd5e1';
const CAD_EDGE_OPACITY = 0.11;
const HOVER_COLOR = '#f5c451';
const CIRCUIT_HIGHLIGHT_COLOR = '#38bdf8';
const EMPTY_CIRCUIT_IDS: ReadonlySet<ComponentId> = new Set();
const HSL_SCRATCH = { h: 0, s: 0, l: 0 };

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

function updatePartCallout({
  overlay,
  label,
  leader,
  arrow,
  reticle,
  anchor,
  viewport,
  obstacles,
}: {
  readonly overlay: HTMLDivElement | null;
  readonly label: HTMLDivElement | null;
  readonly leader: SVGPathElement | null;
  readonly arrow: SVGPathElement | null;
  readonly reticle: SVGGElement | null;
  readonly anchor: ScreenPoint | null;
  readonly viewport: DOMRectReadOnly;
  readonly obstacles: readonly CalloutRect[];
}): CalloutRect | null {
  if (overlay === null || label === null || leader === null || arrow === null || reticle === null) {
    return null;
  }
  const rect =
    anchor === null
      ? null
      : computePartCalloutRect({
          anchor,
          labelSize: { width: label.offsetWidth, height: label.offsetHeight },
          viewport,
          obstacles,
        });
  if (anchor === null || rect === null) {
    overlay.style.visibility = 'hidden';
    return null;
  }

  const [anchorX, anchorY] = anchor;
  const { x: labelX, y: labelY, width: labelWidth, height: labelHeight } = rect;
  const horizontal = anchorX < labelX || anchorX > labelX + labelWidth;
  const startX = horizontal
    ? anchorX < labelX
      ? labelX
      : labelX + labelWidth
    : labelX + labelWidth / 2;
  const startY = horizontal
    ? labelY + labelHeight / 2
    : anchorY < labelY
      ? labelY
      : labelY + labelHeight;
  const elbow = (start: number, end: number) =>
    start + Math.sign(end - start) * Math.min(22, Math.abs(end - start) / 3);
  const elbowX = horizontal ? elbow(startX, anchorX) : startX;
  const elbowY = horizontal ? startY : elbow(startY, anchorY);
  const remainingX = anchorX - elbowX;
  const remainingY = anchorY - elbowY;
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
    leader.setAttribute('d', `M ${startX} ${startY} L ${elbowX} ${elbowY} L ${baseX} ${baseY}`);
    arrow.setAttribute(
      'd',
      `M ${tipX} ${tipY} L ${baseX - 3 * unitY} ${baseY + 3 * unitX} L ${baseX + 3 * unitY} ${baseY - 3 * unitX} Z`,
    );
  }
  reticle.setAttribute('transform', `translate(${anchorX} ${anchorY})`);
  label.style.transform = `translate(${labelX}px, ${labelY}px)`;
  overlay.style.visibility = 'visible';
  return rect;
}

const HUD_ICON_PATHS = {
  back: 'm13 4-6 6 6 6M7 10h10',
  explode: 'M7.5 3.5h-4v4m9-4h4v4m0 5v4h-4m-5 0h-4v-4m0-9 4 4m9-4-4 4m4 9-4-4m-9 4 4-4',
  wiring: 'M6 14h3l2-8h3M6 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM18 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  zoomIn: 'M14.5 14.5 18 18M6.5 9.5h6m-3-3v6M15.5 9.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  zoomOut: 'M14.5 14.5 18 18M6.5 9.5h6m3 0a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
};

const WIRING_HUD_LABELS = {
  auto: { text: 'Wiring', label: 'Wiring visibility: Auto' },
  show: { text: 'Wiring on', label: 'Wiring visibility: Shown' },
  hide: { text: 'Wiring off', label: 'Wiring visibility: Hidden' },
} satisfies Record<WiringVisibilityMode, { readonly text: string; readonly label: string }>;

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

function materialTextures(material: THREE.Material): THREE.Texture[] {
  return Object.values(material).filter(
    (value): value is THREE.Texture => value instanceof THREE.Texture,
  );
}

function disposeObjectSubtree(root: THREE.Object3D, sharedEnvironment?: THREE.Texture): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();

  root.traverse((object) => {
    if (!isThreeMesh(object) && !isThreeLine(object)) return;
    geometries.add(object.geometry);
    for (const material of [object.material].flat()) materials.add(material);
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const texture of materialTextures(material)) {
      if (texture !== sharedEnvironment) textures.add(texture);
    }
    material.dispose();
  }
  for (const texture of textures) {
    const image: unknown = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) bitmaps.add(image);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
}

function buildPhysicalCadMaterial(
  baseMaterial: THREE.Material,
  materialHint: string,
  maxAnisotropy: number,
): THREE.MeshPhysicalMaterial {
  const profile = SURFACE_PROFILES[materialHint] ?? DEFAULT_SURFACE_PROFILE;
  const upgraded =
    baseMaterial instanceof THREE.MeshPhysicalMaterial
      ? baseMaterial.clone()
      : new THREE.MeshPhysicalMaterial({
          color: new THREE.Color('#71717a'),
          metalness: 0.35,
          roughness: 0.45,
          clearcoat: profile.clearcoat,
          clearcoatRoughness: profile.clearcoatRoughness,
        });

  if (
    baseMaterial instanceof THREE.MeshStandardMaterial &&
    !(baseMaterial instanceof THREE.MeshPhysicalMaterial)
  ) {
    upgraded.setValues({
      color: baseMaterial.color,
      metalness: baseMaterial.metalness,
      roughness: baseMaterial.roughness,
      map: baseMaterial.map,
      normalMap: baseMaterial.normalMap,
      normalMapType: baseMaterial.normalMapType,
      normalScale: baseMaterial.normalScale,
      roughnessMap: baseMaterial.roughnessMap,
      metalnessMap: baseMaterial.metalnessMap,
      aoMap: baseMaterial.aoMap,
      aoMapIntensity: baseMaterial.aoMapIntensity,
      emissiveMap: baseMaterial.emissiveMap,
      emissive: baseMaterial.emissive,
      emissiveIntensity: baseMaterial.emissiveIntensity,
      lightMap: baseMaterial.lightMap,
      lightMapIntensity: baseMaterial.lightMapIntensity,
      bumpMap: baseMaterial.bumpMap,
      bumpScale: baseMaterial.bumpScale,
      displacementMap: baseMaterial.displacementMap,
      displacementScale: baseMaterial.displacementScale,
      displacementBias: baseMaterial.displacementBias,
      alphaMap: baseMaterial.alphaMap,
      envMap: baseMaterial.envMap,
      envMapRotation: baseMaterial.envMapRotation,
      side: baseMaterial.side,
      vertexColors: baseMaterial.vertexColors,
      flatShading: baseMaterial.flatShading,
    });
  }

  upgraded.envMapIntensity = profile.envMapIntensity;
  upgraded.ior = profile.ior;
  for (const texture of materialTextures(upgraded)) {
    if (texture.anisotropy === maxAnisotropy) continue;
    texture.anisotropy = maxAnisotropy;
    texture.needsUpdate = true;
  }
  return upgraded;
}

function createStudioEnvironmentScene(): THREE.Scene {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color('#555961');
  const panelGeometry = new THREE.PlaneGeometry(1, 1);
  const softboxes = [
    { color: '#edf4ff', intensity: 2.3, width: 8, height: 5, position: [0, 5, -0.4] },
    { color: '#f8fafc', intensity: 2.2, width: 4.6, height: 5.5, position: [-3.9, 2.2, 4.5] },
    { color: '#fff0d7', intensity: 2.8, width: 1.8, height: 5.5, position: [3.3, 2.3, -4.1] },
    { color: '#b4c5df', intensity: 0.75, width: 3.4, height: 4.6, position: [4, 1.4, 2.5] },
    { color: '#95a6bf', intensity: 0.52, width: 3, height: 4, position: [-3.9, 0.8, -3.3] },
    { color: '#50483f', intensity: 0.62, width: 15, height: 15, position: [0, -4.5, 0] },
  ] satisfies readonly {
    color: string;
    intensity: number;
    width: number;
    height: number;
    position: Vector3Tuple;
  }[];

  for (const { color, intensity, width, height, position } of softboxes) {
    const radiance = new THREE.Color(color).multiplyScalar(intensity);
    const panel = new THREE.Mesh(panelGeometry, new THREE.MeshBasicMaterial({ color: radiance }));
    panel.position.set(...position);
    panel.scale.set(width, height, 1);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  }
  return studio;
}

type CadMaterialBinding = {
  readonly material: THREE.MeshPhysicalMaterial;
  readonly color: THREE.Color;
  readonly envMapIntensity: number;
  readonly emissive: THREE.Color;
  readonly emissiveIntensity: number;
};

type MeshBinding = {
  readonly mesh: THREE.Mesh;
  readonly ownerId: ComponentId;
  readonly restScale: THREE.Vector3;
  readonly materials: readonly CadMaterialBinding[];
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
  hoveredComponentId: ComponentId | null;
  circuitHighlightIds: ReadonlySet<ComponentId>;
};

type SceneRuntime = {
  readonly camera: THREE.PerspectiveCamera;
  readonly rootGroup: THREE.Group;
  readonly raycaster: THREE.Raycaster;
  readonly pointerNdc: THREE.Vector2;
  readonly pointerHits: THREE.Intersection[];
  readonly environmentMap: THREE.Texture | undefined;
  readonly webglActive: boolean;
  readonly maxAnisotropy: number;
  readonly requestRender: () => void;
  readonly configureStudio: (bounds: AssemblyBoundingBoxMeters) => void;
  readonly positionStudioFloor: (floorY: number) => void;
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

function pickComponent(
  runtime: SceneRuntime | null,
  { clientX, clientY, currentTarget }: PointerEvent<HTMLDivElement>,
): ComponentId | null {
  if (runtime?.model == null || !runtime.webglActive) return null;
  const { camera, rootGroup, raycaster, pointerNdc, pointerHits } = runtime;
  const { left, top, width, height } = currentTarget.getBoundingClientRect();
  if (width <= 0 || height <= 0) return null;
  pointerNdc.set(((clientX - left) / width) * 2 - 1, 1 - ((clientY - top) / height) * 2);
  raycaster.setFromCamera(pointerNdc, camera);
  raycaster.intersectObjects(rootGroup.children, true, pointerHits);
  let pickedId: ComponentId | null = null;
  for (const { object } of pointerHits) {
    if (!object.visible || !isThreeMesh(object)) continue;
    pickedId = findAncestorComponentId(object);
    if (pickedId !== null) break;
  }
  pointerHits.length = 0;
  return pickedId;
}

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
  maxAnisotropy: number,
  environmentMap: THREE.Texture | undefined,
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
    const hasMaterialGroups = Array.isArray(mesh.material);
    const upgraded = [mesh.material]
      .flat()
      .map((material) => buildPhysicalCadMaterial(material, materialHint, maxAnisotropy));
    if (environmentMap !== undefined) {
      for (const material of upgraded) material.envMap ??= environmentMap;
    }
    mesh.material = hasMaterialGroups ? upgraded : (upgraded[0] ?? mesh.material);
    mesh.receiveShadow = true;
    const materials = upgraded.map((material) => ({
      material,
      color: material.color.clone(),
      envMapIntensity: material.envMapIntensity,
      emissive: material.emissive.clone(),
      emissiveIntensity: material.emissiveIntensity,
    }));
    return { mesh, ownerId, restScale: mesh.scale.clone(), materials };
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
    hoveredComponentId: null,
    circuitHighlightIds: EMPTY_CIRCUIT_IDS,
  };
}

const EDGE_HIGHLIGHTS = {
  selected: { color: HOVER_COLOR, opacity: 0.8 },
  hovered: { color: HOVER_COLOR, opacity: 0.85 },
  circuit: { color: CIRCUIT_HIGHLIGHT_COLOR, opacity: 0.62 },
  dimmed: { color: CAD_EDGE_COLOR, opacity: CAD_EDGE_OPACITY * 0.55 },
  normal: { color: CAD_EDGE_COLOR, opacity: CAD_EDGE_OPACITY },
};

function getMeshHighlight(
  ownerId: ComponentId,
  selectedComponentId: ComponentId | null,
  hoveredComponentId: ComponentId | null,
  circuitHighlightIds: ReadonlySet<ComponentId>,
): keyof typeof EDGE_HIGHLIGHTS {
  if (selectedComponentId === ownerId) return 'selected';
  if (hoveredComponentId === ownerId) return 'hovered';
  if (circuitHighlightIds.has(ownerId)) return 'circuit';
  return hoveredComponentId !== null || circuitHighlightIds.size > 0 ? 'dimmed' : 'normal';
}

function buildQueuedEdges(model: WebAssemblyModel): void {
  const deadline = performance.now() + 4;
  do {
    const binding = model.edgeQueue[model.nextEdgeIndex];
    if (binding === undefined) return;
    model.nextEdgeIndex += 1;
    const geometry = new THREE.EdgesGeometry(binding.mesh.geometry, 32);
    const highlight = getMeshHighlight(
      binding.ownerId,
      model.selectedComponentId,
      model.hoveredComponentId,
      model.circuitHighlightIds,
    );
    const { color, opacity } = EDGE_HIGHLIGHTS[highlight];
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      depthWrite: false,
      opacity: opacity * (model.lastPoses?.[binding.ownerId]?.opacity ?? 1),
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.raycast = () => {};
    binding.mesh.add(lines);
    binding.edgeMaterial = material;
  } while (performance.now() < deadline);
}

function applyMeshPose(
  binding: MeshBinding,
  pose: AnimatedNodePose,
  selectedComponentId: ComponentId | null,
  hoveredComponentId: ComponentId | null,
  circuitHighlightIds: ReadonlySet<ComponentId>,
): void {
  const { mesh, ownerId, restScale, materials, edgeMaterial } = binding;
  const highlight = getMeshHighlight(
    ownerId,
    selectedComponentId,
    hoveredComponentId,
    circuitHighlightIds,
  );
  mesh.visible = pose.visible;
  mesh.castShadow = pose.visible && !pose.isAnimatingOpacity;
  mesh.scale.copy(restScale).multiplyScalar(pose.scale);
  for (const { material, color, envMapIntensity, emissive, emissiveIntensity } of materials) {
    if (material.transparent !== pose.isAnimatingOpacity) {
      material.transparent = pose.isAnimatingOpacity;
      material.needsUpdate = true;
    }
    material.depthWrite = !pose.isAnimatingOpacity;
    const opacity = pose.isAnimatingOpacity ? pose.opacity : 1;
    if (material.opacity !== opacity) material.opacity = opacity;
    if (highlight === 'dimmed') {
      const { h, s, l } = color.getHSL(HSL_SCRATCH);
      material.color.setHSL(h, s * 0.82, l * 0.8);
      material.envMapIntensity = envMapIntensity * 0.78;
    } else {
      material.color.copy(color);
      material.envMapIntensity = envMapIntensity;
    }
    if (highlight === 'hovered' || highlight === 'selected') {
      material.emissive.set(HOVER_COLOR);
      material.emissiveIntensity = 0.24;
    } else if (highlight === 'circuit') {
      material.emissive.set(CIRCUIT_HIGHLIGHT_COLOR);
      material.emissiveIntensity = 0.18;
    } else {
      material.emissive.copy(emissive);
      material.emissiveIntensity = emissiveIntensity;
    }
  }
  if (edgeMaterial !== undefined) {
    const { color, opacity } = EDGE_HIGHLIGHTS[highlight];
    edgeMaterial.color.set(color);
    edgeMaterial.opacity = opacity * pose.opacity;
  }
}

function applyModelPoses(
  model: WebAssemblyModel,
  poses: AssemblyFrameSnapshot['nodePoses'],
  selectedComponentId: ComponentId | null,
  hoveredComponentId: ComponentId | null,
  circuitHighlightIds: ReadonlySet<ComponentId>,
): void {
  if (model.lastPoses !== poses) {
    for (const [id, object] of model.objectsById) {
      const pose = poses[id];
      if (pose !== undefined) object.position.set(...pose.localPositionMeters);
    }
  }
  if (
    model.lastPoses !== poses ||
    model.selectedComponentId !== selectedComponentId ||
    model.hoveredComponentId !== hoveredComponentId ||
    model.circuitHighlightIds !== circuitHighlightIds
  ) {
    for (const binding of model.meshes) {
      const pose = poses[binding.ownerId];
      if (pose !== undefined) {
        applyMeshPose(binding, pose, selectedComponentId, hoveredComponentId, circuitHighlightIds);
      }
    }
  }
  model.lastPoses = poses;
  model.selectedComponentId = selectedComponentId;
  model.hoveredComponentId = hoveredComponentId;
  model.circuitHighlightIds = circuitHighlightIds;
}

export function AssemblyScene({
  assembly,
  glbArrayBuffer,
  state,
  onSetCamera,
  onSetExplodeFactor,
  onToggleExplodePreset,
  onCycleWiringVisibility,
  onFocusComponent,
  onExitPartFocus,
  learningState,
  onDismissLearningAnswer,
}: AssemblySceneProps) {
  const learningCalloutsRef = useRef<LearningCalloutsHandle>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const hudBarRef = useRef<HTMLDivElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGPathElement>(null);
  const arrowRef = useRef<SVGPathElement>(null);
  const reticleRef = useRef<SVGGElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const animationRef = useRef<AssemblyAnimationController | null>(null);
  const playbackInterruptedRef = useRef(false);
  const hoveredComponentIdRef = useRef<ComponentId | null>(null);
  const [hoveredComponentId, setHoveredComponentId] = useState<ComponentId | null>(null);
  const targetsRef = useRef<AssemblyAnimationTargets>(state);
  const cameraGeometry = useMemo(() => {
    const bounds = computeAssemblyBoundingBoxMeters(assembly);
    return {
      bounds,
      defaultDistance: computeFramedCameraForBoundingBox(bounds).distanceMeters,
      zoomLimits: computeCameraZoomLimits(assembly),
    };
  }, [assembly]);
  const leafPartIds = useMemo(() => {
    const parents = new Set(assembly.nodes.map(({ parentId }) => parentId));
    return assembly.nodes
      .filter(
        ({ id, level }) => !parents.has(id) && (level === 'component' || level === 'subcomponent'),
      )
      .map(({ id }) => id);
  }, [assembly.nodes]);
  const hasWiring = useMemo(
    () => assembly.nodes.some(({ category }) => category === 'wiring'),
    [assembly.nodes],
  );
  const focusedId = state.viewMode.kind === 'part_focus' ? state.viewMode.componentId : null;
  const activeCircuitId = focusedId ?? hoveredComponentId;
  const circuitHighlightIds = useMemo(() => {
    const ids = computeCircuitComponentIds(assembly, activeCircuitId);
    return ids.size === 0 ? EMPTY_CIRCUIT_IDS : ids;
  }, [assembly, activeCircuitId]);
  const focusedNode =
    focusedId === null ? null : (assembly.nodes.find(({ id }) => id === focusedId) ?? null);
  const hoveredNode =
    focusedId === null && hoveredComponentId !== null
      ? (assembly.nodes.find(({ id }) => id === hoveredComponentId) ?? null)
      : null;
  const calloutNode = focusedNode ?? hoveredNode;
  const propsRef = useRef({
    assembly,
    glbArrayBuffer,
    state,
    leafPartIds,
    focusedNode,
    calloutNode,
    learningState,
    cameraGeometry,
  });
  const lastCommittedCameraRef = useRef<ExplorerCameraState | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const wheelCommitRef = useRef<number | null>(null);
  const reactRenderCount = useRef(0);
  const [webglActive, setWebglActive] = useState(true);
  const updateHoveredComponent = useCallback((id: ComponentId | null) => {
    if (hoveredComponentIdRef.current === id) return;
    hoveredComponentIdRef.current = id;
    setHoveredComponentId(id);
    mountRef.current?.setAttribute('data-hovering', id === null ? 'false' : 'true');
    runtimeRef.current?.requestRender();
  }, []);
  const syncCamera = useCallback(() => {
    const { camera } = targetsRef.current;
    lastCommittedCameraRef.current = camera;
    onSetCamera(camera);
  }, [onSetCamera]);

  const zoomLiveCamera = useCallback((distanceFraction: number) => {
    const { cameraGeometry, focusedNode } = propsRef.current;
    const { camera } = targetsRef.current;
    const defaultDistance =
      focusedNode === null
        ? cameraGeometry.defaultDistance
        : Math.min(cameraGeometry.defaultDistance, camera.distanceMeters);
    const limits =
      focusedNode === null
        ? cameraGeometry.zoomLimits
        : {
            ...cameraGeometry.zoomLimits,
            minDistanceMeters: Math.min(
              cameraGeometry.zoomLimits.minDistanceMeters,
              (Math.max(1, ...focusedNode.dimensionsMm) * 0.15) / 1000,
            ),
          };
    targetsRef.current = {
      ...targetsRef.current,
      camera: zoomExplorerCamera(camera, defaultDistance * distanceFraction, limits),
    };
    runtimeRef.current?.requestRender();
  }, []);

  useLayoutEffect(() => {
    reactRenderCount.current += 1;
    const previous = propsRef.current;
    propsRef.current = {
      assembly,
      glbArrayBuffer,
      state,
      leafPartIds,
      focusedNode,
      calloutNode,
      learningState,
      cameraGeometry,
    };
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
    if (modelChanged || focusedId !== null || state.selectedComponentId !== null) {
      updateHoveredComponent(null);
    }
    const circuitChanged = targetsRef.current.circuitHighlightIds !== circuitHighlightIds;
    targetsRef.current = {
      camera: nextCamera,
      explodeFactor: state.explodeFactor,
      activeExplodeStage: state.activeExplodeStage,
      isolatedComponentId: state.isolatedComponentId,
      focusedComponentId: focusedId,
      separatedOffsets: state.separatedOffsets,
      wiringVisibility: state.wiringVisibility,
      circuitHighlightIds,
    };

    if (
      modelChanged ||
      externalCameraChanged ||
      circuitChanged ||
      previous.state.explodeFactor !== state.explodeFactor ||
      previous.state.activeExplodeStage !== state.activeExplodeStage ||
      previous.state.wiringVisibility !== state.wiringVisibility ||
      previous.state.selectedComponentId !== state.selectedComponentId ||
      previous.state.viewMode !== state.viewMode ||
      previous.state.isolatedComponentId !== state.isolatedComponentId ||
      previous.state.separatedOffsets !== state.separatedOffsets ||
      previous.state.selectedProvider !== state.selectedProvider ||
      previous.calloutNode !== calloutNode ||
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
    const composer = mount.closest('main')?.querySelector('textarea[aria-label="Prompt input"]');
    const composerForm = composer instanceof HTMLTextAreaElement ? composer.form : null;
    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.008, 25);
    configureCameraViewport(camera, width, height);
    updateCameraFromSpherical(camera, targetsRef.current.camera);

    const hemiLight = new THREE.HemisphereLight('#e6edf7', '#29241e', 0.65);
    const keyLight = new THREE.DirectionalLight('#f8fafc', 1.9);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.00015;
    keyLight.shadow.radius = 3;

    const fillLight = new THREE.DirectionalLight('#cbd5e1', 0.75);
    const rimLight = new THREE.DirectionalLight('#fde68a', 1.35);

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
    scene.add(
      hemiLight,
      keyLight,
      keyLight.target,
      fillLight,
      fillLight.target,
      rimLight,
      rimLight.target,
      gridHelper,
      shadowFloor,
      rootGroup,
    );

    function positionStudioFloor(floorY: number) {
      gridHelper.position.y = floorY;
      shadowFloor.position.y = floorY + 0.0005 * gridHelper.scale.y;
    }

    function configureStudio(bounds: AssemblyBoundingBoxMeters) {
      const [x, y, z] = bounds.center;
      const extent = Math.max(...bounds.size);
      const scale = extent / 0.3;
      gridHelper.scale.setScalar(scale);
      gridHelper.position.set(x, bounds.min[1], z);
      shadowFloor.scale.set(scale, scale, 1);
      shadowFloor.position.set(x, bounds.min[1], z);
      positionStudioFloor(bounds.min[1]);

      keyLight.position.set(x + 0.8 * scale, y + 1.6 * scale, z + 1.1 * scale);
      fillLight.position.set(x - 0.95 * scale, y + 0.65 * scale, z + 0.55 * scale);
      rimLight.position.set(x + scale, y + 0.85 * scale, z - 0.95 * scale);
      for (const light of [keyLight, fillLight, rimLight]) light.target.position.set(x, y, z);
      const shadowCamera = keyLight.shadow.camera;
      const shadowRadius = 0.35 * scale;
      shadowCamera.left = -shadowRadius;
      shadowCamera.right = shadowRadius;
      shadowCamera.top = shadowRadius;
      shadowCamera.bottom = -shadowRadius;
      shadowCamera.near = 0.2 * scale;
      shadowCamera.far = 5 * scale;
      shadowCamera.updateProjectionMatrix();
      keyLight.shadow.normalBias = 0.00075 * scale;

      camera.near = Math.min(0.001, extent * 0.025);
      camera.far = propsRef.current.cameraGeometry.zoomLimits.maxDistanceMeters + extent * 4;
      camera.updateProjectionMatrix();
    }

    let renderer: THREE.WebGLRenderer | null = null;
    let envRenderTarget: THREE.WebGLRenderTarget | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.06;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.shadowMap.autoUpdate = false;
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const studioEnvironment = createStudioEnvironmentScene();
      try {
        envRenderTarget = pmremGenerator.fromScene(studioEnvironment, 0.04);
      } finally {
        disposeObjectSubtree(studioEnvironment);
        pmremGenerator.dispose();
      }
      scene.environment = envRenderTarget.texture;
      mount.replaceChildren(renderer.domElement);
    } catch {
      envRenderTarget?.dispose();
      envRenderTarget = null;
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
      raycaster: new THREE.Raycaster(),
      pointerNdc: new THREE.Vector2(),
      pointerHits: [],
      environmentMap: envRenderTarget?.texture,
      webglActive: renderer !== null,
      maxAnisotropy: renderer?.capabilities.getMaxAnisotropy() ?? 1,
      requestRender,
      configureStudio,
      positionStudioFloor,
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
      const { assembly, state, leafPartIds, focusedNode, calloutNode, learningState } =
        propsRef.current;
      const targets = targetsRef.current;
      const circuitHighlightIds = targets.circuitHighlightIds ?? EMPTY_CIRCUIT_IDS;
      const model = runtime.model;
      const hoveredComponentId =
        state.viewMode.kind === 'overview' && state.selectedComponentId === null
          ? hoveredComponentIdRef.current
          : null;
      const snapshot = animationRef.current?.step(model?.hasPainted ? dtSec : 0, targets);
      if (model !== null && snapshot !== undefined) {
        applyModelPoses(
          model,
          snapshot.nodePoses,
          state.selectedComponentId,
          hoveredComponentId,
          circuitHighlightIds,
        );
        if (model.hasPainted && model.nextEdgeIndex < model.edgeQueue.length)
          buildQueuedEdges(model);
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
      const hudBounds = hudBarRef.current?.getBoundingClientRect();
      const hudRect =
        hudBounds === undefined
          ? null
          : {
              x: hudBounds.left - viewport.left,
              y: hudBounds.top - viewport.top,
              width: hudBounds.width,
              height: hudBounds.height,
            };
      const composerTop = composerForm?.getBoundingClientRect().top ?? viewport.bottom;
      const composerInsetY = Math.min(composerTop - viewport.top, viewport.height - 112);
      const composerInset = {
        x: 0,
        y: composerInsetY,
        width: viewport.width,
        height: viewport.height - composerInsetY,
      };
      const obstacles = hudRect === null ? [composerInset] : [hudRect, composerInset];
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
      const calloutId = focusedNode?.id ?? hoveredComponentId;
      const calloutPart =
        calloutId === null || !snapshot?.nodePoses[calloutId]?.visible
          ? undefined
          : model?.objectsById.get(calloutId);
      const anchor =
        renderer !== null && calloutPart !== undefined && calloutNode?.id === calloutId
          ? projectPart(calloutPart, camera, viewport, partBounds, projectedPoint)
          : null;
      const calloutElements = {
        overlay: calloutRef.current,
        label: labelRef.current,
        leader: leaderRef.current,
        arrow: arrowRef.current,
        reticle: reticleRef.current,
        anchor,
        viewport,
      };
      const partLabelRect =
        focusedNode === null ? null : updatePartCallout({ ...calloutElements, obstacles });
      const explanation = learningState.explanation;
      const explanationPart =
        explanation.kind === 'idle'
          ? undefined
          : explanation.componentId === focusedNode?.id
            ? focusedPart
            : state.viewMode.kind === 'overview' &&
                explanation.componentId === assembly.rootNodeId &&
                snapshot?.assemblyStatus === 'settled'
              ? rootGroup
              : undefined;
      const explanationAnchors =
        renderer !== null && explanationPart !== undefined
          ? projectPartAnchors(explanationPart, camera, viewport, partBounds, projectedPoint)
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
          : answerPart === explanationPart && explanationAnchors !== null
            ? explanationAnchors
            : projectPartAnchors(answerPart, camera, viewport, partBounds, projectedPoint);

      const learningRects = learningCalloutsRef.current?.syncGeometry({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        partLabelRect,
        anchors: explanationAnchors,
        answerAnchors,
        obstacles: hudRect === null ? [] : [hudRect],
      });

      if (learningRects?.explanationRect != null) obstacles.push(learningRects.explanationRect);
      if (learningRects?.answerRect != null) obstacles.push(learningRects.answerRect);
      const calloutRect =
        focusedNode === null ? updatePartCallout({ ...calloutElements, obstacles }) : partLabelRect;
      const callout =
        calloutNode !== null && anchor !== null && calloutRect !== null
          ? {
              componentId: calloutNode.id,
              name: calloutNode.name,
              anchorPx: anchor,
              labelPx: [calloutRect.x, calloutRect.y] as const,
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
        focusedPartCallout: focusedNode === null ? null : callout,
        hoveredComponentId,
        hoveredPartCallout: focusedNode === null ? callout : null,
        nodeScreenPositions,
        selectedComponentId: state.selectedComponentId,
        isolatedComponentId: targets.isolatedComponentId,
        explodeFactor: targets.explodeFactor,
        activeExplodeStage: targets.activeExplodeStage,
        wiringVisibility: state.wiringVisibility,
        circuitHighlightIds: [...circuitHighlightIds],
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
    if (hudBarRef.current !== null) resizeObserver.observe(hudBarRef.current);
    if (composerForm !== null) resizeObserver.observe(composerForm);
    requestRender();

    return () => {
      disposed = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      disposeObjectSubtree(rootGroup, runtime.environmentMap);
      rootGroup.clear();
      shadowPlaneGeo.dispose();
      shadowPlaneMat.dispose();
      gridHelper.dispose();
      keyLight.shadow.dispose();
      envRenderTarget?.dispose();
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
    const { rootGroup } = runtime;
    runtime.configureStudio(propsRef.current.cameraGeometry.bounds);
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
        runtime.model = bindAssemblyModel(
          gltf.scene,
          animation.schedule,
          runtime.webglActive,
          runtime.maxAnisotropy,
          runtime.environmentMap,
        );
        rootGroup.add(gltf.scene);
        const glbBounds = new THREE.Box3().setFromObject(rootGroup, true);
        if (!glbBounds.isEmpty()) runtime.positionStudioFloor(glbBounds.min.y - 0.002);
        runtime.shadowDirty = true;
        runtime.requestRender();
      },
      () => runtime.requestRender(),
    );

    return () => {
      cancelled = true;
      animationRef.current = null;
      runtime.model = null;
      disposeObjectSubtree(rootGroup, runtime.environmentMap);
      rootGroup.clear();
    };
  }, [assembly, glbArrayBuffer]);

  const hasExplanation = learningState.explanation.kind !== 'idle';
  const hasAnswer = learningState.answer.kind !== 'idle';
  useEffect(() => {
    const explorer = mountRef.current?.parentElement;
    if (explorer === null || explorer === undefined) return;
    const observer = new ResizeObserver(() => {
      if (hoveredComponentIdRef.current !== null) runtimeRef.current?.requestRender();
    });
    for (const card of explorer.querySelectorAll(
      '[aria-label="Component explanation"], [aria-label="Learning answer"]',
    )) {
      observer.observe(card);
    }
    return () => observer.disconnect();
  }, [hasExplanation, hasAnswer]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      zoomLiveCamera((event.deltaY * 0.0005) / DEFAULT_EXPLORER_CAMERA.distanceMeters);
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
  }, [syncCamera, zoomLiveCamera]);

  function setLiveCamera(camera: ExplorerCameraState) {
    targetsRef.current = { ...targetsRef.current, camera };
    runtimeRef.current?.requestRender();
  }

  function stepZoom(direction: 1 | -1) {
    zoomLiveCamera(0.14 * direction);
    syncCamera();
  }

  function changeExplodeFactor(explodeFactor: number) {
    targetsRef.current = { ...targetsRef.current, explodeFactor };
    interruptPlayback();
    onSetExplodeFactor(explodeFactor);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    updateHoveredComponent(null);
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
    if (drag === null) {
      if (
        event.pointerType !== 'touch' &&
        state.viewMode.kind === 'overview' &&
        state.selectedComponentId === null
      ) {
        updateHoveredComponent(pickComponent(runtimeRef.current, event));
      }
      return;
    }
    updateHoveredComponent(null);
    if (drag.id !== event.pointerId) return;
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
    if (drag === null || drag.moved) return;
    const componentId = pickComponent(runtimeRef.current, event);
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
  const wiringLabels = WIRING_HUD_LABELS[state.wiringVisibility];
  const sliderStyle: CSSProperties & { readonly '--explode-progress': string } = {
    '--explode-progress': `${state.explodeFactor * 100}%`,
  };

  return (
    <section className={classes.explorerRoot} aria-label="3D Assembly Explorer">
      <div
        ref={mountRef}
        className={classes.canvasMount}
        data-hovering="false"
        role="region"
        aria-label="Interactive 3D CAD Canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => updateHoveredComponent(null)}
        onPointerUp={handlePointerUp}
        onPointerCancel={finishPointerDrag}
        onLostPointerCapture={finishPointerDrag}
      />
      {!webglActive ? (
        <div className={classes.fallbackHint} role="status">
          3D rendering is unavailable in this browser.
        </div>
      ) : null}

      {calloutNode !== null ? (
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
            aria-label={focusedNode === null ? 'Hovered component' : 'Focused component'}>
            {focusedNode === null ? null : <span className={classes.calloutEyebrow}>Part</span>}
            <strong className={classes.calloutName}>{calloutNode.name}</strong>
          </div>
        </div>
      ) : null}

      <LearningCallouts
        ref={learningCalloutsRef}
        learningState={learningState}
        explanationIsOverview={focusedId === null}
        answeringInOverview={focusedId === null}
        onDismissAnswer={onDismissLearningAnswer}
      />

      {state.viewMode.kind === 'part_focus' ? (
        <button type="button" className={classes.backButton} onClick={exitPartFocus}>
          <HudIcon kind="back" />
          Back
        </button>
      ) : null}

      <div ref={hudBarRef} className={classes.hudBar} role="group" aria-label="Assembly controls">
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
        {hasWiring ? (
          <button
            type="button"
            className={classes.wiringButton}
            aria-label={wiringLabels.label}
            aria-pressed={state.wiringVisibility === 'show'}
            data-wiring-mode={state.wiringVisibility}
            onClick={onCycleWiringVisibility}>
            <HudIcon kind="wiring" />
            {wiringLabels.text}
          </button>
        ) : null}
        <button
          type="button"
          className={classes.zoomButton}
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => stepZoom(1)}>
          <HudIcon kind="zoomOut" />
        </button>
        <button
          type="button"
          className={classes.zoomButton}
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => stepZoom(-1)}>
          <HudIcon kind="zoomIn" />
        </button>
      </div>
    </section>
  );
}
