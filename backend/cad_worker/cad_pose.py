from __future__ import annotations

from math import degrees, radians

import numpy as np
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.gp import gp_Extrinsic_XYZ, gp_Quaternion, gp_Trsf, gp_Vec
from OCP.TopoDS import TopoDS_Shape

_IDENTITY_ROTATION = (0.0, 0.0, 0.0)
_ORIGIN = (0.0, 0.0, 0.0)
_WORLD_TO_CAD = gp_Quaternion()
_WORLD_TO_CAD.SetEulerAngles(gp_Extrinsic_XYZ, radians(90), 0.0, 0.0)


def world_rest_to_cad_mm(rest_m) -> tuple[float, float, float]:
    x, y, z = rest_m
    return (x * 1000.0, -z * 1000.0, y * 1000.0)


def world_rotation(rotation_deg) -> gp_Quaternion:
    quaternion = gp_Quaternion()
    quaternion.SetEulerAngles(gp_Extrinsic_XYZ, *(radians(angle) for angle in rotation_deg))
    return quaternion


def rotate_vector(quaternion: gp_Quaternion, vector) -> np.ndarray:
    rotated = quaternion.Multiply(gp_Vec(*vector))
    return np.asarray((rotated.X(), rotated.Y(), rotated.Z()))


def node_transform(node: dict) -> gp_Trsf:
    rotation = world_rotation(node.get("restRotationDeg", _IDENTITY_ROTATION))
    transform = gp_Trsf()
    transform.SetRotation(_WORLD_TO_CAD.Multiplied(rotation).Multiplied(_WORLD_TO_CAD.Inverted()))
    transform.SetTranslationPart(gp_Vec(*world_rest_to_cad_mm(node["restPositionMeters"])))
    return transform


def place_shape(shape: TopoDS_Shape, node: dict) -> TopoDS_Shape:
    return BRepBuilderAPI_Transform(shape, node_transform(node), True).Shape()


def local_pose(node: dict, parent: dict | None) -> tuple[list[float], gp_Quaternion, list[float] | None]:
    parent = parent or {}
    parent_rotation = parent.get("restRotationDeg")
    rotation = node.get("restRotationDeg")
    delta = np.subtract(node["restPositionMeters"], parent.get("restPositionMeters", _ORIGIN))
    local_rotation = world_rotation(rotation or _IDENTITY_ROTATION)
    if parent_rotation:
        inverse_parent = world_rotation(parent_rotation).Inverted()
        delta = rotate_vector(inverse_parent, delta)
        local_rotation = inverse_parent.Multiplied(local_rotation)
        rotation = [degrees(angle) for angle in local_rotation.GetEulerAngles(gp_Extrinsic_XYZ)]
    return [round(float(axis), 9) for axis in delta], local_rotation, rotation
