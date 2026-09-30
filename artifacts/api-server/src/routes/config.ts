import { Router, type IRouter } from "express";
import {
  GetPublicConfigResponse,
} from "@workspace/api-zod";
import { getDevelopmentLoginEmail } from "../lib/dev-auth";
import { getPublicSupabaseConfig } from "../lib/supabase";

const router: IRouter = Router();

router.get("/config", (_req, res): void => {
  const config = getPublicSupabaseConfig();
  if (!config) {
    res.status(503).json({
      error:
        "Supabase configuration is missing or invalid. Set SUPABASE_URL and SUPABASE_ANON_KEY on the API server.",
    });
    return;
  }

  res.json(
    GetPublicConfigResponse.parse({
      ...config,
      devLoginEmail: getDevelopmentLoginEmail(),
    }),
  );
});

export default router;