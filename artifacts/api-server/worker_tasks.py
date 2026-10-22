"""One image task per process: `python worker_tasks.py remove|trace` reads stdin, writes stdout."""
import io
import os
import re
import sys

# Specks smaller than this (on the 2500 px trace canvas) are too small to cut or weed.
FILTER_SPECKLE_PX = 16
# A normal trace stays well under this; a runaway vtracer pass can reach ~76k segments.
MAX_SEGMENTS = 40_000
SVG_LONG_SIDE_IN = 10
ALPHA_CUTOFF = 128


def remove_background(data: bytes) -> bytes:
    import onnxruntime as ort
    from rembg import new_session, remove

    options = ort.SessionOptions()
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    model = os.environ.get("REMBG_MODEL", "isnet-general-use").strip() or "isnet-general-use"
    session = new_session(model, sess_opts=options)
    return remove(
        data,
        session=session,
        force_return_bytes=True,
        alpha_matting=False,
        post_process_mask=False,
        decontaminate=os.environ.get("REMBG_DECONTAMINATE", "false").strip().lower() == "true",
    )


def harden_alpha(data: bytes) -> bytes:
    # Background removal leaves dark artwork slightly translucent, which vectorize
    # would otherwise drop as a drop shadow. Cut files only need solid or clear.
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    if img.mode not in ("RGBA", "LA", "P"):
        return data
    pixels = np.array(img.convert("RGBA"))
    pixels[:, :, 3] = np.where(pixels[:, :, 3] >= ALPHA_CUTOFF, 255, 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(pixels).save(buf, format="PNG")
    return buf.getvalue()


def round_coordinates(svg: str) -> str:
    return re.sub(r"-?\d+\.\d{3,}", lambda m: f"{float(m.group()):.2f}".rstrip("0").rstrip("."), svg)


def set_physical_size(svg: str) -> str:
    view_box = re.search(r'viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"', svg)
    if not view_box:
        return svg
    width, height = float(view_box.group(1)), float(view_box.group(2))
    scale = SVG_LONG_SIDE_IN / max(width, height)
    return re.sub(
        r'(<svg\b[^>]*?)\swidth="[^"]*"\s+height="[^"]*"',
        lambda m: f'{m.group(1)} width="{width * scale:.2f}in" height="{height * scale:.2f}in"',
        svg,
        count=1,
    )


def trace(data: bytes) -> bytes:
    import vectorize

    vectorize.VTRACER_PARAMS["filter_speckle"] = FILTER_SPECKLE_PX
    svg, _stats = vectorize.vectorize(harden_alpha(data))
    segments = sum(len(re.findall(r"[CLQSTAHV]", d)) for d in re.findall(r'\sd="([^"]*)"', svg))
    if segments > MAX_SEGMENTS:
        sys.stderr.write(f"trace produced {segments} segments, over the {MAX_SEGMENTS} limit\n")
        sys.exit(3)
    return set_physical_size(round_coordinates(svg)).encode("utf-8")


if __name__ == "__main__":
    task = {"remove": remove_background, "trace": trace}[sys.argv[1]]
    sys.stdout.buffer.write(task(sys.stdin.buffer.read()))
