import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Box3, PerspectiveCamera, Vector3 } from 'three';

import { toComponentId } from '../../../shared/domain/assembly.ts';
import { CATALOG_ARCHETYPES, getCatalogArchetypeById } from '../../../shared/domain/catalog.ts';
import { computePartCalloutRect } from '../model/calloutPlacement.ts';
import {
  computeAssemblyBoundingBoxMeters,
  computeCameraZoomLimits,
  computeCircuitComponentIds,
  computeDefaultCameraForAssembly,
  computeFocusedCameraForComponent,
  DEFAULT_EXPLORER_CAMERA,
  INITIAL_ASSEMBLY_EXPLORER_STATE,
  reconcileCameraTarget,
  reduceAssemblyExplorerState,
  zoomExplorerCamera,
} from '../model/explorerState.ts';

const syntheticRootId = toComponentId('synthetic_root');
function syntheticAssembly(dimensionsMm, restPositionMeters = [0, 0, 0]) {
  return {
    rootNodeId: syntheticRootId,
    nodes: [
      {
        id: syntheticRootId,
        level: 'project',
        parentId: null,
        depth: 0,
        dimensionsMm,
        restPositionMeters,
        explodeDirection: [0, 0, 0],
        explodeDistanceMeters: 0,
      },
    ],
  };
}

function assertProjectedFill(bounds, framing, { width, height, fov, maxX, maxY }) {
  const camera = new PerspectiveCamera(fov, width / height, 0.0001, 100);
  const azimuth = (framing.azimuthDeg * Math.PI) / 180;
  const elevation = (framing.elevationDeg * Math.PI) / 180;
  const target = new Vector3(...framing.targetMeters);
  camera.position
    .setFromSphericalCoords(framing.distanceMeters, Math.PI / 2 - elevation, azimuth)
    .add(target);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  const box = new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max));
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const corner = new Vector3(x, y, z).project(camera);
        assert.ok(Math.abs(corner.x) <= maxX + 1e-9, `corner X ${corner.x} exceeds ${maxX}`);
        assert.ok(Math.abs(corner.y) <= maxY + 1e-9, `corner Y ${corner.y} exceeds ${maxY}`);
        assert.ok(Math.abs(corner.z) < 1);
      }
    }
  }
}

