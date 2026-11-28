import * as THREE from 'three';

export function resolveRenderQuality(root: THREE.Object3D) {
  let triangleCount = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry: unknown = object.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    const position: unknown = geometry.getAttribute('position');
    const vertexCount =
      position instanceof THREE.BufferAttribute ||
      position instanceof THREE.InterleavedBufferAttribute
        ? position.count
        : 0;
    triangleCount += (geometry.index?.count ?? vertexCount) / 3;
  });
  const highComplexity = triangleCount > 500_000;
  return {
    triangleCount,
    maxPixelRatio: highComplexity ? 1 : 2,
    shadows: !highComplexity,
    edges: !highComplexity,
  };
}
