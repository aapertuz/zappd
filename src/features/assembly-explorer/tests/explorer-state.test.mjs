import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toComponentId } from '../../../shared/domain/assembly.ts';
import {
  DEFAULT_EXPLORER_CAMERA,
  INITIAL_ASSEMBLY_EXPLORER_STATE,
  reconcileCameraTarget,
  reduceAssemblyExplorerState,
} from '../model/explorerState.ts';

describe('assembly explorer manipulation state reducer', () => {
  it('starts on DeepSeek and switches provider on selection', () => {
    assert.equal(INITIAL_ASSEMBLY_EXPLORER_STATE.selectedProvider, 'deepseek');
    const switched = reduceAssemblyExplorerState(INITIAL_ASSEMBLY_EXPLORER_STATE, {
      type: 'setProvider',
      provider: 'gemini',
    });
    assert.equal(switched.selectedProvider, 'gemini');
  });

  it('rotates and zooms the camera within physical bounds', () => {
    const orbited = reduceAssemblyExplorerState(INITIAL_ASSEMBLY_EXPLORER_STATE, {
      type: 'orbitCamera',
      deltaAzimuthDeg: 30,
      deltaElevationDeg: 20,
    });
    assert.equal(orbited.camera.azimuthDeg, DEFAULT_EXPLORER_CAMERA.azimuthDeg + 30);
    assert.equal(orbited.camera.elevationDeg, DEFAULT_EXPLORER_CAMERA.elevationDeg + 20);

    const clampedHigh = reduceAssemblyExplorerState(orbited, {
      type: 'orbitCamera',
      deltaAzimuthDeg: 0,
      deltaElevationDeg: 500,
    });
    assert.equal(clampedHigh.camera.elevationDeg, 85);

    const zoomedIn = reduceAssemblyExplorerState(clampedHigh, {
      type: 'zoomCamera',
      deltaDistanceMeters: -0.2,
    });
    assert.ok(
      Math.abs(zoomedIn.camera.distanceMeters - (DEFAULT_EXPLORER_CAMERA.distanceMeters - 0.2)) <
        1e-6,
    );

    const clampedClose = reduceAssemblyExplorerState(zoomedIn, {
      type: 'zoomCamera',
      deltaDistanceMeters: -10,
    });
    assert.equal(clampedClose.camera.distanceMeters, 0.08);

    const reset = reduceAssemblyExplorerState(clampedClose, { type: 'resetCamera' });
    assert.deepEqual(reset.camera, DEFAULT_EXPLORER_CAMERA);
  });

  it('clamps continuous explode factor and filters explode stages', () => {
    const half = reduceAssemblyExplorerState(INITIAL_ASSEMBLY_EXPLORER_STATE, {
      type: 'setExplodeFactor',
      explodeFactor: 0.5,
    });
    assert.equal(half.explodeFactor, 0.5);

    const over = reduceAssemblyExplorerState(half, {
      type: 'setExplodeFactor',
      explodeFactor: 1.75,
    });
    assert.equal(over.explodeFactor, 1);

    const staged = reduceAssemblyExplorerState(over, {
      type: 'setExplodeStage',
      stage: 2,
    });
    assert.equal(staged.activeExplodeStage, 2);
  });

  it('selects, isolates, separates along XYZ axes, and resets parts by componentId', () => {
    const motorId = toComponentId('comp_motor_fl');
    const selected = reduceAssemblyExplorerState(INITIAL_ASSEMBLY_EXPLORER_STATE, {
      type: 'selectComponent',
      componentId: motorId,
    });
    assert.equal(selected.selectedComponentId, motorId);
    assert.equal(selected.isolatedComponentId, null);

    const isolated = reduceAssemblyExplorerState(selected, { type: 'toggleIsolateComponent' });
    assert.equal(isolated.isolatedComponentId, motorId);

    const separatedY = reduceAssemblyExplorerState(isolated, {
      type: 'separateComponentAlongAxis',
      axis: 'y',
      deltaMeters: 0.04,
    });
    const separatedXY = reduceAssemblyExplorerState(separatedY, {
      type: 'separateComponentAlongAxis',
      axis: 'x',
      deltaMeters: 0.02,
    });
    assert.deepEqual(separatedXY.separatedOffsets[motorId], [0.02, 0.04, 0]);

    const resetPart = reduceAssemblyExplorerState(separatedXY, {
      type: 'resetComponentSeparation',
    });
    assert.equal(resetPart.separatedOffsets[motorId], undefined);

    const unisolated = reduceAssemblyExplorerState(resetPart, { type: 'toggleIsolateComponent' });
    assert.equal(unisolated.isolatedComponentId, null);
  });
});

