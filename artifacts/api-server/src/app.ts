import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const apiServerDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory =
  process.env.FRONTEND_DIST_DIR?.trim() ||
  path.resolve(apiServerDirectory, "../../vector-workbench/dist/public");
const frontendIndex = path.join(frontendDirectory, "index.html");

if (existsSync(frontendIndex)) {
  app.use(express.static(frontendDirectory, { index: false }));
  app.get("/{*path}", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(frontendIndex, (error) => {
      if (error) next(error);
    });
  });
}

export default app;
