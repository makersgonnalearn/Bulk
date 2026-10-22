# Deploying on Render

The live service runs from the repository's `Dockerfile`. Render builds the
image, which includes the web app, the API, the Python worker, and the
background-removal model, and serves everything from one origin.

## Service settings

- **Language:** Docker. Leave Root Directory blank.
- **Branch:** `main`
- **Health Check Path:** `/api/healthz`
- **Instance:** 4 GB of memory is enough for the default limits below.
- Run a single instance. Batches are held in memory, so autoscaling across
  instances would split them.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Project URL only, with no trailing path |
| `SUPABASE_ANON_KEY` | Yes | The public anon/publishable key, never service_role |
| `OPENAI_API_KEY` | Yes | Used for filenames and the SVG yes/no check |
| `MAX_ACTIVE_ITEMS` | No | Images processed at once across all users. Default `1` |
| `REMBG_MAX_PARALLEL_REMOVALS` | No | Background removals at once inside the worker. Default `1` |
| `REMBG_DECONTAMINATE` | No | `true` turns on edge color cleanup. Default off: it adds about 1 GB per image and must stay at one removal at a time |
| `MGL_WP_URL` | No | MGL WordPress site for **Send to website as drafts**, e.g. `https://makersgonnalearn.com`. The button is hidden unless this and the key are both set |
| `MGL_WP_IMPORT_KEY` | No | Key from `wp mgl-cutfile-import key create` on that site (the `mgl-cutfile-import` plugin must be active there) |

Render supplies `PORT`. The Dockerfile sets `NODE_ENV`, `PYTHON_EXECUTABLE`,
and the model path. Never set `DEV_SKIP_LOGIN` or `DEV_LOGIN_EMAIL` here.

## Supabase

Disable public sign-ups and invite team members from **Authentication → Users**.
Under **Authentication → URL Configuration**, set **Site URL** to the Render
URL and add `https://<service>.onrender.com/**` to **Redirect URLs**.

## How processing works

- The Node API handles uploads, OpenAI calls, and batch state.
- A Python worker (`rembg-worker.py`) runs background removal, SVG tracing
  (`vectorize.py`, vtracer), and the color check that decides whether an image
  suits an SVG. If the worker crashes, the API restarts it on the next request
  and the site stays up.
- Background removal peaks around 2.4 GB for a 2400 px image and SVG tracing
  around 0.9 GB, so the defaults run one image at a time.
- SVGs are traced at 2500 px on the long side. Before tracing, every pixel is
  made fully solid or fully clear (background removal leaves dark artwork
  slightly translucent, which the tracer would drop), and specks under 16 px
  are filtered out so pieces stay big enough to cut and weed.
- Finished SVGs are sized 10 inches on the long side so Cricut Design Space
  imports them at a usable size, with coordinates rounded to 2 decimals.
- A trace with more than 40,000 path segments is treated as a runaway and
  retried once. If the retry also fails, that image comes back PNG-only.
  These settings live at the top of `worker_tasks.py`.
- Images with more than 80 color groups (watercolors, photos) are not
  pre-selected for SVG. People can still tick them on the review screen.

## Restarts

A deploy or restart clears batches that are in progress. People's originals
stay saved in their browser, and the app offers to re-upload them.
