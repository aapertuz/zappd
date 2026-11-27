import { useLayoutEffect, useRef, type RefObject } from 'react';
import { WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { type CatalogArchetypeId } from '@/shared/domain';
import {
  CAD_PREVIEW_INITIAL_ANGLE,
  createCadStudioTurntable,
  disposeObjectSubtree,
} from '@/shared/ui/cadStudio';

import { preloadCatalogAssemblyBundle } from '@/features/assembly-explorer';

import { type CatalogAssemblyCard, type SelectorState } from '../types';

type SelectorDiagnostics = Readonly<{
  cardCount: number;
  archetypeIds: readonly CatalogArchetypeId[];
  activeTurntableArchetypeId: CatalogArchetypeId;
  turntableAngleRad: number;
  turntableFramesRendered: number;
  webglActive: boolean;
  reducedMotion: boolean;
  visibleCardIds: readonly CatalogArchetypeId[];
}>;

declare global {
  interface Window {
    __zappdSelectorDiagnostics?: SelectorDiagnostics;
  }
}

function createTurntable(archetypeIds: readonly CatalogArchetypeId[]) {
  let renderer: WebGLRenderer | undefined;
  let studio: ReturnType<typeof createCadStudioTurntable> | undefined;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    studio = createCadStudioTurntable(renderer);
  } catch {
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer = undefined;
  }

  const loader = new GLTFLoader();
  let generation = 0;
  let host: HTMLSpanElement | undefined;
  let modelReady = false;
  let state: SelectorState | undefined;
  let angle = CAD_PREVIEW_INITIAL_ANGLE;
  let frames = 0;
  let frameRequest: number | undefined;
  let previousTime: number | undefined;
  let published: SelectorDiagnostics | undefined;

  function publish() {
    if (state === undefined) return;
    published = Object.freeze({
      cardCount: archetypeIds.length,
      archetypeIds,
      activeTurntableArchetypeId: state.activeTurntableArchetypeId,
      turntableAngleRad: angle,
      turntableFramesRendered: frames,
      webglActive: renderer !== undefined && !renderer.getContext().isContextLost(),
      reducedMotion: state.reducedMotion,
      visibleCardIds: Object.freeze([...state.visibleCardIds]),
    });
    window.__zappdSelectorDiagnostics = published;
  }

  function canDraw(): boolean {
    return (
      renderer !== undefined &&
      !renderer.getContext().isContextLost() &&
      modelReady &&
      state?.visibleCardIds.includes(state.activeTurntableArchetypeId) === true
    );
  }

  function stop() {
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    previousTime = undefined;
  }

  function draw() {
    if (!canDraw() || host === undefined || studio === undefined) return;
    studio.render(angle, host.clientWidth / Math.max(host.clientHeight, 1));
    host.dataset.rendered = 'true';
    frames += 1;
    publish();
  }

  function tick(time: number) {
    frameRequest = undefined;
    if (!canDraw() || state?.reducedMotion !== false) return;
    if (previousTime !== undefined) {
      angle = (angle + Math.min((time - previousTime) / 1000, 0.09) * 0.24) % (Math.PI * 2);
    }
    previousTime = time;
    draw();
    frameRequest = requestAnimationFrame(tick);
  }

  function schedule() {
    if (canDraw() && state?.reducedMotion === false && frameRequest === undefined) {
      frameRequest = requestAnimationFrame(tick);
    }
  }

  function resize() {
    if (host === undefined) return;
    renderer?.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
    draw();
    schedule();
  }

  const resizeObserver = new ResizeObserver(resize);

  function clearTarget() {
    generation += 1;
    stop();
    resizeObserver.disconnect();
    modelReady = false;
    studio?.clearModel();
    if (host !== undefined) delete host.dataset.rendered;
    renderer?.domElement.remove();
    host = undefined;
  }

  function setTarget(archetypeId: CatalogArchetypeId, nextHost: HTMLSpanElement | undefined) {
    clearTarget();
    if (nextHost === undefined || renderer === undefined || studio === undefined) return;
    host = nextHost;
    const targetStudio = studio;
    const currentGeneration = generation;
    angle = CAD_PREVIEW_INITIAL_ANGLE;
    host.append(renderer.domElement);
    resizeObserver.observe(host);
    void preloadCatalogAssemblyBundle(archetypeId)
      .then(async ({ glbArrayBuffer }) => {
        if (currentGeneration !== generation) return;
        const { scene } = await loader.parseAsync(glbArrayBuffer, '');
        if (currentGeneration !== generation) {
          disposeObjectSubtree(scene);
          return;
        }
        targetStudio.setModel(scene);
        modelReady = true;
        resize();
      })
      .catch(() => {});
  }

  function handleContextLoss() {
    stop();
    if (host !== undefined) delete host.dataset.rendered;
    publish();
  }

  renderer?.domElement.addEventListener('webglcontextlost', handleContextLoss);
  renderer?.domElement.addEventListener('webglcontextrestored', resize);

  return {
    update(next: SelectorState, mounts: Map<CatalogArchetypeId, HTMLSpanElement>) {
      const previous = state;
      state = next;
      const { activeTurntableArchetypeId } = next;
      if (previous?.activeTurntableArchetypeId !== activeTurntableArchetypeId) {
        setTarget(activeTurntableArchetypeId, mounts.get(activeTurntableArchetypeId));
      }
      const visible = next.visibleCardIds.includes(activeTurntableArchetypeId);
      if (!visible || next.reducedMotion) stop();
      if (visible && previous?.visibleCardIds.includes(activeTurntableArchetypeId) !== true) draw();
      schedule();
      publish();
    },
    dispose() {
      clearTarget();
      renderer?.domElement.removeEventListener('webglcontextlost', handleContextLoss);
      renderer?.domElement.removeEventListener('webglcontextrestored', resize);
      studio?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      if (window.__zappdSelectorDiagnostics === published) delete window.__zappdSelectorDiagnostics;
    },
  };
}

export function useCatalogTurntable(
  cards: readonly CatalogAssemblyCard[],
  state: SelectorState,
  mounts: RefObject<Map<CatalogArchetypeId, HTMLSpanElement>>,
): void {
  const turntable = useRef<ReturnType<typeof createTurntable> | null>(null);
  useLayoutEffect(() => {
    const controller = createTurntable(Object.freeze(cards.map(({ archetypeId }) => archetypeId)));
    turntable.current = controller;
    return () => {
      controller.dispose();
      turntable.current = null;
    };
  }, [cards]);
  useLayoutEffect(() => {
    turntable.current?.update(state, mounts.current);
  }, [cards, state, mounts]);
}
