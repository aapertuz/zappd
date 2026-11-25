import type { Vector3Tuple } from '@/shared/domain';

type RotationRows = readonly [Vector3Tuple, Vector3Tuple, Vector3Tuple];

export function extrinsicXyzRotationRows(rotationDeg: Vector3Tuple): RotationRows {
  const [x, y, z] = rotationDeg;
  const radiansPerDegree = Math.PI / 180;
  const sx = Math.sin(x * radiansPerDegree);
  const sy = Math.sin(y * radiansPerDegree);
  const sz = Math.sin(z * radiansPerDegree);
  const cx = Math.cos(x * radiansPerDegree);
  const cy = Math.cos(y * radiansPerDegree);
  const cz = Math.cos(z * radiansPerDegree);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

export function inverseRotate(rows: RotationRows, [x, y, z]: Vector3Tuple): Vector3Tuple {
  const [first, second, third] = rows;
  return [
    first[0] * x + second[0] * y + third[0] * z,
    first[1] * x + second[1] * y + third[1] * z,
    first[2] * x + second[2] * y + third[2] * z,
  ];
}
