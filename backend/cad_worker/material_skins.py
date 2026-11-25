from __future__ import annotations

from dataclasses import dataclass, replace
from functools import lru_cache
from io import BytesIO
from typing import Callable, Literal

import numpy as np
from PIL import Image


SkinFamily = Literal[
    "carbon_weave", "brushed_metal", "composite_matte", "fdm_printed", "pcb_fr4",
    "silicone_wire", "braided_sleeve",
]
TEXTURE_SIZE = 256


@dataclass(frozen=True)
class MaterialSkinSpec:
    family: SkinFamily
    metallic: float
    roughness: float
    normal_scale: float
    tile_size_meters: float
    clearcoat: float
    clearcoat_roughness: float


@dataclass(frozen=True)
class SkinTextureSet:
    albedo_png: bytes
    normal_png: bytes
    metallic_roughness_png: bytes
    roughness_gray_png: bytes
    usd_normal_png: bytes


@dataclass(frozen=True)
class SkinChannels:
    albedo: np.ndarray
    height: np.ndarray
    roughness: np.ndarray
    metalness: np.ndarray


def srgb_channel_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def srgb_hex_to_linear_rgba(hex_color: str) -> list[float]:
    color = hex_color.removeprefix("#")
    if len(color) != 6:
        raise ValueError(f"Expected a six-digit sRGB color: {hex_color}")
    return [srgb_channel_to_linear(int(color[start : start + 2], 16) / 255.0) for start in (0, 2, 4)] + [1.0]


FAMILY_DEFAULTS: dict[SkinFamily, MaterialSkinSpec] = {
    "carbon_weave": MaterialSkinSpec("carbon_weave", 0.15, 0.42, 0.85, 0.016, 0.35, 0.28),
    "brushed_metal": MaterialSkinSpec("brushed_metal", 0.86, 0.31, 0.45, 0.032, 0.14, 0.24),
    "composite_matte": MaterialSkinSpec("composite_matte", 0.05, 0.48, 0.35, 0.024, 0.12, 0.38),
    "fdm_printed": MaterialSkinSpec("fdm_printed", 0.06, 0.55, 0.40, 0.020, 0.08, 0.45),
    "pcb_fr4": MaterialSkinSpec("pcb_fr4", 0.08, 0.52, 0.55, 0.030, 0.32, 0.28),
    "silicone_wire": MaterialSkinSpec("silicone_wire", 0.0, 0.49, 0.24, 0.008, 0.10, 0.40),
    "braided_sleeve": MaterialSkinSpec("braided_sleeve", 0.0, 0.71, 0.68, 0.012, 0.04, 0.62),
}

DEFAULT_MATERIAL_SKIN_SPEC = FAMILY_DEFAULTS["composite_matte"]
_CARBON = FAMILY_DEFAULTS["carbon_weave"]
_METAL = FAMILY_DEFAULTS["brushed_metal"]
_PRINTED = FAMILY_DEFAULTS["fdm_printed"]

MATERIAL_SKIN_REGISTRY: dict[str, MaterialSkinSpec] = {
    "carbon_fiber": _CARBON,
    "carbon_fiber_composite": _CARBON,
    "anodized_aluminum": _METAL,
    "machined_aluminum": replace(_METAL, metallic=0.88, roughness=0.29, clearcoat=0.10, clearcoat_roughness=0.22),
    "extruded_aluminum": _METAL,
    "anodized_steel": replace(_METAL, metallic=0.90, roughness=0.29),
    "stainless_steel": replace(_METAL, metallic=0.92, roughness=0.25),
    "brass": replace(_METAL, metallic=0.92, roughness=0.27, clearcoat_roughness=0.22),
    "copper_winding": replace(_METAL, metallic=0.92),
    "polycarbonate": replace(DEFAULT_MATERIAL_SKIN_SPEC, roughness=0.34, clearcoat=0.25, clearcoat_roughness=0.32),
    "fr4_pcb": FAMILY_DEFAULTS["pcb_fr4"],
    "silicone_wire": FAMILY_DEFAULTS["silicone_wire"],
    "braided_sleeve": FAMILY_DEFAULTS["braided_sleeve"],
    "li_ion_battery": replace(DEFAULT_MATERIAL_SKIN_SPEC, metallic=0.0, roughness=0.62, clearcoat=0.06, clearcoat_roughness=0.52),
    "abs_3d_printed": _PRINTED,
    "pla_3d_printed": replace(_PRINTED, roughness=0.53),
    "acetal_polymer": DEFAULT_MATERIAL_SKIN_SPEC,
    "nylon_glass_filled": replace(DEFAULT_MATERIAL_SKIN_SPEC, roughness=0.58),
    "servo_housing": replace(DEFAULT_MATERIAL_SKIN_SPEC, metallic=0.10, roughness=0.46),
    "optical_glass": replace(DEFAULT_MATERIAL_SKIN_SPEC, metallic=0.12, roughness=0.09, clearcoat=0.45, clearcoat_roughness=0.08),
}


