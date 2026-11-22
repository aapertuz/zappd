import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
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

function isThreeMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return 'isMesh' in obj && obj.isMesh === true;
}

function readComponentIdFromUserData(userData: unknown): string | null {
  if (typeof userData !== 'object' || userData === null) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(userData, 'componentId');
  const candidate: unknown = descriptor?.value;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function findAncestorComponentId(obj: THREE.Object3D | null): ComponentId | null {
  let cursor: THREE.Object3D | null = obj;
  while (cursor !== null) {
    const candidate = readComponentIdFromUserData(cursor.userData);
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
  const objectsByIdRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const meshesByIdRef = useRef<Map<string, THREE.Mesh[]>>(new Map());
  const dragStateRef = useRef<{
    active: boolean;
    moved: boolean;
    lastX: number;
    lastY: number;
  }>({ active: false, moved: false, lastX: 0, lastY: 0 });
  const initialCameraRef = useRef(state.camera);

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

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) {
      return;
    }

    const width = Math.max(mount.clientWidth, 320);
    const height = Math.max(mount.clientHeight, 260);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f4f4f0');

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 20);
    updateCameraFromSpherical(camera, initialCameraRef.current);

    const ambientLight = new THREE.AmbientLight('#ffffff', 1.15);
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.45);
    keyLight.position.set(1.2, 2.0, 1.4);
    const rimLight = new THREE.DirectionalLight('#e0f2fe', 0.65);
    rimLight.position.set(-1.2, 0.8, -1.0);
    const gridHelper = new THREE.GridHelper(0.6, 12, '#d4d4d8', '#e4e4e7');
    gridHelper.position.y = -0.05;

    const rootGroup = new THREE.Group();
    scene.add(ambientLight, keyLight, rimLight, gridHelper, rootGroup);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rootGroupRef.current = rootGroup;

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
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
      renderer?.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      rootGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const rootGroup = rootGroupRef.current;
    if (rootGroup === null || glbArrayBuffer === null) {
      return;
    }

    rootGroup.clear();
    objectsByIdRef.current.clear();
    meshesByIdRef.current.clear();

    const loader = new GLTFLoader();
    loader.parse(
      glbArrayBuffer,
      '',
      (gltf) => {
        const discoveredIds: string[] = [];
        gltf.scene.traverse((obj) => {
          const cid = readComponentIdFromUserData(obj.userData);
          if (cid !== null) {
            objectsByIdRef.current.set(cid, obj);
            discoveredIds.push(cid);
          }
          if (isThreeMesh(obj)) {
            const ownerId = findAncestorComponentId(obj);
            if (ownerId !== null) {
              obj.userData.componentId = ownerId;
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
        setGlbNodeIds([]);
      },
    );
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

  return (
    <section className={classes.explorerRoot} aria-label="3D Assembly Explorer">
      <header className={classes.headerBar}>
        <div className={classes.titleGroup}>
          <h1 className={classes.projectTitle}>{assembly.title}</h1>
          <span className={classes.statusBadge}>{assembly.verificationStatus}</span>
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
