import * as THREE from 'three';

import { type Vector3Tuple } from '@/shared/domain';

export function materialTextures(material: THREE.Material): THREE.Texture[] {
  return Object.values(material).filter(
    (value): value is THREE.Texture => value instanceof THREE.Texture,
  );
}

function hasGeometry(object: THREE.Object3D): object is THREE.Mesh | THREE.Line {
  return object instanceof THREE.Mesh || object instanceof THREE.Line;
}

export function disposeObjectSubtree(
  root: THREE.Object3D,
  sharedEnvironment?: THREE.Texture,
): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();

  root.traverse((object) => {
    if (!hasGeometry(object)) return;
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

export function configureCadStudioRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
}

export function createCadStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const generator = new THREE.PMREMGenerator(renderer);
  const studio = createStudioEnvironmentScene();
  try {
    return generator.fromScene(studio, 0.04);
  } finally {
    disposeObjectSubtree(studio);
    generator.dispose();
  }
}

export function addCadStudioLights(scene: THREE.Scene) {
  const hemisphericLight = new THREE.HemisphereLight('#e6edf7', '#29241e', 0.65);
  const keyLight = new THREE.DirectionalLight('#f8fafc', 1.9);
  const fillLight = new THREE.DirectionalLight('#cbd5e1', 0.75);
  const rimLight = new THREE.DirectionalLight('#fde68a', 1.35);
  scene.add(
    hemisphericLight,
    keyLight,
    keyLight.target,
    fillLight,
    fillLight.target,
    rimLight,
    rimLight.target,
  );
  return { keyLight, fillLight, rimLight };
}

export function positionCadStudioLights(
  { keyLight, fillLight, rimLight }: ReturnType<typeof addCadStudioLights>,
  [x, y, z]: Vector3Tuple,
  scale: number,
): void {
  keyLight.position.set(x + 0.8 * scale, y + 1.6 * scale, z + 1.1 * scale);
  fillLight.position.set(x - 0.95 * scale, y + 0.65 * scale, z + 0.55 * scale);
  rimLight.position.set(x + scale, y + 0.85 * scale, z - 0.95 * scale);
  for (const light of [keyLight, fillLight, rimLight]) light.target.position.set(x, y, z);
}

export const CAD_PREVIEW_INITIAL_ANGLE = 0.58;

export function createCadStudioTurntable(renderer: THREE.WebGLRenderer) {
  configureCadStudioRenderer(renderer);
  const scene = new THREE.Scene();
  const environment = createCadStudioEnvironment(renderer);
  scene.environment = environment.texture;
  const lights = addCadStudioLights(scene);
  const pivot = new THREE.Group();
  scene.add(pivot);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100);
  const elevation = 0.37;
  let size = new THREE.Vector3();
  let model: THREE.Object3D | null = null;

  function clearModel() {
    if (model === null) return;
    pivot.remove(model);
    disposeObjectSubtree(model);
    model = null;
  }

  function setModel(next: THREE.Object3D) {
    clearModel();
    const centeredModel = new THREE.Group();
    const bounds = new THREE.Box3().setFromObject(next);
    centeredModel.position.copy(bounds.getCenter(new THREE.Vector3()).negate());
    centeredModel.add(next);
    model = centeredModel;
    pivot.add(centeredModel);
    size = bounds.getSize(new THREE.Vector3());
    const radius = size.length() || 1;
    camera.position.set(0, radius * Math.sin(elevation), radius * Math.cos(elevation));
    camera.lookAt(0, 0, 0);
    camera.near = radius * 0.025;
    camera.far = radius * 3;
    positionCadStudioLights(lights, [0, 0, 0], Math.max(size.x, size.y, size.z) / 0.3);
  }

  function render(angle: number, aspect: number) {
    const radialExtent = Math.hypot(size.x, size.z) / 2;
    const height = (size.y / 2) * Math.cos(elevation) + radialExtent * Math.sin(elevation);
    const halfHeight = Math.max(height, radialExtent / aspect) * 1.06;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    pivot.rotation.y = angle;
    renderer.render(scene, camera);
  }

  return {
    setModel,
    clearModel,
    render,
    dispose() {
      clearModel();
      environment.dispose();
    },
  };
}
