import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  SUPPORTED_AI_PROVIDERS,
  type AssemblyNode,
  type ComponentId,
  type ExplodeStageFilter,
  type Vector3Tuple,
  getAiProviderDescriptor,
  isComponentId,
} from '@/shared/domain';

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
  computeDefaultCameraForAssembly,
  orbitExplorerCamera,
  zoomExplorerCamera,
} from '../model/explorerState';
import type { AssemblySceneProps, ExplorerCameraState } from '../types';

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
    const material = new THREE.LineBasicMaterial({
      color: '#18181b',
      transparent: true,
      depthWrite: false,
      opacity: 0.18 * (model.lastPoses?.[binding.ownerId]?.opacity ?? 1),
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
      material.emissive.setHex(isSelected ? 0x6b5b00 : 0x000000);
      material.emissiveIntensity = isSelected ? 0.85 : 0;
    }
  }
  if (edgeMaterial !== undefined) edgeMaterial.opacity = 0.18 * pose.opacity;
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
  onSetExplodeStage,
  onSelectComponent,
  onToggleIsolate,
  onSeparateComponent,
  onResetSeparation,
  onSelectProvider,
}: AssemblySceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const animationRef = useRef<AssemblyAnimationController | null>(null);
  const playbackInterruptedRef = useRef(false);
  const targetsRef = useRef<AssemblyAnimationTargets>(state);
  const propsRef = useRef({ assembly, glbArrayBuffer, state });
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
    propsRef.current = { assembly, glbArrayBuffer, state };
    const modelChanged =
      previous.assembly !== assembly || previous.glbArrayBuffer !== glbArrayBuffer;
    const externalCameraChanged =
      previous.state.camera !== state.camera && state.camera !== lastCommittedCameraRef.current;
    if (modelChanged) {
      playbackInterruptedRef.current = false;
      if (wheelCommitRef.current !== null) {
        window.clearTimeout(wheelCommitRef.current);
        wheelCommitRef.current = null;
      }
      dragRef.current = null;
    }
    targetsRef.current = {
      camera: modelChanged || externalCameraChanged ? state.camera : targetsRef.current.camera,
      explodeFactor: state.explodeFactor,
      activeExplodeStage: state.activeExplodeStage,
      isolatedComponentId: state.isolatedComponentId,
      separatedOffsets: state.separatedOffsets,
    };

    if (
      modelChanged ||
      externalCameraChanged ||
      previous.state.explodeFactor !== state.explodeFactor ||
      previous.state.activeExplodeStage !== state.activeExplodeStage ||
      previous.state.selectedComponentId !== state.selectedComponentId ||
      previous.state.isolatedComponentId !== state.isolatedComponentId ||
      previous.state.separatedOffsets !== state.separatedOffsets ||
      previous.state.selectedProvider !== state.selectedProvider
    ) {
      runtimeRef.current?.requestRender();
    }
  });

  const nodesById = useMemo(() => {
    const map: Record<string, AssemblyNode> = {};
    for (const node of assembly.nodes) {
      map[node.id] = node;
    }
    return map;
  }, [assembly.nodes]);

  const interactiveParts = useMemo(
    () =>
      assembly.nodes.filter((node) => node.level === 'component' || node.level === 'subcomponent'),
    [assembly.nodes],
  );

  const selectedNode =
    state.selectedComponentId !== null ? (nodesById[state.selectedComponentId] ?? null) : null;
  const inspectedNode = selectedNode ?? nodesById[assembly.rootNodeId] ?? assembly.nodes[0] ?? null;

  const selectedRelationships = useMemo(() => {
    if (selectedNode === null) {
      return [];
    }
    return assembly.relationships.filter(
      (rel) => rel.fromComponentId === selectedNode.id || rel.toComponentId === selectedNode.id,
    );
  }, [assembly.relationships, selectedNode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) {
      return;
    }

    const width = Math.max(mount.clientWidth, 320);
    const height = Math.max(mount.clientHeight, 260);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f4f3ef');

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.008, 25);
    updateCameraFromSpherical(camera, targetsRef.current.camera);

    const hemiLight = new THREE.HemisphereLight('#ffffff', '#d4d4d8', 0.65);
    const keyLight = new THREE.DirectionalLight('#fffdf8', 1.65);
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

    const fillLight = new THREE.DirectionalLight('#e0f2fe', 0.65);
    fillLight.position.set(-1.1, 0.9, -0.8);

    const rimLight = new THREE.DirectionalLight('#f4f4f5', 0.5);
    rimLight.position.set(0.0, -0.9, -1.2);

    const gridHelper = new THREE.GridHelper(0.7, 14, '#d4d4d8', '#e7e5e4');

    const shadowPlaneGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.16 });
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
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
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

    function renderFrame(now: number): void {
      frameId = null;
      const dtSec = lastFrameTime === null ? 0 : (now - lastFrameTime) / 1000;
      lastFrameTime = now;
      const { assembly, state } = propsRef.current;
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
    }

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(mount.clientWidth, 240);
      const nextHeight = Math.max(mount.clientHeight, 220);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
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

  function interruptPlayback() {
    playbackInterruptedRef.current = true;
    if (animationRef.current !== null) settleAssemblyPlayback(animationRef.current);
    runtimeRef.current?.requestRender();
  }

  function changeExplodeFactor(explodeFactor: number) {
    targetsRef.current = { ...targetsRef.current, explodeFactor };
    interruptPlayback();
    onSetExplodeFactor(explodeFactor);
  }

  function pickComponent(componentId: ComponentId | null) {
    interruptPlayback();
    onSelectComponent(componentId);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
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

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
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

  function finishPointerDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.id !== event.pointerId) return null;
    dragRef.current = null;
    if (drag.moved) syncCamera();
    return drag;
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
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
    pickComponent(hit === undefined ? null : findAncestorComponentId(hit.object));
  }

  const parentNode =
    selectedNode !== null && selectedNode.parentId !== null
      ? (nodesById[selectedNode.parentId] ?? null)
      : null;

  return (
    <section className={classes.explorerRoot} aria-label="3D Assembly Explorer">
      <header className={classes.headerBar}>
        <div className={classes.titleGroup}>
          <h1 className={classes.projectTitle}>{assembly.title}</h1>
          <span
            className={
              assembly.verificationStatus === 'unverified'
                ? `${classes.statusBadge} ${classes.statusBadgeUnverified}`
                : classes.statusBadge
            }>
            {assembly.verificationStatus}
          </span>
          <span className={classes.orchestrationBadge} title="Live orchestration">
            {`${assembly.orchestration.provider} · ${assembly.orchestration.executionMode}`}
          </span>
        </div>
        <div className={classes.providerGroup} role="group" aria-label="AI orchestrator model">
          {SUPPORTED_AI_PROVIDERS.map((providerId) => {
            const descriptor = getAiProviderDescriptor(providerId);
            const active = state.selectedProvider === providerId;
            return (
              <button
                key={providerId}
                type="button"
                className={
                  active
                    ? `${classes.controlButton} ${classes.controlButtonActive}`
                    : classes.controlButton
                }
                aria-label={`Use ${descriptor.displayName}`}
                aria-pressed={active}
                onClick={() => onSelectProvider(providerId)}>
                {descriptor.displayName}
              </button>
            );
          })}
        </div>
      </header>

      <div className={classes.workspaceGrid}>
        <div className={classes.viewportCard}>
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
            <div className={classes.fallbackHint}>
              WebGL context unavailable; deterministic CAD kinematics active
            </div>
          ) : null}
          <div className={classes.viewportOverlay}>
            <div className={classes.overlayPillGroup}>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Rotate left"
                onClick={() =>
                  commitCamera(orbitExplorerCamera(targetsRef.current.camera, -24, 0))
                }>
                Rotate L
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Rotate right"
                onClick={() => commitCamera(orbitExplorerCamera(targetsRef.current.camera, 24, 0))}>
                Rotate R
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Tilt up"
                onClick={() => commitCamera(orbitExplorerCamera(targetsRef.current.camera, 0, 14))}>
                Tilt +
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Tilt down"
                onClick={() =>
                  commitCamera(orbitExplorerCamera(targetsRef.current.camera, 0, -14))
                }>
                Tilt -
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Zoom in"
                onClick={() => commitCamera(zoomExplorerCamera(targetsRef.current.camera, -0.08))}>
                Zoom +
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Zoom out"
                onClick={() => commitCamera(zoomExplorerCamera(targetsRef.current.camera, 0.08))}>
                Zoom -
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Reset view"
                onClick={() => commitCamera(computeDefaultCameraForAssembly(assembly))}>
                Reset
              </button>
            </div>

            <div className={classes.overlayPillGroup}>
              <button
                type="button"
                className={
                  state.explodeFactor === 0
                    ? `${classes.controlButton} ${classes.controlButtonActive}`
                    : classes.controlButton
                }
                aria-label="Collapse assembly"
                onClick={() => changeExplodeFactor(0)}>
                0%
              </button>
              <button
                type="button"
                className={
                  state.explodeFactor === 0.25
                    ? `${classes.controlButton} ${classes.controlButtonActive}`
                    : classes.controlButton
                }
                aria-label="Explode 25%"
                onClick={() => changeExplodeFactor(0.25)}>
                25%
              </button>
              <button
                type="button"
                className={
                  state.explodeFactor === 0.5
                    ? `${classes.controlButton} ${classes.controlButtonActive}`
                    : classes.controlButton
                }
                aria-label="Explode 50%"
                onClick={() => changeExplodeFactor(0.5)}>
                50%
              </button>
              <button
                type="button"
                className={
                  state.explodeFactor === 1
                    ? `${classes.controlButton} ${classes.controlButtonActive}`
                    : classes.controlButton
                }
                aria-label="Explode 100%"
                onClick={() => changeExplodeFactor(1)}>
                100%
              </button>
            </div>
          </div>
        </div>

        <aside className={classes.sidePanel} aria-label="Assembly Manipulation Controls">
          <div className={classes.panelSection}>
            <p className={classes.sectionLabel}>
              Explode ({Math.round(state.explodeFactor * 100)}%)
            </p>
            <input
              type="range"
              aria-label="Explode factor"
              className={classes.explodeSlider}
              min={0}
              max={1}
              step={0.001}
              value={state.explodeFactor}
              onChange={(event) => changeExplodeFactor(Number(event.target.value))}
            />
            <div className={classes.buttonRow}>
              {(
                [
                  ['all', 'Stage All'],
                  [1, 'Stage 1 Subsystems'],
                  [2, 'Stage 2 Parts'],
                  [3, 'Stage 3 Subcomponents'],
                ] as const
              ).map(([stageVal, label]) => (
                <button
                  key={String(stageVal)}
                  type="button"
                  className={
                    state.activeExplodeStage === stageVal
                      ? `${classes.controlButton} ${classes.controlButtonActive}`
                      : classes.controlButton
                  }
                  aria-label={label}
                  onClick={() => {
                    interruptPlayback();
                    onSetExplodeStage(stageVal);
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className={classes.panelSection}>
            <p className={classes.sectionLabel}>
              {selectedNode !== null ? `Selected: ${selectedNode.name}` : 'Part Manipulation'}
            </p>
            <div className={classes.buttonRow}>
              <button
                type="button"
                className={
                  state.isolatedComponentId !== null
                    ? `${classes.controlButton} ${classes.controlButtonActive}`
                    : classes.controlButton
                }
                disabled={selectedNode === null}
                aria-label={
                  state.isolatedComponentId !== null ? 'Show all parts' : 'Isolate selected part'
                }
                onClick={() => {
                  interruptPlayback();
                  onToggleIsolate();
                }}>
                {state.isolatedComponentId !== null ? 'Show All' : 'Isolate'}
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Separate part +X"
                onClick={() => {
                  interruptPlayback();
                  onSeparateComponent('x', 0.04);
                }}>
                +X
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Separate part +Y"
                onClick={() => {
                  interruptPlayback();
                  onSeparateComponent('y', 0.04);
                }}>
                +Y
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Separate part +Z"
                onClick={() => {
                  interruptPlayback();
                  onSeparateComponent('z', 0.04);
                }}>
                +Z
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Reset part position"
                onClick={() => {
                  interruptPlayback();
                  onResetSeparation();
                }}>
                Reset Part
              </button>
            </div>
          </div>

          {inspectedNode !== null ? (
            <div className={classes.panelSection} aria-label="CAD Component Inspector">
              <p className={classes.sectionLabel}>CAD Component Inspector</p>
              <div className={classes.inspectorCard}>
                <div className={classes.inspectorHeader}>
                  <span className={classes.inspectorTitle}>{inspectedNode.name}</span>
                  <span className={classes.inspectorBadge}>{inspectedNode.level}</span>
                </div>
                {parentNode !== null ? (
                  <span className={classes.provenanceMeta}>{`Parent: ${parentNode.name}`}</span>
                ) : null}
                <div className={classes.inspectorMetaRow}>
                  <span className={classes.specPill}>
                    {`${inspectedNode.dimensionsMm[0]} × ${inspectedNode.dimensionsMm[1]} × ${inspectedNode.dimensionsMm[2]} mm`}
                  </span>
                  <span className={classes.specPill}>{inspectedNode.materialHint}</span>
                  {Object.entries(inspectedNode.specifications).map(([key, value]) => (
                    <span key={key} className={classes.specPill}>
                      {`${key}: ${String(value)}`}
                    </span>
                  ))}
                </div>
                {selectedRelationships.map((rel) => {
                  const peerId =
                    rel.fromComponentId === selectedNode?.id
                      ? rel.toComponentId
                      : rel.fromComponentId;
                  const peerName = nodesById[peerId]?.name ?? peerId;
                  return (
                    <div key={rel.id} className={classes.relationshipBox}>
                      <strong>{`${rel.connectionType} · ${peerName}`}</strong>
                      <span>{rel.howConnected}</span>
                      <span>{rel.whyConnected}</span>
                    </div>
                  );
                })}
                <span className={classes.provenanceMeta}>
                  {`${inspectedNode.provenance.sourceName} · ${inspectedNode.provenance.spdxLicense}`}
                </span>
                <a
                  href={inspectedNode.provenance.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={classes.provenanceLink}>
                  {inspectedNode.provenance.sourceUrl}
                </a>
                <span className={classes.provenanceMeta}>
                  {`STEP SHA-256: ${inspectedNode.provenance.stepSha256.slice(0, 12)} · Interferences: ${assembly.validation.interferenceCount}`}
                </span>
              </div>
            </div>
          ) : null}

          <div className={classes.panelSection}>
            <p className={classes.sectionLabel}>Hierarchy ({interactiveParts.length} parts)</p>
            <div className={classes.partList}>
              {interactiveParts.map((part) => {
                const selected = state.selectedComponentId === part.id;
                return (
                  <button
                    key={part.id}
                    type="button"
                    className={
                      selected
                        ? `${classes.partButton} ${classes.partButtonSelected}`
                        : classes.partButton
                    }
                    aria-label={`Select part ${part.name}`}
                    aria-pressed={selected}
                    onClick={() => pickComponent(selected ? null : part.id)}>
                    <span>{part.name}</span>
                    <span className={classes.partMeta}>{part.provenance.spdxLicense}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