describe('geometry-driven camera framing', () => {
  it('uses physical leaves and handles missing leaves, root-only geometry, and zero size', () => {
    const assembly = syntheticAssembly([10000, 10000, 10000]);
    const child = {
      id: toComponentId('synthetic_child'),
      parentId: syntheticRootId,
      level: 'subsystem',
      dimensionsMm: [250, 500, 1000],
      restPositionMeters: [1, 2, 3],
    };
    const sibling = {
      ...child,
      id: toComponentId('synthetic_sibling'),
      restPositionMeters: [-1, 2, 4],
    };
    const expected = {
      min: [-1.125, 1.75, 2.5],
      max: [1.125, 2.25, 4.5],
      center: [0, 2, 3.5],
      size: [2.25, 0.5, 2],
    };
    assert.deepEqual(
      computeAssemblyBoundingBoxMeters({ ...assembly, nodes: [...assembly.nodes, child, sibling] }),
      expected,
    );
    assert.deepEqual(
      computeAssemblyBoundingBoxMeters({
        ...assembly,
        nodes: [
          ...assembly.nodes,
          { ...child, level: 'component', dimensionsMm: [4000, 4000, 4000] },
          {
            ...child,
            id: toComponentId('synthetic_leaf'),
            parentId: child.id,
            level: 'subcomponent',
          },
          { ...sibling, level: 'component' },
        ],
      }),
      expected,
    );
    assert.deepEqual(
      computeAssemblyBoundingBoxMeters(syntheticAssembly([0, 0, 0])).size,
      [0.001, 0.001, 0.001],
    );
    assert.deepEqual(
      computeAssemblyBoundingBoxMeters({ ...assembly, nodes: [] }).center,
      [0, 0, 0],
    );
  });

  const catalogDistanceBounds = {
    reachy_mini_v1: [1.25, 1.4],
  };

  for (const [name, assembly, minDistance, maxDistance] of [
    ...CATALOG_ARCHETYPES.map((assembly) => [
      assembly.archetypeId,
      assembly,
      ...(catalogDistanceBounds[assembly.archetypeId] ?? [0.6, 1.25]),
    ]),
    ['tall 10:1', syntheticAssembly([60, 600, 60], [0.02, 0.4, 0.1]), 1.5, 2],
    ['wide 10:1', syntheticAssembly([800, 80, 120]), 1.5, 2.2],
    ['25 mm micro', syntheticAssembly([25, 25, 25]), 0.075, 0.13],
    ['2.4 m large', syntheticAssembly([2400, 2400, 2400]), 10, 12],
  ]) {
    it(`frames ${name} within both viewports`, () => {
      const bounds = computeAssemblyBoundingBoxMeters(assembly);
      const framing = computeDefaultCameraForAssembly(assembly);
      assert.deepEqual(framing.targetMeters, bounds.center);
      assert.equal(framing.azimuthDeg, 38);
      assert.equal(framing.elevationDeg, 26);
      assert.ok(
        framing.distanceMeters >= minDistance && framing.distanceMeters <= maxDistance,
        `${name} frames at ${framing.distanceMeters} meters`,
      );
      assertProjectedFill(bounds, framing, {
        width: 1280,
        height: 800,
        fov: 40,
        maxX: 0.5,
        maxY: 0.5,
      });
      assertProjectedFill(bounds, framing, {
        width: 390,
        height: 844,
        fov: (360 / Math.PI) * Math.atan(Math.tan((17 * Math.PI) / 180) / (390 / 844)),
        maxX: 0.72,
        maxY: 0.5,
      });
    });
  }

  it('frames focused parts using their own size across tiny, catalog, and large assemblies', () => {
    function focus(assembly, componentId, camera) {
      return computeFocusedCameraForComponent(assembly, componentId, 0, camera, {}, 'all');
    }
    const tiny = syntheticAssembly([5, 5, 5], [0.01, 0.02, 0.03]);
    const large = syntheticAssembly([2400, 2400, 2400]);
    const child = {
      ...tiny.nodes[0],
      id: toComponentId('test_part'),
      parentId: large.rootNodeId,
      level: 'component',
      depth: 1,
    };
    const wideChild = { ...child, dimensionsMm: [600, 600, 600] };
    const tinyFocus = focus(tiny, tiny.rootNodeId, DEFAULT_EXPLORER_CAMERA);
    assert.ok(tinyFocus.distanceMeters >= 0.025 && tinyFocus.distanceMeters < 0.04);
    assert.deepEqual(tinyFocus.targetMeters, child.restPositionMeters);
    assert.deepEqual(
      focus({ ...large, nodes: [...large.nodes, child] }, child.id, {
        ...DEFAULT_EXPLORER_CAMERA,
        distanceMeters: 9,
      }),
      tinyFocus,
    );
    const largeFocus = focus({ ...large, nodes: [...large.nodes, wideChild] }, child.id, {
      ...DEFAULT_EXPLORER_CAMERA,
      distanceMeters: 9,
    });
    assert.ok(largeFocus.distanceMeters > Math.hypot(0.3, 0.3, 0.3));
    assertProjectedFill(
      computeAssemblyBoundingBoxMeters(
        syntheticAssembly(wideChild.dimensionsMm, child.restPositionMeters),
      ),
      largeFocus,
      { width: 1280, height: 800, fov: 40, maxX: 0.4, maxY: 0.4 },
    );

    const drone = CATALOG_ARCHETYPES.find(
      ({ archetypeId }) => archetypeId === 'quadcopter_drone_v1',
    );
    const overview = computeDefaultCameraForAssembly(drone);
    const motor = focus(drone, toComponentId('comp_motor_fl'), overview);
    const plate = focus(drone, toComponentId('comp_base_plate_upper'), overview);
    assert.ok(motor.distanceMeters < plate.distanceMeters);
    assert.ok(motor.distanceMeters < overview.distanceMeters / 2);
  });

  it('scales zoom across assembly sizes and keeps the default standalone bounds', () => {
    const tiny = syntheticAssembly([25, 25, 25]);
    const large = syntheticAssembly([2400, 2400, 2400]);
    const overview = computeDefaultCameraForAssembly(large);
    const tinyLimits = computeCameraZoomLimits(tiny);
    const largeLimits = computeCameraZoomLimits(large);
    assert.ok(Math.abs(tinyLimits.minDistanceMeters - 0.00375) < 1e-9);
    assert.equal(tinyLimits.maxDistanceMeters, 1.8);
    assert.equal(largeLimits.minDistanceMeters, 0.08);
    assert.equal(largeLimits.maxDistanceMeters, overview.distanceMeters * 3.5);
    assert.equal(
      zoomExplorerCamera(overview, 0.25, largeLimits).distanceMeters,
      overview.distanceMeters + 0.25,
    );
    assert.equal(zoomExplorerCamera(overview, 10).distanceMeters, 1.8);
    assert.equal(zoomExplorerCamera(overview, -100).distanceMeters, 0.08);
  });
});