def resolve_material_skin(material_hint: str) -> MaterialSkinSpec:
    return MATERIAL_SKIN_REGISTRY.get(material_hint, DEFAULT_MATERIAL_SKIN_SPEC)


def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _centered_noise(rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1.0, 1.0, (TEXTURE_SIZE, TEXTURE_SIZE))


def _weave_tow(coordinate: np.ndarray, repeats: int) -> np.ndarray:
    phase = (coordinate * repeats) % 1.0
    return np.sin(np.pi * phase) ** 0.38


def _carbon_weave(x: np.ndarray, y: np.ndarray) -> SkinChannels:
    column = np.floor(x * 8)
    row = np.floor(y * 8)
    warp = ((column + row) % 4) < 2
    crest = np.where(warp, _weave_tow(x, 8), _weave_tow(y, 8))
    tow_phase = np.where(warp, (column + y * 8) % 4, (x * 8 + row) % 4 - 2)
    end = np.sin(np.pi * tow_phase / 2) ** 0.38
    fiber_axis = np.where(warp, x, y)
    fiber = 0.5 + 0.5 * np.cos(2.0 * np.pi * fiber_axis * 80)
    tow = crest * (0.40 + 0.60 * end)
    albedo = 0.75 + (0.11 + 0.09 * warp) * tow + crest * (0.06 + 0.045 * fiber)
    height = 3.8 * tow + 0.20 * crest * fiber
    return SkinChannels(albedo, height, 0.99 - 0.32 * tow, 0.94 + 0.06 * tow)


def _brushed_metal(x: np.ndarray, y: np.ndarray) -> SkinChannels:
    rng = _rng(17)
    rows = rng.uniform(-1.0, 1.0, (TEXTURE_SIZE, 1))
    rows = (2 * rows + np.roll(rows, 1, axis=0) + np.roll(rows, -1, axis=0)) / 4
    streaks = rows * (0.68 + 0.32 * np.sin(2 * np.pi * (2 * x + 9 * y)))
    pitting = _centered_noise(rng)
    albedo = 0.963 + 0.032 * streaks + 0.013 * pitting
    height = 0.42 * streaks + 0.075 * pitting
    return SkinChannels(albedo, height, 0.91 - 0.11 * streaks + 0.02 * pitting, np.ones_like(x))


def _composite_matte(x: np.ndarray, _y: np.ndarray) -> SkinChannels:
    grain = _centered_noise(_rng(23))
    stipple = (grain + np.roll(grain, 1, axis=0) + np.roll(grain, 1, axis=1)) / 3.0
    return SkinChannels(0.96 + 0.035 * stipple, 0.29 * stipple, 0.93 + 0.07 * stipple, np.ones_like(x))


def _fdm_printed(x: np.ndarray, y: np.ndarray) -> SkinChannels:
    grain = _centered_noise(_rng(31))
    layer = np.cos(2 * np.pi * (48 * y + 0.075 * np.sin(4 * np.pi * x)))
    ridge = (0.5 + 0.5 * layer) ** 0.65
    return SkinChannels(
        0.935 + 0.052 * ridge + 0.010 * grain,
        0.45 * ridge + 0.045 * grain,
        0.99 - 0.13 * ridge,
        np.ones_like(x),
    )


