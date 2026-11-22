import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toComponentId } from '../../../shared/domain/assembly.ts';
import {
  DEFAULT_EXPLORER_CAMERA,
  INITIAL_ASSEMBLY_EXPLORER_STATE,
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