describe('part name callout placement', () => {
  const labelSize = { width: 128, height: 34 };

  for (const [viewport, anchor, obstacles] of [
    [
      { width: 1280, height: 800 },
      [620, 430],
      [
        { x: 850, y: 20, width: 410, height: 44 },
        { x: 62, y: 280, width: 344, height: 256 },
        { x: 670, y: 302, width: 344, height: 216 },
        { x: 0, y: 688, width: 1280, height: 112 },
      ],
    ],
    [
      { width: 390, height: 844 },
      [200, 416],
      [
        { x: 96, y: 20, width: 282, height: 44 },
        { x: 16, y: 118, width: 344, height: 221 },
        { x: 24, y: 504, width: 344, height: 220 },
        { x: 0, y: 732, width: 390, height: 112 },
      ],
    ],
  ]) {
    it(`places the label clear of the HUD, learning cards and composer at ${viewport.width}×${viewport.height}`, () => {
      const rect = computePartCalloutRect({ anchor, labelSize, viewport, obstacles });
      assert.ok(rect);
      assert.ok(rect.x >= 16 && rect.y >= 16);
      assert.ok(rect.x + rect.width <= viewport.width - 16);
      assert.ok(rect.y + rect.height <= viewport.height - 16);
      for (const { x, y, width, height } of obstacles) {
        assert.ok(
          rect.x >= x + width ||
            rect.x + rect.width <= x ||
            rect.y >= y + height ||
            rect.y + rect.height <= y,
        );
      }
    });
  }

  it('prefers upper-right when available and hides the label when no position fits', () => {
    const viewport = { width: 390, height: 844 };
    const anchor = [175, 422];
    const preferred = computePartCalloutRect({ anchor, labelSize, viewport, obstacles: [] });
    assert.ok(preferred.x > anchor[0] && preferred.y + preferred.height < anchor[1]);
    assert.equal(
      computePartCalloutRect({
        anchor,
        labelSize,
        viewport,
        obstacles: [{ x: 0, y: 0, ...viewport }],
      }),
      null,
    );
  });
});

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

describe('wiring visibility', () => {
  it('cycles through auto, show, and hide', () => {
    let state = INITIAL_ASSEMBLY_EXPLORER_STATE;
    assert.equal(state.wiringVisibility, 'auto');
    for (const mode of ['show', 'hide', 'auto']) {
      state = reduceAssemblyExplorerState(state, { type: 'cycleWiringVisibility' });
      assert.equal(state.wiringVisibility, mode);
    }
  });

  it('sets a mode directly and resets to auto when an assembly loads', () => {
    const state = reduceAssemblyExplorerState(INITIAL_ASSEMBLY_EXPLORER_STATE, {
      type: 'setWiringVisibility',
      mode: 'hide',
    });
    assert.equal(state.wiringVisibility, 'hide');
    const loaded = reduceAssemblyExplorerState(state, {
      type: 'loadAssemblySuccess',
      promptId: 1,
      assembly: CATALOG_ARCHETYPES[0],
      glbArrayBuffer: new ArrayBuffer(0),
    });
    assert.equal(loaded.wiringVisibility, 'auto');
  });
});

