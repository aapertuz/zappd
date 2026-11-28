import assert from 'node:assert/strict';
import { it } from 'node:test';

import * as THREE from 'three';

import { resolveRenderQuality } from '../renderer/renderQuality.web.ts';

function modelWithTriangles(triangleCount, indexed) {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  if (indexed) {
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangleCount * 3), 1));
  } else {
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(triangleCount * 9), 3),
    );
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.userData.componentId = 'poppy_head';
  root.add(mesh);
  return { root, mesh, geometry };
}

it('keeps full studio quality for smaller models', () => {
  const { root } = modelWithTriangles(500_000, true);
  assert.deepEqual(resolveRenderQuality(root), {
    triangleCount: 500_000,
    maxPixelRatio: 2,
    shadows: true,
    edges: true,
  });
});

for (const indexed of [true, false]) {
  it(`bounds decorative rendering for Poppy complexity (${indexed ? 'indexed' : 'nonindexed'})`, () => {
    const { root, mesh, geometry } = modelWithTriangles(1_916_363, indexed);
    const material = mesh.material;
    assert.deepEqual(resolveRenderQuality(root), {
      triangleCount: 1_916_363,
      maxPixelRatio: 1,
      shadows: false,
      edges: false,
    });
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(mesh.userData.componentId, 'poppy_head');
    assert.equal(root.children[0], mesh);
  });
}
