import type { RequestHandler } from "express";
import { getDevelopmentLoginEmail } from "../lib/dev-auth";
import { getSupabaseClient } from "../lib/supabase";

declare global {
  namespace Express {
    interface Request {
      supabaseUser?: {
        id: string;
        email: string | null;
      };
    }
  }
}

export const requireSupabaseUser: RequestHandler = async (req, res, next) => {
  const developmentLoginEmail = getDevelopmentLoginEmail();
  if (developmentLoginEmail) {
    req.supabaseUser = {
      id: `dev:${developmentLoginEmail}`,
      email: developmentLoginEmail,
    };
    next();
    return;
  }

  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token) {
    res.status(401).json({ error: "Sign in to use the image workspace." });
    return;
  }

  const client = getSupabaseClient();
  if (!client) {
    res
      .status(503)
      .json({ error: "Supabase authentication is not configured on the API server." });
    return;
  }

  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: "Your session is invalid or has expired." });
      return;
    }

    req.supabaseUser = {
      id: data.user.id,
      email: data.user.email ?? null,
    };
    next();
  } catch (error) {
    next(error);
  }
};