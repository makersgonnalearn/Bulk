"""
Core vectorization pipeline.
Converts a raster image (PNG/JPG/WebP) to a clean SVG with:
- Background removal
- Smooth Bezier curves (not polygons)
- One compound path per color
- Color clustering to eliminate anti-aliasing artifacts

Requires Python 3.13 (vtracer segfaults on 3.14 with keyword args).
"""

import io
import re
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import vtracer
from PIL import Image


# --- vtracer settings (tested and verified) ---
VTRACER_PARAMS = {
    "colormode": "color",
    "mode": "spline",
    "corner_threshold": 120,
    "length_threshold": 3.5,
    "splice_threshold": 90,
    "max_iterations": 30,
    "filter_speckle": 8,
    "color_precision": 4,
    "layer_difference": 16,
}

COLOR_CLUSTER_DISTANCE = 50
COLOR_CLUSTER_DISTANCE_COMPLEX = 30
COMPLEX_IMAGE_COLOR_BINS = 50
MAX_COLORS = 6
MIN_UPSCALE_PX = 2500
BG_SAMPLE_TOLERANCE = 30


def _hex_to_rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], dtype=float)


def _rgb_to_hex(rgb) -> str:
    return "#{:02X}{:02X}{:02X}".format(int(rgb[0]), int(rgb[1]), int(rgb[2]))


def _image_to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def upscale(img: Image.Image, min_px: int = MIN_UPSCALE_PX) -> Image.Image:
    """Upscale so the longest side is at least min_px. Preserves aspect ratio."""
    w, h = img.size
    longest = max(w, h)
    if longest >= min_px:
        return img
    scale = min_px / longest
    return img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)