def _pcb_fr4(x: np.ndarray, y: np.ndarray) -> SkinChannels:
    warp = ((np.floor(x * 16) + np.floor(y * 16)) % 2) == 0
    weave = np.where(warp, _weave_tow(x, 16), _weave_tow(y, 16))
    trace_x = (x * 6 + 0.17) % 1.0
    trace_y = (y * 6 + 0.23) % 1.0
    traces = ((abs(trace_x - 0.5) < 0.030) & (trace_y < 0.52)) | (
        (abs(trace_y - 0.5) < 0.032) & (trace_x > 0.50)
    )
    via_distance = np.hypot(trace_x - 0.5, trace_y - 0.5)
    vias = (via_distance > 0.045) & (via_distance < 0.095)
    albedo = np.repeat((0.92 + 0.04 * weave + 0.025 * traces)[..., None], 3, axis=2)
    albedo[vias] = (1.0, 0.94, 0.85)
    return SkinChannels(
        albedo,
        0.19 * weave + 0.26 * traces + 0.50 * vias,
        0.98 - 0.09 * weave - 0.06 * traces - 0.15 * vias,
        0.95 + 0.025 * traces + 0.05 * vias,
    )


def _silicone_wire(x: np.ndarray, y: np.ndarray) -> SkinChannels:
    grain = np.cos(2 * np.pi * (46 * y + 0.06 * np.sin(4 * np.pi * x)))
    grain = 0.7 * grain + 0.3 * _centered_noise(_rng(37))
    return SkinChannels(0.977 + 0.015 * grain, 0.10 * grain, 0.94 + 0.04 * grain, np.zeros_like(x))


def _braided_sleeve(x: np.ndarray, y: np.ndarray) -> SkinChannels:
    diagonal = x + y
    crossed = x - y
    over = ((np.floor(diagonal * 9) + np.floor(crossed * 9)) % 2) == 0
    tow = np.where(over, _weave_tow(diagonal, 9), _weave_tow(crossed, 9))
    filament = np.cos(2 * np.pi * 63 * np.where(over, diagonal, crossed))
    fiber = tow * (0.87 + 0.13 * filament)
    return SkinChannels(0.70 + 0.25 * fiber, 2.2 * tow + 0.16 * fiber, 0.98 - 0.16 * fiber, np.zeros_like(x))


_TEXTURE_PATTERNS: dict[SkinFamily, Callable[[np.ndarray, np.ndarray], SkinChannels]] = {
    "carbon_weave": _carbon_weave,
    "brushed_metal": _brushed_metal,
    "composite_matte": _composite_matte,
    "fdm_printed": _fdm_printed,
    "pcb_fr4": _pcb_fr4,
    "silicone_wire": _silicone_wire,
    "braided_sleeve": _braided_sleeve,
}


def _png(channels: np.ndarray) -> bytes:
    raw = np.rint(np.clip(channels, 0.0, 1.0) * 255.0).astype(np.uint8)
    with BytesIO() as buffer:
        Image.fromarray(raw).save(buffer, format="PNG", optimize=True)
        return buffer.getvalue()


def _height_to_normal(height: np.ndarray, x_scale: float, y_scale: float) -> np.ndarray:
    dx = (np.roll(height, 1, axis=1) - np.roll(height, -1, axis=1)) * 0.5
    dy = (np.roll(height, 1, axis=0) - np.roll(height, -1, axis=0)) * 0.5
    normal = np.stack((dx * x_scale, dy * y_scale, np.ones_like(height)), axis=2)
    return 0.5 + 0.5 * normal / np.linalg.norm(normal, axis=2, keepdims=True)


@lru_cache(maxsize=len(FAMILY_DEFAULTS))
def build_skin_texture_set(family: SkinFamily) -> SkinTextureSet:
    coordinates = (np.arange(TEXTURE_SIZE) + 0.5) / TEXTURE_SIZE
    x, y = np.meshgrid(coordinates, coordinates)
    channels = _TEXTURE_PATTERNS[family](x, y)
    skin = FAMILY_DEFAULTS[family]
    albedo = channels.albedo
    if albedo.ndim == 2:
        albedo = np.repeat(albedo[..., None], 3, axis=2)
    albedo_srgb = 1.055 * np.power(np.minimum(albedo, 1.0), 1.0 / 2.4) - 0.055
    return SkinTextureSet(
        albedo_png=_png(albedo_srgb),
        normal_png=_png(_height_to_normal(channels.height, 1.0, 1.0)),
        metallic_roughness_png=_png(np.stack((np.ones_like(x), channels.roughness, channels.metalness), axis=2)),
        roughness_gray_png=_png(skin.roughness * channels.roughness),
        usd_normal_png=_png(_height_to_normal(channels.height, skin.normal_scale, -skin.normal_scale)),
    )