describe('electrical circuits', () => {
  const cases = [
    [
      'robotic_arm_3dof_v1',
      'comp_base_servo',
      [
        'comp_base_servo',
        'comp_waveshare_bus_adapter',
        'comp_shoulder_servo',
        'comp_so100_cable_bus_1',
        'comp_so100_cable_bus_2',
      ],
    ],
    [
      'robotic_arm_3dof_v1',
      'comp_so100_cable_bus_1',
      ['comp_so100_cable_bus_1', 'comp_waveshare_bus_adapter', 'comp_base_servo'],
    ],
    [
      'quadcopter_drone_v1',
      'comp_quad_flight_controller',
      [
        'comp_quad_flight_controller',
        'comp_quad_4in1_esc',
        'comp_quad_elrs_receiver',
        'comp_quad_cable_fc_esc',
        'comp_quad_cable_rx_fc',
      ],
    ],
    [
      'quadcopter_drone_v1',
      'comp_quad_battery_pack',
      ['comp_quad_battery_pack', 'comp_quad_4in1_esc', 'comp_quad_cable_battery_esc'],
    ],
    ['quadcopter_drone_v1', 'subcomp_standoff_1', []],
    [
      'open_source_rover_v1',
      'comp_nova2_cable_zed_usb',
      ['comp_nova2_cable_zed_usb', 'comp_zed2i_stereo_camera', 'comp_nova2_jetson_carrier'],
    ],
    [
      'open_source_rover_v1',
      'comp_steering_servo_left',
      ['comp_steering_servo_left', 'comp_nova2_jetson_carrier', 'comp_nova2_cable_servo_left'],
    ],
    ['open_source_rover_v1', 'comp_rover_base_plate', []],
  ];

  for (const [archetypeId, componentId, expectedIds] of cases) {
    it(`traces ${componentId} in ${archetypeId}`, () => {
      const assembly = getCatalogArchetypeById(archetypeId);
      assert.ok(assembly.nodes.some(({ id }) => id === componentId));
      assert.deepEqual(computeCircuitComponentIds(assembly, componentId), new Set(expectedIds));
    });
  }

  it('follows direct electrical links to and from a wiring node', () => {
    const assembly = getCatalogArchetypeById('quadcopter_drone_v1');
    const battery = 'comp_quad_battery_pack';
    const cable = 'comp_quad_cable_battery_esc';
    const esc = 'comp_quad_4in1_esc';
    const receiver = 'comp_quad_elrs_receiver';
    const directRelationship = {
      id: 'rel_direct_cable_receiver',
      fromComponentId: cable,
      toComponentId: receiver,
      connectionType: 'electrical_bus',
    };
    const withDirectLink = {
      ...assembly,
      relationships: [...assembly.relationships, directRelationship],
    };
    assert.deepEqual(
      computeCircuitComponentIds(withDirectLink, cable),
      new Set([cable, battery, esc, receiver]),
    );
    assert.deepEqual(
      computeCircuitComponentIds({ ...assembly, relationships: [directRelationship] }, receiver),
      new Set([receiver, cable]),
    );
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
      assembly: syntheticAssembly([200, 150, 180]),
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
    assert.equal(focused.isolatedComponentId, motorId);
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
    assert.equal(nextPart.isolatedComponentId, plateId);
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
    assert.equal(reloaded.isolatedComponentId, null);
    assert.equal(reloaded.explodeFactor, 0);
    assert.deepEqual(reloaded.camera, computeDefaultCameraForAssembly(loadAssembly.assembly));
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