def remove_background(img: Image.Image, tolerance: int = BG_SAMPLE_TOLERANCE) -> Image.Image:
    """
    Remove background by flood-filling from edges.
    Samples corner and edge-midpoint pixels to detect background color.
    Uses BFS from all border pixels to fill connected background with transparency.
    Interior regions of the same color are preserved (can't reach them through shapes).
    """
    img = img.convert("RGBA")
    pixels = np.array(img)
    h, w = pixels.shape[:2]

    sample_points = [
        (0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
        (w // 2, 0), (0, h // 2),
    ]
    samples = [pixels[y, x, :3] for x, y in sample_points]
    bg_color = np.median(samples, axis=0)

    mask = np.zeros((h, w), dtype=bool)

    border_pixels = set()
    for x in range(w):
        border_pixels.add((x, 0))
        border_pixels.add((x, h - 1))
    for y in range(h):
        border_pixels.add((0, y))
        border_pixels.add((w - 1, y))

    queue = []
    for x, y in border_pixels:
        diff = np.linalg.norm(pixels[y, x, :3].astype(float) - bg_color)
        if diff <= tolerance:
            mask[y, x] = True
            queue.append((x, y))

    head = 0
    while head < len(queue):
        cx, cy = queue[head]
        head += 1
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < w and 0 <= ny < h and not mask[ny, nx]:
                diff = np.linalg.norm(pixels[ny, nx, :3].astype(float) - bg_color)
                if diff <= tolerance:
                    mask[ny, nx] = True
                    queue.append((nx, ny))

    pixels[mask, 3] = 0
    return Image.fromarray(pixels)


def _is_complex_image(img: Image.Image) -> bool:
    """Detect watercolor/gradient images by counting color variety in opaque pixels."""
    px = np.array(img.convert("RGBA"))
    opaque = px[:, :, 3] > 128
    if opaque.sum() == 0:
        return False
    rgb = px[opaque][:, :3]
    quantized = (rgb // 32).astype(np.uint32)
    keys = quantized[:, 0] * 64 + quantized[:, 1] * 8 + quantized[:, 2]
    return len(np.unique(keys)) > COMPLEX_IMAGE_COLOR_BINS


def trace(img: Image.Image, color_precision: int = None) -> str:
    """Run vtracer on image bytes and return raw SVG string."""
    raw = _image_to_png_bytes(img)
    params = dict(VTRACER_PARAMS)
    if color_precision is not None:
        params["color_precision"] = color_precision
    return vtracer.convert_raw_image_to_svg(raw, **params)


def _apply_translate(d: str, tx: float, ty: float) -> str:
    """Bake a translate(tx,ty) into an SVG path's d attribute."""
    if tx == 0 and ty == 0:
        return d

    tokens = re.findall(r'[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?', d)
    out = []
    i = 0
    cmd = ""
    while i < len(tokens):
        token = tokens[i]
        if token.isalpha():
            cmd = token
            out.append(token)
            i += 1
            continue

        if cmd in ("Z", "z"):
            i += 1
            continue

        val = float(token)
        if cmd == "M":
            out.append(str(val + tx))
            i += 1
            if i < len(tokens) and not tokens[i].isalpha():
                out.append(str(float(tokens[i]) + ty))
                i += 1
        elif cmd == "L":
            out.append(str(val + tx))
            i += 1
            if i < len(tokens) and not tokens[i].isalpha():
                out.append(str(float(tokens[i]) + ty))
                i += 1
        elif cmd == "H":
            out.append(str(val + tx))
            i += 1
        elif cmd == "V":
            out.append(str(val + ty))
            i += 1
        elif cmd == "C":
            for _ in range(3):
                if i < len(tokens) and not tokens[i].isalpha():
                    out.append(str(float(tokens[i]) + tx))
                    i += 1
                if i < len(tokens) and not tokens[i].isalpha():
                    out.append(str(float(tokens[i]) + ty))
                    i += 1
        elif cmd == "S" or cmd == "Q":
            for _ in range(2):
                if i < len(tokens) and not tokens[i].isalpha():
                    out.append(str(float(tokens[i]) + tx))
                    i += 1
                if i < len(tokens) and not tokens[i].isalpha():
                    out.append(str(float(tokens[i]) + ty))
                    i += 1
        elif cmd == "T":
            out.append(str(val + tx))
            i += 1
            if i < len(tokens) and not tokens[i].isalpha():
                out.append(str(float(tokens[i]) + ty))
                i += 1
        elif cmd == "A":
            out.append(str(val))  # rx
            i += 1
            for _ in range(2):  # ry, x-rotation
                if i < len(tokens) and not tokens[i].isalpha():
                    out.append(tokens[i])
                    i += 1
            for _ in range(2):  # large-arc, sweep
                if i < len(tokens) and not tokens[i].isalpha():
                    out.append(tokens[i])
                    i += 1
            if i < len(tokens) and not tokens[i].isalpha():
                out.append(str(float(tokens[i]) + tx))
                i += 1
            if i < len(tokens) and not tokens[i].isalpha():
                out.append(str(float(tokens[i]) + ty))
                i += 1
        elif cmd.islower():
            out.append(str(val))
            i += 1
        else:
            out.append(str(val))
            i += 1

    return " ".join(out)


def _parse_translate(transform: str) -> tuple[float, float]:
    """Extract tx, ty from a translate(...) transform string."""
    m = re.match(r'translate\(\s*([^,\s]+)\s*[,\s]\s*([^)]+)\)', transform)
    if m:
        return float(m.group(1)), float(m.group(2))
    return 0.0, 0.0


def _cluster_colors_map(paths_by_color: dict, distance: int) -> dict[str, str]:
    """Build a mapping from original color -> canonical (merged) color."""
    colors = list(paths_by_color.keys())
    rgb_colors = [_hex_to_rgb(c) for c in colors]

    merged: dict[str, str] = {}
    used: set[str] = set()

    for i, c1 in enumerate(colors):
        if c1 in used:
            continue
        cluster = [i]
        for j in range(i + 1, len(colors)):
            c2 = colors[j]
            if c2 in used:
                continue
            dist = np.linalg.norm(rgb_colors[i] - rgb_colors[j])
            if dist < distance:
                cluster.append(j)
                used.add(c2)

        best = max(
            cluster,
            key=lambda idx: sum(len(p[1]) for p in paths_by_color[colors[idx]]),
        )
        canonical = colors[best]
        for idx in cluster:
            merged[colors[idx]] = canonical
        used.add(c1)

    return merged


def _cap_colors(color_map: dict[str, str], paths: list, max_colors: int = MAX_COLORS) -> dict[str, str]:
    """If more than max_colors survive clustering, merge smallest into nearest."""
    canonical_colors = set(color_map.values())
    if len(canonical_colors) <= max_colors:
        return color_map

    color_weight: dict[str, int] = defaultdict(int)
    for orig_fill, d, _ in paths:
        canon = color_map.get(orig_fill, orig_fill)
        color_weight[canon] += len(d)

    ranked = sorted(color_weight.keys(), key=lambda c: color_weight[c], reverse=True)
    keep = set(ranked[:max_colors])
    demote = ranked[max_colors:]

    keep_rgbs = {c: _hex_to_rgb(c) for c in keep}

    remap: dict[str, str] = {}
    for color in demote:
        rgb = _hex_to_rgb(color)
        nearest = min(keep, key=lambda k: np.linalg.norm(rgb - keep_rgbs[k]))
        remap[color] = nearest

    result = {}
    for orig, canon in color_map.items():
        result[orig] = remap.get(canon, canon)
    return result


def _get_bbox(d: str) -> tuple[float, float, float, float]:
    """Approximate bounding box (minx, miny, maxx, maxy) from path data."""
    nums = re.findall(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?', d)
    if len(nums) < 2:
        return (0, 0, 0, 0)
    xs = [float(nums[i]) for i in range(0, len(nums), 2)]
    ys = [float(nums[i]) for i in range(1, len(nums), 2)]
    return (min(xs), min(ys), max(xs), max(ys))


def _bbox_area(bb: tuple) -> float:
    return max(0, bb[2] - bb[0]) * max(0, bb[3] - bb[1])


def _bbox_contains(outer: tuple, inner: tuple, margin: float = 0.1) -> bool:
    """Check if inner bbox is contained within outer bbox (with relative margin)."""
    ow = outer[2] - outer[0]
    oh = outer[3] - outer[1]
    m = margin * max(ow, oh)
    return (inner[0] >= outer[0] - m and inner[1] >= outer[1] - m and
            inner[2] <= outer[2] + m and inner[3] <= outer[3] + m)


def cluster_colors(svg_str: str, distance: int = COLOR_CLUSTER_DISTANCE, max_colors: int = MAX_COLORS) -> str:
    """
    Parse SVG paths, merge colors within RGB distance, cap at max_colors,
    detect counters (letter holes), bake transforms into path data,
    and output one compound path per color with fill-rule="evenodd" where needed.
    """
    root = ET.fromstring(svg_str)

    paths_by_color: dict[str, list[tuple]] = defaultdict(list)
    all_paths_ordered: list[tuple] = []
    for path_el in root.iter("{http://www.w3.org/2000/svg}path"):
        fill = path_el.get("fill", "")
        d = path_el.get("d", "")
        transform = path_el.get("transform", "")
        if fill and fill != "none" and d:
            entry = (fill, d, transform)
            paths_by_color[fill].append(entry)
            all_paths_ordered.append(entry)

    if not paths_by_color:
        return svg_str

    color_map = _cluster_colors_map(paths_by_color, distance)
    color_map = _cap_colors(color_map, all_paths_ordered, max_colors)

    baked: list[tuple[str, str]] = []
    for orig_fill, d, transform in all_paths_ordered:
        canon = color_map.get(orig_fill, orig_fill)
        if transform:
            tx, ty = _parse_translate(transform)
            d = _apply_translate(d, tx, ty)
        baked.append((canon, d))

    bboxes = [_get_bbox(d) for _, d in baked]
    areas = [_bbox_area(bb) for bb in bboxes]

    color_seen_before: dict[str, int] = {}
    for i, (color, _) in enumerate(baked):
        if color not in color_seen_before:
            color_seen_before[color] = i

    counter_targets: dict[int, str] = {}
    for i, (color_a, d_a) in enumerate(baked):
        if areas[i] == 0:
            continue
        for j in range(i - 1, -1, -1):
            color_b = baked[j][0]
            if color_b == color_a:
                continue
            if areas[j] == 0:
                continue
            if areas[i] / areas[j] > 0.3:
                continue
            if not _bbox_contains(bboxes[j], bboxes[i]):
                continue
            if color_seen_before.get(color_a, i) >= j:
                continue
            counter_targets[i] = color_b
            break

    compound: dict[str, list[str]] = defaultdict(list)
    colors_with_counters: set[str] = set()
    color_order: list[str] = []
    for i, (canon, d) in enumerate(baked):
        if i in counter_targets:
            target_color = counter_targets[i]
            compound[target_color].append(d)
            colors_with_counters.add(target_color)
            if target_color not in color_order:
                color_order.append(target_color)
        else:
            compound[canon].append(d)
            if canon not in color_order:
                color_order.append(canon)

    width = root.get("width", "800")
    height = root.get("height", "600")
    viewbox = root.get("viewBox", f"0 0 {width} {height}")

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="{viewbox}">',
    ]
    for color in color_order:
        merged_d = " ".join(compound[color])
        evenodd = ' fill-rule="evenodd"' if color in colors_with_counters else ""
        lines.append(f'  <path fill="{color}"{evenodd} d="{merged_d}"/>')
    lines.append("</svg>")

    return "\n".join(lines) + "\n"


ALPHA_THRESHOLD = 64
SHADOW_LUMINANCE_THRESHOLD = 40
WHITE_FLOOD_THRESHOLD = 30
NEAR_WHITE_LUM_THRESHOLD = 248


def _strip_near_white_paths(svg_str: str) -> str:
    """Remove SVG paths whose fill is near-white (lum > 248)."""
    out = []
    for line in svg_str.splitlines():
        m = re.search(r'fill="(#[0-9A-Fa-f]{6})"', line)
        if m and "<path" in line:
            rgb = _hex_to_rgb(m.group(1))
            lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
            if lum > NEAR_WHITE_LUM_THRESHOLD:
                continue
        out.append(line)
    return "\n".join(out) + "\n"


def _remove_white_outline(img: Image.Image, tolerance: int = WHITE_FLOOD_THRESHOLD) -> Image.Image:
    """
    Remove white outlines by flood-filling from transparent pixels inward.
    Any near-white opaque pixel adjacent to a transparent pixel gets made
    transparent, propagating inward through connected white regions.
    """
    pixels = np.array(img)
    h, w = pixels.shape[:2]
    alpha = pixels[:, :, 3]
    rgb = pixels[:, :, :3].astype(float)
    white = np.array([255.0, 255.0, 255.0])

    is_near_white = np.linalg.norm(rgb - white, axis=2) < tolerance
    is_transparent = alpha == 0

    from scipy.ndimage import binary_dilation
    adjacent_to_transparent = binary_dilation(is_transparent) & ~is_transparent
    seeds = adjacent_to_transparent & is_near_white & (alpha > 0)

    mask = seeds.copy()
    ys, xs = np.where(seeds)
    queue = list(zip(xs.tolist(), ys.tolist()))

    head = 0
    while head < len(queue):
        cx, cy = queue[head]
        head += 1
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < w and 0 <= ny < h and not mask[ny, nx] and is_near_white[ny, nx] and alpha[ny, nx] > 0:
                mask[ny, nx] = True
                queue.append((nx, ny))

    pixels[mask, 3] = 0

    from scipy.ndimage import binary_erosion, binary_dilation
    opaque = pixels[:, :, 3] > 0
    eroded = binary_erosion(opaque, iterations=2)
    restored = binary_dilation(eroded, iterations=2)
    fringe = opaque & ~restored
    pixels[fringe, 3] = 0

    return Image.fromarray(pixels)


def _has_transparency(img: Image.Image) -> bool:
    """Check if image already has meaningful transparency."""
    if img.mode != "RGBA":
        return False
    alpha = np.array(img)[:, :, 3]
    transparent_ratio = (alpha == 0).sum() / alpha.size
    return transparent_ratio > 0.01


def _snap_alpha(img: Image.Image, threshold: int = ALPHA_THRESHOLD) -> Image.Image:
    """
    Flatten semi-transparent pixels. Uses two-rule approach:
    1. Dark + semi-transparent = drop shadow → remove (transparent)
    2. Bright/colorful + semi-transparent = decorative element → keep (opaque)
    Keeps raw RGB values for decorative pixels rather than compositing against
    white, which washes out watercolor-style images.
    """
    if img.mode != "RGBA":
        return img

    pixels = np.array(img).copy()
    orig_alpha = pixels[:, :, 3]
    rgb = pixels[:, :, :3].astype(float)

    luminance = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]

    semi = (orig_alpha > 0) & (orig_alpha < 255)
    is_shadow = semi & (luminance < SHADOW_LUMINANCE_THRESHOLD)
    is_decorative = semi & (luminance >= SHADOW_LUMINANCE_THRESHOLD)

    pixels[is_shadow, 3] = 0
    pixels[is_decorative & (orig_alpha >= threshold), 3] = 255
    pixels[is_decorative & (orig_alpha < threshold), 3] = 0
    return Image.fromarray(pixels)


def vectorize(image_bytes: bytes) -> tuple[str, dict]:
    """
    Full pipeline: image bytes in, clean SVG string out.
    Returns (svg_string, stats_dict).
    """
    img = Image.open(io.BytesIO(image_bytes))
    original_size = img.size

    img = upscale(img)
    upscaled_size = img.size

    had_transparency = _has_transparency(img)
    if had_transparency:
        img_nobg = _snap_alpha(img.convert("RGBA"))
        img_nobg = _remove_white_outline(img_nobg)
    else:
        img = img.convert("RGB")
        img_nobg = remove_background(img)

    complex_image = _is_complex_image(img_nobg)
    color_precision = 5 if complex_image else None
    cluster_dist = COLOR_CLUSTER_DISTANCE_COMPLEX if complex_image else COLOR_CLUSTER_DISTANCE

    raw_svg = trace(img_nobg, color_precision=color_precision)

    raw_colors = set(re.findall(r'fill="([^"]+)"', raw_svg))
    raw_colors.discard("none")

    final_svg = cluster_colors(raw_svg, distance=cluster_dist)

    if not had_transparency:
        final_svg = _strip_near_white_paths(final_svg)

    final_colors = set(re.findall(r'fill="([^"]+)"', final_svg))
    final_colors.discard("none")
    curve_count = len(re.findall(r"[CcSs]", final_svg))
    line_count = len(re.findall(r"[LlHhVv]", final_svg))
    path_count = len(re.findall(r"<path", final_svg))

    stats = {
        "original_size": original_size,
        "upscaled_size": upscaled_size,
        "raw_color_count": len(raw_colors),
        "final_color_count": len(final_colors),
        "final_colors": sorted(final_colors),
        "path_count": path_count,
        "curve_count": curve_count,
        "line_count": line_count,
        "curve_ratio": curve_count / max(curve_count + line_count, 1),
        "svg_size_kb": len(final_svg) / 1024,
    }

    return final_svg, stats


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python vectorize.py <image_path> [output_path]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else input_path.rsplit(".", 1)[0] + ".svg"

    with open(input_path, "rb") as f:
        image_bytes = f.read()

    svg, stats = vectorize(image_bytes)

    with open(output_path, "w") as f:
        f.write(svg)

    print(f"Input:       {input_path} ({stats['original_size'][0]}x{stats['original_size'][1]})")
    print(f"Upscaled:    {stats['upscaled_size'][0]}x{stats['upscaled_size'][1]}")
    print(f"Colors:      {stats['raw_color_count']} raw -> {stats['final_color_count']} merged")
    print(f"Paths:       {stats['path_count']} compound paths")
    print(f"Curves:      {stats['curve_count']} ({stats['curve_ratio']:.0%} curve ratio)")
    print(f"Output:      {output_path} ({stats['svg_size_kb']:.1f} KB)")
    print(f"Colors:      {', '.join(stats['final_colors'])}")
