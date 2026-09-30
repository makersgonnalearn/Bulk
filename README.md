# Vector Batch Studio

Vector Batch Studio turns batches of PNG and JPG images into processed PNGs and
optional SVGs. It is a pnpm monorepo with a React/Vite web app and an Express
API. The Docker image builds both and serves the web app and `/api` from one
origin.

## Run with Docker Compose

### Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2
- Supabase project URL and anon key
- OpenAI API key for per-image analysis, filename suggestions, and SVG suitability decisions

### Start

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `OPENAI_API_KEY` in `.env`.
   Keep `DEV_SKIP_LOGIN=false`.

3. Build and start the app:

   ```sh
   docker compose up --build
   ```

4. Open [http://localhost:8080](http://localhost:8080). To use another host
   port, set `APP_PORT` in `.env`, for example `APP_PORT=3000`.

View logs with:

```sh
docker compose logs -f vector-batch-studio
```

Stop the app with `Ctrl+C`, or run `docker compose down` in another terminal.
The named `rembg-model-cache` volume keeps the background-removal model between
container rebuilds. Removing it with `docker compose down -v` deletes that
downloaded model, so it will be fetched again on the next use.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL used for sign-in |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key used for sign-in |
| `OPENAI_API_KEY` | Yes for full processing | Per-image analysis, filename suggestions, and SVG suitability decisions |
| `APP_PORT` | No | Host port exposed by Compose; defaults to `8080` |

The container sets its internal port and Python worker path automatically.
Do not set `DEV_SKIP_LOGIN=true` in a production deployment.

## Run from source without Docker

Use Node.js 24, pnpm 10.26.1, Python 3.13, and uv. Create `.env` as described
above, then run these commands from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile

uv python install 3.13
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python \
  -r artifacts/api-server/requirements.txt

PORT=8080 BASE_PATH=/ \
  pnpm --filter @workspace/vector-workbench run build
pnpm --filter @workspace/api-server run build

PORT=8080 \
FRONTEND_DIST_DIR="$PWD/artifacts/vector-workbench/dist/public" \
PYTHON_EXECUTABLE="$PWD/.venv/bin/python" \
pnpm --filter @workspace/api-server run start
```

Open [http://localhost:8080](http://localhost:8080). The API loads the root
`.env` file when it starts.

## Replit development

The web and API artifacts already have managed Replit workflows. Use the
Vector Batch Studio preview for the UI and the API Server workflow for its
backend; Docker is intended for running the complete app outside Replit.

## Runtime and data notes

- The background-removal model downloads the first time that feature is used.
  That initial request can take longer; the Compose volume preserves the model.
- Active API jobs and generated files are held in process memory and temporary
  storage. Restarting or replacing the container clears active jobs and results.
- User-side saved batches are stored in the browser, not in the container.
- Keep `.env` private. It is excluded from the Docker build context and Git.