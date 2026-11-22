import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  SUPPORTED_AI_PROVIDERS,
  type AssemblyNode,
  type ComponentId,
  type ExplodeStageFilter,
  type Vector3Tuple,
  computeNodeWorldPositionMeters,
  getAiProviderDescriptor,
  isComponentId,
} from '@/shared/domain';

import type { AssemblySceneProps } from '../types';
import classes from './AssemblyScene.web.module.css';

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

export function AssemblyScene({
  assembly,
  glbArrayBuffer,
  state,
  onOrbitCamera,
  onZoomCamera,
  onResetCamera,
  onSetExplodeFactor,
  onSetExplodeStage,
  onSelectComponent,
  onToggleIsolate,
  onSeparateComponent,
  onResetSeparation,
  onSelectProvider,
}: AssemblySceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rootGroupRef = useRef<THREE.Group | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const shadowFloorRef = useRef<THREE.Mesh | null>(null);
  const objectsByIdRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const meshesByIdRef = useRef<Map<string, THREE.Mesh[]>>(new Map());
  const dragStateRef = useRef<{
    active: boolean;
    moved: boolean;
    lastX: number;
    lastY: number;
  }>({ active: false, moved: false, lastX: 0, lastY: 0 });
  const initialCameraRef = useRef(state.camera);
  const initialArchetypeIdRef = useRef(assembly.archetypeId);

  const [webglActive, setWebglActive] = useState(true);
  const [glbNodeIds, setGlbNodeIds] = useState<readonly string[]>([]);

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
    updateCameraFromSpherical(camera, initialCameraRef.current);

    const hemiLight = new THREE.HemisphereLight('#ffffff', '#d4d4d8', 0.65);
    const keyLight = new THREE.DirectionalLight('#fffdf8', 1.65);
    keyLight.position.set(0.8, 1.6, 1.1);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
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

    const floorY = resolveStudioFloorY(initialArchetypeIdRef.current);
    const gridHelper = new THREE.GridHelper(0.7, 14, '#d4d4d8', '#e7e5e4');
    gridHelper.position.y = floorY;

    const shadowPlaneGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.16 });
    const shadowFloor = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowFloor.rotation.x = -Math.PI / 2;
    shadowFloor.position.y = floorY + 0.0005;
    shadowFloor.receiveShadow = true;

    const rootGroup = new THREE.Group();
    scene.add(hemiLight, keyLight, fillLight, rimLight, gridHelper, shadowFloor, rootGroup);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rootGroupRef.current = rootGroup;
    gridHelperRef.current = gridHelper;
    shadowFloorRef.current = shadowFloor;

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
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      pmremGenerator = new THREE.PMREMGenerator(renderer);
      roomEnvironment = new RoomEnvironment();
      envRenderTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
      scene.environment = envRenderTarget.texture;
      mount.replaceChildren(renderer.domElement);
      rendererRef.current = renderer;
    } catch {
      rendererRef.current = null;
      queueMicrotask(() => setWebglActive(false));
    }

    let animationFrameId = 0;
    const renderLoop = () => {
      if (rendererRef.current !== null && sceneRef.current !== null && cameraRef.current !== null) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
      animationFrameId = window.requestAnimationFrame(renderLoop);
    };
    animationFrameId = window.requestAnimationFrame(renderLoop);

    const resizeObserver = new ResizeObserver(() => {
      if (mountRef.current === null || cameraRef.current === null) {
        return;
      }
      const nextWidth = Math.max(mountRef.current.clientWidth, 240);
      const nextHeight = Math.max(mountRef.current.clientHeight, 220);
      cameraRef.current.aspect = nextWidth / nextHeight;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current?.setSize(nextWidth, nextHeight);
    });
    resizeObserver.observe(mount);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      disposeObjectSubtree(rootGroup);
      shadowPlaneGeo.dispose();
      shadowPlaneMat.dispose();
      gridHelper.dispose();
      envRenderTarget?.dispose();
      roomEnvironment?.dispose();
      pmremGenerator?.dispose();
      renderer?.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      rootGroupRef.current = null;
      gridHelperRef.current = null;
      shadowFloorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const floorY = resolveStudioFloorY(initialArchetypeIdRef.current);
    if (gridHelperRef.current !== null) {
      gridHelperRef.current.position.y = floorY;
    }
    if (shadowFloorRef.current !== null) {
      shadowFloorRef.current.position.y = floorY + 0.0005;
    }
  }, [assembly.archetypeId]);

  useEffect(() => {
    const rootGroup = rootGroupRef.current;
    if (rootGroup === null || glbArrayBuffer === null) {
      return;
    }

    disposeObjectSubtree(rootGroup);
    rootGroup.clear();
    objectsByIdRef.current.clear();
    meshesByIdRef.current.clear();

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
        const discoveredIds: string[] = [];
        gltf.scene.traverse((obj) => {
          const cid = readUserDataString(obj.userData, 'componentId');
          if (cid !== null) {
            objectsByIdRef.current.set(cid, obj);
            discoveredIds.push(cid);
          }
          if (isThreeMesh(obj)) {
            const ownerId = findAncestorComponentId(obj);
            if (ownerId !== null) {
              obj.userData.componentId = ownerId;
              const materialHint = findAncestorUserDataString(obj, 'materialHint') ?? 'default';
              if (!Array.isArray(obj.material)) {
                obj.material = buildPhysicalCadMaterial(obj.material, materialHint);
              }
              obj.castShadow = true;
              obj.receiveShadow = true;

              const edgeGeometry = new THREE.EdgesGeometry(obj.geometry, 32);
              const edgeMaterial = new THREE.LineBasicMaterial({
                color: '#18181b',
                transparent: true,
                opacity: 0.18,
              });
              const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
              edgeLines.raycast = () => {};
              obj.add(edgeLines);

              const existingList = meshesByIdRef.current.get(ownerId) ?? [];
              existingList.push(obj);
              meshesByIdRef.current.set(ownerId, existingList);
            }
          }
        });
        rootGroup.add(gltf.scene);
        setGlbNodeIds(discoveredIds);
      },
      () => {
        if (!cancelled) {
          setGlbNodeIds([]);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [glbArrayBuffer]);

  useEffect(() => {
    const worldPositions: Record<string, Vector3Tuple> = {};
    for (const node of assembly.nodes) {
      const worldPos = computeNodeWorldPositionMeters(
        node,
        nodesById,
        state.explodeFactor,
        state.separatedOffsets,
        state.activeExplodeStage,
      );
      worldPositions[node.id] = worldPos;
    }

    if (cameraRef.current !== null) {
      const isolatedTarget =
        state.isolatedComponentId !== null ? worldPositions[state.isolatedComponentId] : undefined;
      const effectiveCamera =
        isolatedTarget !== undefined
          ? { ...state.camera, targetMeters: isolatedTarget }
          : state.camera;
      updateCameraFromSpherical(cameraRef.current, effectiveCamera);
    }

    for (const node of assembly.nodes) {
      const obj = objectsByIdRef.current.get(node.id);
      const worldPos = worldPositions[node.id];
      if (obj !== undefined && worldPos !== undefined) {
        const parentWorld =
          node.parentId !== null ? (worldPositions[node.parentId] ?? [0, 0, 0]) : [0, 0, 0];
        obj.position.set(
          worldPos[0] - parentWorld[0],
          worldPos[1] - parentWorld[1],
          worldPos[2] - parentWorld[2],
        );
      }

      const meshes = meshesByIdRef.current.get(node.id) ?? [];
      const isSelected = state.selectedComponentId === node.id;
      const isHiddenByIsolation =
        state.isolatedComponentId !== null && state.isolatedComponentId !== node.id;

      for (const mesh of meshes) {
        mesh.visible = !isHiddenByIsolation;
        if (mesh.material instanceof THREE.MeshStandardMaterial) {
          mesh.material.emissive.setHex(isSelected ? 0x6b5b00 : 0x000000);
          mesh.material.emissiveIntensity = isSelected ? 0.85 : 0;
        }
      }
    }

    window.__zappdAssemblyDiagnostics = {
      projectId: assembly.projectId,
      archetypeId: assembly.archetypeId,
      title: assembly.title,
      provider: state.selectedProvider,
      apiFormat: assembly.orchestration.apiFormat,
      verificationStatus: assembly.verificationStatus,
      validationPassed: assembly.validation.valid,
      interferenceCount: assembly.validation.interferenceCount,
      nodeCount: assembly.nodes.length,
      glbNodeIds,
      selectedComponentId: state.selectedComponentId,
      isolatedComponentId: state.isolatedComponentId,
      explodeFactor: state.explodeFactor,
      activeExplodeStage: state.activeExplodeStage,
      camera: state.camera,
      separatedOffsets: state.separatedOffsets,
      nodePositionsMeters: worldPositions,
      webglActive,
    };
  }, [assembly, glbNodeIds, nodesById, state, webglActive]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = {
      active: true,
      moved: false,
      lastX: event.clientX,
      lastY: event.clientY,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current.active) {
      return;
    }
    const dx = event.clientX - dragStateRef.current.lastX;
    const dy = event.clientY - dragStateRef.current.lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      dragStateRef.current.moved = true;
    }
    dragStateRef.current.lastX = event.clientX;
    dragStateRef.current.lastY = event.clientY;
    onOrbitCamera(-dx * 0.5, dy * 0.4);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const wasDrag = dragStateRef.current.moved;
    dragStateRef.current.active = false;
    if (wasDrag) {
      return;
    }
    const mount = mountRef.current;
    const camera = cameraRef.current;
    const rootGroup = rootGroupRef.current;
    if (mount === null || camera === null || rootGroup === null) {
      return;
    }
    const rect = mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hits = raycaster.intersectObjects(rootGroup.children, true);
    const visibleHit = hits.find((hit) => hit.object.visible);
    if (visibleHit === undefined) {
      onSelectComponent(null);
      return;
    }
    const pickedId = findAncestorComponentId(visibleHit.object);
    onSelectComponent(pickedId);
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    onZoomCamera(event.deltaY * 0.0005);
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
            onWheel={handleWheel}
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
                onClick={() => onOrbitCamera(-24, 0)}>
                Rotate L
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Rotate right"
                onClick={() => onOrbitCamera(24, 0)}>
                Rotate R
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Tilt up"
                onClick={() => onOrbitCamera(0, 14)}>
                Tilt +
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Tilt down"
                onClick={() => onOrbitCamera(0, -14)}>
                Tilt -
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Zoom in"
                onClick={() => onZoomCamera(-0.08)}>
                Zoom +
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Zoom out"
                onClick={() => onZoomCamera(0.08)}>
                Zoom -
              </button>
              <button
                type="button"
                className={classes.controlButton}
                aria-label="Reset view"
                onClick={onResetCamera}>
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
                onClick={() => onSetExplodeFactor(0)}>
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
                onClick={() => onSetExplodeFactor(0.25)}>
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
                onClick={() => onSetExplodeFactor(0.5)}>
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
                onClick={() => onSetExplodeFactor(1)}>
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
              step={0.05}
              value={state.explodeFactor}
              onChange={(event) => onSetExplodeFactor(Number(event.target.value))}
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
                  onClick={() => onSetExplodeStage(stageVal)}>
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
                onClick={onToggleIsolate}>
                {state.isolatedComponentId !== null ? 'Show All' : 'Isolate'}
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Separate part +X"
                onClick={() => onSeparateComponent('x', 0.04)}>
                +X
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Separate part +Y"
                onClick={() => onSeparateComponent('y', 0.04)}>
                +Y
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Separate part +Z"
                onClick={() => onSeparateComponent('z', 0.04)}>
                +Z
              </button>
              <button
                type="button"
                className={classes.controlButton}
                disabled={selectedNode === null}
                aria-label="Reset part position"
                onClick={onResetSeparation}>
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
                    onClick={() => onSelectComponent(selected ? null : part.id)}>
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
