"""Small loopback-only rembg worker for the API image helpers."""
import io
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

MAX_BYTES = 25 * 1024 * 1024
MAX_SVG_BYTES = 8 * 1024 * 1024
MAX_TRACE_PX = 2500
INSPECT_PX = 1024
# Flat designs in the sample set score <= 46 and watercolors >= 110.
COMPLEX_COLOR_BINS = 80
MAX_PARALLEL_REMOVALS = max(
    1, min(8, int(os.environ.get("REMBG_MAX_PARALLEL_REMOVALS", "1")))
)
# Each removal and trace runs in its own process so its memory is returned when it
# exits, and a run that hangs (vtracer occasionally does) can be killed and retried.
TASK_ATTEMPTS = 2
REMOVE_TIMEOUT_S = 100
TRACE_TIMEOUT_S = 45
WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
TASK_SCRIPT = os.path.join(WORKER_DIR, "worker_tasks.py")

removal_slots = threading.BoundedSemaphore(MAX_PARALLEL_REMOVALS)
trace_slots = threading.BoundedSemaphore(1)
inspect_slots = threading.BoundedSemaphore(2)


def run_task(task: str, data: bytes, timeout_s: int, max_output: int) -> bytes:
    problem = "no attempts"
    for attempt in range(1, TASK_ATTEMPTS + 1):
        try:
            result = subprocess.run(
                [sys.executable, TASK_SCRIPT, task],
                input=data,
                capture_output=True,
                cwd=WORKER_DIR,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            problem = f"timed out after {timeout_s}s"
        else:
            if result.returncode == 0 and 0 < len(result.stdout) <= max_output:
                return result.stdout
            stderr_tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-1:]
            problem = f"exit {result.returncode}, {len(result.stdout)} bytes {stderr_tail}"
        sys.stderr.write(f"rembg: {task} attempt {attempt} failed: {problem}\n")
    raise RuntimeError(f"{task} failed: {problem}")


def open_capped(data: bytes, max_px: int, resample) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    if max(img.size) > max_px:
        img.thumbnail((max_px, max_px), resample)
    return img


def remove_background(data: bytes) -> bytes:
    return run_task("remove", data, REMOVE_TIMEOUT_S, MAX_BYTES)


def trace_png(data: bytes) -> bytes:
    buf = io.BytesIO()
    open_capped(data, MAX_TRACE_PX, Image.LANCZOS).save(buf, format="PNG")
    return run_task("trace", buf.getvalue(), TRACE_TIMEOUT_S, MAX_SVG_BYTES)


def color_bins(img: Image.Image) -> int:
    px = np.array(img.convert("RGBA"))
    rgb = px[px[:, :, 3] > 128][:, :3]
    quantized = (rgb // 32).astype(np.uint32)
    return len(np.unique(quantized[:, 0] * 64 + quantized[:, 1] * 8 + quantized[:, 2]))


def inspect_image(data: bytes) -> bytes:
    bins = color_bins(open_capped(data, INSPECT_PX, Image.NEAREST))
    return json.dumps({"complex": bins > COMPLEX_COLOR_BINS, "colorBins": bins}).encode("utf-8")


ROUTES = {
    "/remove": (removal_slots, remove_background, "image/png", "background removal"),
    "/trace": (trace_slots, trace_png, "image/svg+xml", "tracing"),
    "/inspect": (inspect_slots, inspect_image, "application/json", "inspection"),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("rembg: " + (fmt % args) + "\n")

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404)

    def do_POST(self):
        route = ROUTES.get(self.path)
        if not route:
            self.send_error(404)
            return
        slots, handler, content_type, label = route
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BYTES:
            self.send_error(413)
            return
        data = self.rfile.read(length)
        if not slots.acquire(timeout=240):
            self.send_error(503, f"{label} capacity is busy")
            return
        try:
            output = handler(data)
        except Exception as error:
            sys.stderr.write(f"rembg: {label} failed: {error}\n")
            self.send_error(500, f"{label} failed")
            return
        finally:
            slots.release()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)


if __name__ == "__main__":
    port = int(os.environ["REMBG_PORT"])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
