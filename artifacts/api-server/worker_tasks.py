"""One image task per process: `python worker_tasks.py remove|trace` reads stdin, writes stdout."""
import os
import sys


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


def trace(data: bytes) -> bytes:
    from vectorize import vectorize

    svg, _stats = vectorize(data)
    return svg.encode("utf-8")


if __name__ == "__main__":
    task = {"remove": remove_background, "trace": trace}[sys.argv[1]]
    sys.stdout.buffer.write(task(sys.stdin.buffer.read()))
