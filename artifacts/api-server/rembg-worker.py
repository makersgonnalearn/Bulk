"""Small loopback-only rembg worker for the API image helpers."""
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rembg import new_session, remove

MAX_BYTES = 25 * 1024 * 1024
MODEL_NAME = os.environ.get("REMBG_MODEL", "isnet-general-use").strip() or "isnet-general-use"
MAX_PARALLEL_REMOVALS = max(
    1, min(8, int(os.environ.get("REMBG_MAX_PARALLEL_REMOVALS", "2")))
)
sys.stderr.write(f"rembg: loading model {MODEL_NAME}\n")
session = new_session(MODEL_NAME)
removal_slots = threading.BoundedSemaphore(MAX_PARALLEL_REMOVALS)


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
        if self.path != "/remove":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BYTES:
            self.send_error(413)
            return
        data = self.rfile.read(length)
        if not removal_slots.acquire(timeout=240):
            self.send_error(503, "background removal capacity is busy")
            return
        try:
            output = remove(
                data,
                session=session,
                force_return_bytes=True,
                alpha_matting=False,
                post_process_mask=False,
                decontaminate=True,
            )
            if len(output) > MAX_BYTES:
                self.send_error(413)
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(output)))
            self.end_headers()
            self.wfile.write(output)
        except Exception:
            self.send_error(500, "background removal failed")
        finally:
            removal_slots.release()


if __name__ == "__main__":
    port = int(os.environ["REMBG_PORT"])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()