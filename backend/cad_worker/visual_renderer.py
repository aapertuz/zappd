from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image

from cad_pose import rotate_vector, world_rotation

if TYPE_CHECKING:
    from geometry_pipeline import MeshGeometry

_VIEWS = (
    ("ISO", (1, 0.85, 1.25), (0, 1, 0)),
    ("Front", (0, 0, 1), (0, 1, 0)),
    ("Side", (1, 0, 0), (0, 1, 0)),
    ("Top", (0, 1, 0), (0, 0, -1)),
)


def render_contact_sheet(nodes: list[dict], meshes: dict[str, MeshGeometry], output_path: Path) -> Path:
    import vtk
    from vtk.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray

    if not meshes:
        raise RuntimeError("Contact sheet requires rendered CAD geometry")
    actors = []
    for node in nodes:
        geometry = meshes.get(node["id"])
        if geometry is None:
            continue
        rotation = world_rotation(node.get("restRotationDeg", (0, 0, 0)))
        basis = np.array([rotate_vector(rotation, axis) for axis in np.eye(3)])
        for primitive in geometry.primitives or (geometry,):
            vertices = primitive.vertices @ basis + node["restPositionMeters"]
            points = vtk.vtkPoints()
            points.SetData(numpy_to_vtk(np.ascontiguousarray(vertices), deep=True))
            cells = vtk.vtkCellArray()
            triangles = primitive.indices.astype(np.int64)
            cells.SetData(numpy_to_vtkIdTypeArray(np.arange(0, len(triangles) + 1, 3), deep=True),
                          numpy_to_vtkIdTypeArray(triangles, deep=True))
            polydata = vtk.vtkPolyData()
            polydata.SetPoints(points)
            polydata.SetPolys(cells)
            normals = numpy_to_vtk(np.ascontiguousarray(primitive.normals @ basis), deep=True)
            polydata.GetPointData().SetNormals(normals)
            mapper = vtk.vtkPolyDataMapper()
            mapper.SetInputData(polydata)
            actor = vtk.vtkActor()
            actor.SetMapper(mapper)
            color = getattr(primitive, "color_hex", None) or node["colorHex"]
            actor.GetProperty().SetColor(*(int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)))
            actor.GetProperty().SetAmbient(0.33)
            actor.GetProperty().SetDiffuse(0.67)
            actor.GetProperty().SetSpecular(0.12)
            actor.GetProperty().SetSpecularPower(24)
            actors.append(actor)

    window = vtk.vtkRenderWindow()
    window.SetOffScreenRendering(1)
    window.SetSize(1200, 900)
    window.SetMultiSamples(8)
    try:
        for index, (title, direction, up) in enumerate(_VIEWS):
            renderer = vtk.vtkRenderer()
            col, row = index % 2, 1 - index // 2
            renderer.SetViewport(col / 2, row / 2, (col + 1) / 2, (row + 1) / 2)
            renderer.SetBackground(0.91, 0.93, 0.95)
            renderer.SetBackground2(0.98, 0.98, 0.99)
            renderer.GradientBackgroundOn()
            for actor in actors:
                renderer.AddActor(actor)
            camera = renderer.GetActiveCamera()
            camera.SetPosition(*direction)
            camera.SetFocalPoint(0, 0, 0)
            camera.SetViewUp(*up)
            camera.ParallelProjectionOn()
            renderer.ResetCamera()
            camera.Zoom(1.1)
            renderer.ResetCameraClippingRange()
            label = vtk.vtkTextActor()
            label.SetInput(title)
            label.SetPosition(23, 20)
            label.GetTextProperty().SetFontFamilyToArial()
            label.GetTextProperty().SetFontSize(18)
            label.GetTextProperty().SetBold(True)
            label.GetTextProperty().SetColor(0.22, 0.26, 0.32)
            renderer.AddViewProp(label)
            window.AddRenderer(renderer)
        window.Render()
        capture = vtk.vtkWindowToImageFilter()
        capture.SetInput(window)
        capture.ReadFrontBufferOff()
        capture.Update()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        writer = vtk.vtkPNGWriter()
        writer.SetFileName(str(output_path))
        writer.SetInputConnection(capture.GetOutputPort())
        writer.Write()
    finally:
        window.Finalize()

    with Image.open(output_path) as image:
        pixels = np.asarray(image.convert("RGB"))
        if image.size != (1200, 900) or any(
            np.std(pixels[y:y + 450, x:x + 600], axis=(0, 1)).max() < 5
            for y in (0, 450) for x in (0, 600)
        ):
            raise RuntimeError(f"Insufficient rendered CAD content in {output_path}")
    return output_path