describe('assembly explorer loading state', () => {
  it('reports orchestration, download and readiness in order with bounded progress', () => {
    const initial = INITIAL_ASSEMBLY_EXPLORER_STATE;
    assert.equal(initial.loadingPhase, 'idle');
    assert.equal(initial.loadingProgress, 0);
    const loading = reduceAssemblyExplorerState(initial, { type: 'startLoading', promptId: 1 });
    assert.equal(loading.isLoading, true);
    assert.equal(loading.loadingPhase, 'orchestrating');
    assert.equal(loading.loadingProgress, 0.12);
    const progressing = reduceAssemblyExplorerState(loading, {
      type: 'setLoadingProgress',
      promptId: 1,
      phase: 'orchestrating',
      progress: 0.4,
    });
    assert.equal(progressing.loadingProgress, 0.4);
    const downloading = reduceAssemblyExplorerState(progressing, {
      type: 'setLoadingProgress',
      promptId: 1,
      phase: 'downloading',
      progress: 0.72,
    });
    assert.equal(downloading.loadingPhase, 'downloading');
    assert.equal(downloading.loadingProgress, 0.72);
    assert.equal(
      reduceAssemblyExplorerState(downloading, {
        type: 'setLoadingProgress',
        promptId: 1,
        phase: 'orchestrating',
        progress: 0.49,
      }),
      downloading,
    );
    assert.equal(
      reduceAssemblyExplorerState(downloading, {
        type: 'setLoadingProgress',
        promptId: 1,
        phase: 'downloading',
        progress: -0.5,
      }),
      downloading,
    );
    const ready = reduceAssemblyExplorerState(downloading, {
      type: 'setLoadingProgress',
      promptId: 1,
      phase: 'ready',
      progress: 2,
    });
    assert.equal(ready.loadingPhase, 'ready');
    assert.equal(ready.loadingProgress, 1);
    const loaded = reduceAssemblyExplorerState(ready, {
      type: 'loadAssemblySuccess',
      promptId: 1,
      assembly: { archetypeId: 'open_source_rover_v1' },
      glbArrayBuffer: new ArrayBuffer(0),
    });
    assert.equal(loaded.loadingPhase, 'ready');
    assert.equal(loaded.loadingProgress, 1);
    assert.equal(loaded.isLoading, false);
  });

  it('ignores superseded progress and resets the bar after a failure or new request', () => {
    const previous = reduceAssemblyExplorerState(INITIAL_ASSEMBLY_EXPLORER_STATE, {
      type: 'startLoading',
      promptId: 1,
    });
    const current = reduceAssemblyExplorerState(previous, { type: 'startLoading', promptId: 2 });
    const lateProgress = {
      type: 'setLoadingProgress',
      promptId: 1,
      phase: 'downloading',
      progress: 0.8,
    };
    assert.equal(reduceAssemblyExplorerState(current, lateProgress), current);
    const failed = reduceAssemblyExplorerState(current, {
      type: 'loadAssemblyError',
      promptId: 2,
      message: 'GLB download failed',
    });
    assert.equal(failed.loadingPhase, 'error');
    assert.equal(failed.loadingProgress, 0);
    assert.equal(failed.isLoading, false);
    assert.equal(reduceAssemblyExplorerState(failed, { ...lateProgress, promptId: 2 }), failed);
    const retry = reduceAssemblyExplorerState(failed, { type: 'startLoading', promptId: 3 });
    assert.equal(retry.loadingPhase, 'orchestrating');
    assert.equal(retry.loadingProgress, 0.12);
  });
});

