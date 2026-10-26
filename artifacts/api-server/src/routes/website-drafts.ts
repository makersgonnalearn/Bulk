import { readFile } from "node:fs/promises";
import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  getActiveVectorizerJob,
  listActiveVectorizerJobs,
  type StoredVectorizerItem,
  type StoredVectorizerJob,
} from "../lib/vectorizer-store";
import { isValidPullKey, titleFromSlug, websiteDraftsEnabled } from "../lib/website-drafts";

// Called by the MGL website's mgl-cutfile-import plugin, never by browsers.
// Mounted before the Supabase-auth router; the shared pull key is the auth.
const router: IRouter = Router();
const claimTimeoutMs = 10 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use("/website-drafts", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (!websiteDraftsEnabled()) {
    res.status(503).json({ error: "Website drafts are not configured on this server." });
    return;
  }
  if (!isValidPullKey(req.get("x-mgl-pull-key"))) {
    res.status(401).json({ error: "Invalid pull key." });
    return;
  }
  next();
});

function findClaimedItem(
  req: Request,
  res: Response,
): { job: StoredVectorizerJob; item: StoredVectorizerItem } | null {
  const { jobId, itemId } = req.params;
  if (!uuidPattern.test(String(jobId)) || !uuidPattern.test(String(itemId))) {
    res.status(400).json({ error: "Invalid design reference." });
    return null;
  }
  const job = getActiveVectorizerJob(String(jobId));
  const item = job?.items.find((candidate) => candidate.id === itemId);
  if (!job || !item) {
    res.status(404).json({ error: "Design not found. The batch may have expired or been deleted." });
    return null;
  }
  if (item.wpStatus !== "sending") {
    res.status(409).json({ error: "This design is not waiting on the website." });
    return null;
  }
  return { job, item };
}

// Hands out the oldest queued design and marks it as being built. A claim
// the website never reports back on goes back to the queue after 10 minutes.
router.post("/website-drafts/claim", (_req, res): void => {
  const now = Date.now();
  let claimed: { job: StoredVectorizerJob; item: StoredVectorizerItem } | null = null;

  for (const job of listActiveVectorizerJobs()) {
    for (const item of job.items) {
      if (item.wpStatus === "sending" && item.wpClaimedAt !== null && now - item.wpClaimedAt > claimTimeoutMs) {
        item.wpStatus = "queued";
        item.wpClaimedAt = null;
      }
      if (!claimed && item.wpStatus === "queued" && item.pngReady && item.pngPath) {
        claimed = { job, item };
      }
    }
  }

  if (!claimed) {
    res.json({ item: null });
    return;
  }

  const { job, item } = claimed;
  item.wpStatus = "sending";
  item.wpClaimedAt = now;
  item.wpError = null;
  job.lastAccessedAt = now;
  res.json({
    item: {
      ref: `${job.id}:${item.id}`,
      jobId: job.id,
      itemId: item.id,
      title: titleFromSlug(item.suggestedName),
      filename: item.suggestedName,
      hasSvg: Boolean(item.includeSvg && item.svgReady && item.svgPath),
    },
  });
});

async function sendItemFile(req: Request, res: Response, format: "png" | "svg"): Promise<void> {
  const found = findClaimedItem(req, res);
  if (!found) return;
  const { item } = found;
  const filePath = format === "png"
    ? item.pngPath
    : item.includeSvg && item.svgReady ? item.svgPath : null;
  if (!filePath) {
    res.status(404).json({ error: `This design has no ${format.toUpperCase()}.` });
    return;
  }

  try {
    res
      .status(200)
      .type(format === "png" ? "image/png" : "image/svg+xml")
      .send(await readFile(filePath));
  } catch (error) {
    logger.error({ err: error, itemId: item.id, format }, "Could not read file for the website");
    res.status(500).json({ error: "The file could not be read." });
  }
}

router.get("/website-drafts/:jobId/:itemId/png", async (req, res): Promise<void> => {
  await sendItemFile(req, res, "png");
});

router.get("/website-drafts/:jobId/:itemId/svg", async (req, res): Promise<void> => {
  await sendItemFile(req, res, "svg");
});

router.post("/website-drafts/:jobId/:itemId/result", (req, res): void => {
  const found = findClaimedItem(req, res);
  if (!found) return;
  const { job, item } = found;
  const body = (req.body ?? {}) as { ok?: unknown; postId?: unknown; editUrl?: unknown; error?: unknown };

  const postId = Number(body.postId);
  const editUrl = typeof body.editUrl === "string" ? body.editUrl : "";
  if (body.ok === true && Number.isInteger(postId) && postId > 0 && /^https:\/\/[^/\s]+\/wp-admin\/\S*$/.test(editUrl)) {
    item.wpStatus = "sent";
    item.wpPostId = postId;
    item.wpEditUrl = editUrl;
    item.wpError = null;
  } else {
    item.wpStatus = "failed";
    item.wpError = typeof body.error === "string" && body.error.trim()
      ? `The website could not create this draft: ${body.error.trim().slice(0, 300)}`
      : "The website could not create this draft. Try sending it again.";
  }
  item.wpClaimedAt = null;
  job.lastAccessedAt = Date.now();
  res.json({ ok: true });
});

export default router;
