# Deploying the existing Render service

The API server can serve the built Vector Batch Studio UI from the same origin.
In the existing Render web service, use the repository root as the service root
and set:

**Build command**

```sh
pnpm install --frozen-lockfile && python3 -m pip install --user --break-system-packages -r artifacts/api-server/requirements.txt && PORT=5173 BASE_PATH=/ pnpm --filter @workspace/vector-workbench run build && pnpm --filter @workspace/api-server run build
```

**Start command**

```sh
pnpm --filter @workspace/api-server run start
```

For a VM deployment, copy the repository-root `.env.example` to `.env` and fill
in the values there. The API loads `.env` before starting, whether launched from
the repository root or the API package directory. Existing process/VM
environment variables take precedence. Keep `.env` private; it is ignored by
Git. Node.js 20.12 or later is required for the built-in env-file loader.

Configure these environment variables in Render:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`)
- `OPENAI_API_KEY`
- `PYTHON_EXECUTABLE=python3`
- `PORT` is supplied by Render.

Set the service health-check path to `/api/healthz`.
Do not set `DEV_SKIP_LOGIN` or `DEV_LOGIN_EMAIL` on Render or any production
deployment. The test login is intended only for a private development preview.

The Supabase project should have public sign-ups disabled; invite approved team
members through Supabase. The browser receives only the public anon/publishable
key. Never set a service-role key for this application.

For invite and password-reset emails, open **Authentication → URL Configuration**
in the Supabase Dashboard. Set **Site URL** to the VM app's public HTTPS URL and
add that exact app URL to **Redirect URLs**. Dashboard invitations use the Site
URL by default; password-reset requests return to the current app URL. Do not use
`localhost` as the production Site URL.

The background-removal worker uses rembg's `isnet-general-use` model by default.
On the first background-removal request, rembg downloads and loads the model, so
that request can take longer. Set `REMBG_MODEL=u2net` to use the previous model.
IS-Net uses more memory than U²-Net; use that fallback on memory-constrained
instances.
CPU mask inference is limited to two concurrent requests by default; set
`REMBG_MAX_PARALLEL_REMOVALS` to a value from 1 to 8 to change that limit.

Batch metadata is held in process memory and files stay on the instance's
temporary disk for up to two hours. Run a single web-service instance; a restart
or deploy intentionally clears any in-progress or uncollected batches.