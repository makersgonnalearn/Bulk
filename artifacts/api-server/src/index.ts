import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = resolve(runtimeDirectory, "..");
const workspaceDirectory = resolve(apiDirectory, "../..");
const envFilePaths = new Set([
  resolve(workspaceDirectory, ".env"),
  resolve(apiDirectory, ".env"),
  resolve(process.cwd(), ".env"),
]);

for (const envFilePath of envFilePaths) {
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
}

const [{ default: app }, { logger }] = await Promise.all([
  import("./app"),
  import("./lib/logger"),
]);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