describe('assembly explorer focus mode', () => {
  const initial = INITIAL_ASSEMBLY_EXPLORER_STATE;
  const motorId = toComponentId('comp_motor_fl');
  const plateId = toComponentId('comp_base_plate_upper');
  const loadAssembly = {
    type: 'loadAssemblySuccess',
    promptId: 1,
    assembly: {
      archetypeId: 'quadcopter_drone_v1',
      nodes: [
        {
          id: motorId,
          parentId: null,
          depth: 1,
          dimensionsMm: [24, 24, 20],
          restPositionMeters: [0.03125, 0.0625, 0],
          explodeDirection: [1, 0, 0],
          explodeDistanceMeters: 0.125,
        },
        {
          id: plateId,
          parentId: null,
          depth: 1,
          dimensionsMm: [120, 4, 120],
          restPositionMeters: [0, 0, 0],
          explodeDirection: [0, 1, 0],
          explodeDistanceMeters: 0.0625,
        },
      ],
    },
    glbArrayBuffer: new ArrayBuffer(0),
  };

  it('toggles between collapsed and the 65% preset and collapses a custom setting', () => {
    const toggle = { type: 'toggleExplodePreset' };
    const exploded = reduceAssemblyExplorerState(initial, toggle);
    assert.equal(exploded.explodeFactor, 0.65);
    assert.equal(reduceAssemblyExplorerState(exploded, toggle).explodeFactor, 0);
    const custom = reduceAssemblyExplorerState(initial, {
      type: 'setExplodeFactor',
      explodeFactor: 0.25,
    });
    assert.equal(reduceAssemblyExplorerState(custom, toggle).explodeFactor, 0);
  });

  it('frames the exploded part and restores the original overview after switching parts', () => {
    let overview = reduceAssemblyExplorerState(initial, loadAssembly);
    overview = reduceAssemblyExplorerState(overview, {
      type: 'orbitCamera',
      deltaAzimuthDeg: 22,
      deltaElevationDeg: 45,
    });
    overview = reduceAssemblyExplorerState(overview, {
      type: 'setExplodeFactor',
      explodeFactor: 0.25,
    });
    overview = reduceAssemblyExplorerState(overview, {
      type: 'selectComponent',
      componentId: motorId,
    });
    overview = reduceAssemblyExplorerState(overview, { type: 'toggleIsolateComponent' });
    overview = reduceAssemblyExplorerState(overview, {
      type: 'separateComponentAlongAxis',
      axis: 'z',
      deltaMeters: 0.03125,
    });

    const focused = reduceAssemblyExplorerState(overview, {
      type: 'focusComponent',
      componentId: motorId,
    });
    assert.equal(focused.explodeFactor, 0.65);
    assert.equal(focused.camera.azimuthDeg, overview.camera.azimuthDeg);
    assert.ok(focused.camera.elevationDeg >= 14 && focused.camera.elevationDeg <= 48);
    assert.ok(focused.camera.distanceMeters < overview.camera.distanceMeters / 2);
    assert.deepEqual(focused.camera.targetMeters, [0.15625, 0.0625, 0.03125]);
    assert.equal(focused.selectedComponentId, motorId);
    assert.equal(focused.isolatedComponentId, null);
    assert.deepEqual(focused.viewMode, {
      kind: 'part_focus',
      componentId: motorId,
      restoreCamera: overview.camera,
      restoreExplodeFactor: 0.25,
    });

    const adjusted = reduceAssemblyExplorerState(focused, {
      type: 'setExplodeFactor',
      explodeFactor: 0.8,
    });
    const nextPart = reduceAssemblyExplorerState(adjusted, {
      type: 'focusComponent',
      componentId: plateId,
    });
    assert.equal(nextPart.explodeFactor, 0.8);
    assert.deepEqual(nextPart.camera.targetMeters, [0, 0.0625, 0]);
    assert.ok(nextPart.camera.distanceMeters > focused.camera.distanceMeters);
    assert.equal(nextPart.selectedComponentId, plateId);
    assert.deepEqual(nextPart.viewMode, { ...focused.viewMode, componentId: plateId });

    const restored = reduceAssemblyExplorerState(nextPart, { type: 'exitPartFocus' });
    assert.deepEqual(restored.viewMode, { kind: 'overview' });
    assert.equal(restored.explodeFactor, overview.explodeFactor);
    assert.deepEqual(restored.camera, overview.camera);
    assert.equal(restored.selectedComponentId, null);
    assert.equal(restored.isolatedComponentId, null);
    assert.equal(reduceAssemblyExplorerState(restored, { type: 'exitPartFocus' }), restored);
  });

  it('starts each newly loaded assembly in overview mode', () => {
    const loaded = reduceAssemblyExplorerState(initial, loadAssembly);
    const focused = reduceAssemblyExplorerState(loaded, {
      type: 'focusComponent',
      componentId: plateId,
    });
    assert.equal(focused.viewMode.kind, 'part_focus');
    const reloaded = reduceAssemblyExplorerState(focused, { ...loadAssembly, promptId: 2 });
    assert.deepEqual(reloaded.viewMode, { kind: 'overview' });
    assert.equal(reloaded.selectedComponentId, null);
    assert.equal(reloaded.explodeFactor, 0);
    assert.deepEqual(reloaded.camera, DEFAULT_EXPLORER_CAMERA);
  });

  it('restores the overview camera target when exiting focus after a prior local camera commit', () => {
    const overviewCamera = { ...DEFAULT_EXPLORER_CAMERA, distanceMeters: 0.34 };
    const focusedCamera = {
      ...overviewCamera,
      distanceMeters: 0.2,
      targetMeters: [0.08, 0.12, -0.08],
    };

    const afterLocalCommit = reconcileCameraTarget({
      previousStateCamera: DEFAULT_EXPLORER_CAMERA,
      stateCamera: overviewCamera,
      liveCamera: overviewCamera,
      lastCommittedCamera: overviewCamera,
      modelChanged: false,
    });
    assert.equal(afterLocalCommit.externalCameraChanged, false);
    assert.equal(afterLocalCommit.nextLastCommittedCamera, null);
    assert.equal(afterLocalCommit.nextCamera, overviewCamera);

    const afterFocus = reconcileCameraTarget({
      previousStateCamera: overviewCamera,
      stateCamera: focusedCamera,
      liveCamera: overviewCamera,
      lastCommittedCamera: afterLocalCommit.nextLastCommittedCamera,
      modelChanged: false,
    });
    assert.equal(afterFocus.externalCameraChanged, true);
    assert.equal(afterFocus.nextCamera, focusedCamera);

    const afterExit = reconcileCameraTarget({
      previousStateCamera: focusedCamera,
      stateCamera: overviewCamera,
      liveCamera: focusedCamera,
      lastCommittedCamera: overviewCamera,
      modelChanged: false,
    });
    assert.equal(afterExit.externalCameraChanged, true);
    assert.equal(afterExit.nextCamera, overviewCamera);
    assert.equal(afterExit.nextLastCommittedCamera, null);
  });
});
