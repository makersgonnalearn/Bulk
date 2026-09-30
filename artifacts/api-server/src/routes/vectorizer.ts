import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Router,
  type IRouter,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer from "multer";
import JSZip from "jszip";
import sharp, { type Metadata } from "sharp";
import {
  CreateVectorizerJobResponse,
  GetVectorizerJobItemPngParams,
  GetVectorizerJobItemSvgParams,
  GetVectorizerJobParams,
  GetVectorizerJobResponse,
  ProcessVectorizerJobBody,
  ProcessVectorizerJobParams,
  RegenerateVectorizerJobItemNameParams,
  UpdateVectorizerJobItemsBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  createStoredVectorizerJob,
  deleteStoredVectorizerJob,
  getOwnedVectorizerJob,
  listOwnedVectorizerJobs,
  type StoredImageInput,
  type StoredVectorizerJob,
  type VectorizerProcessingOptions,
} from "../lib/vectorizer-store";
import {
  analyzeSourceImage,
  encodeImageAsPng,
  removeImageBackground,
  traceTransparentPngToSvg,
} from "../lib/image-processing";
import { requireSupabaseUser } from "../middlewares/supabase-auth";

const router: IRouter = Router();
const incomingDirectory = path.join(tmpdir(), "vector-batch-studio", "incoming");
const maxRequestBytes = 120 * 1024 * 1024;
const maxImageBytes = 20 * 1024 * 1024;
const maxImagePixels = 16_000_000;
const maxFiles = 50;
const maxZipEntries = 2_000;
const maxZipUncompressedBytes = 100 * 1024 * 1024;
const maxBatchOutputBytes = 100 * 1024 * 1024;
const nameRegenerationLocks = new Set<string>();

class UploadInputError extends Error {}

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      void mkdir(incomingDirectory, { recursive: true })
        .then(
          () => callback(null, incomingDirectory),
          (error: Error) => callback(error, ""),
        );
    },
    filename(_req, _file, callback) {
      callback(null, randomUUID());
    },
  }),
  limits: {
    fileSize: maxRequestBytes,
    files: maxFiles,
  },
});

const receiveUploads: RequestHandler = (req, res, next) => {
  const contentLength = Number(req.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    res.status(400).json({ error: "The upload is larger than the 120 MB batch limit." });
    return;
  }

  upload.array("files", maxFiles)(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    const message =
      error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
        ? "A file is larger than the 120 MB upload limit."
        : error instanceof multer.MulterError && error.code === "LIMIT_FILE_COUNT"
          ? "A batch can contain at most 50 uploaded files."
          : "The upload could not be read. Choose a ZIP or PNG/JPG files and try again.";

    res.status(400).json({ error: message });
  });
};

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});
router.use(requireSupabaseUser);

function currentUserId(req: Request): string {
  if (!req.supabaseUser) throw new Error("Authenticated user is missing.");
  return req.supabaseUser.id;
}

function safeBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized).trim();
  return basename || "image";
}

function safeArchivePath(value: string): string {
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) =>
      segment
        .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
        .trim()
        .replace(/[. ]+$/g, ""),
    )
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.join("/") || safeBasename(value);
}

function slugifyName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/g, "");
}

function uniqueName(base: string, used: Set<string>): string {
  const root = slugifyName(base) || "untitled-asset";
  let candidate = root;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `-${suffix++}`;
    candidate = `${root.slice(0, 90 - tail.length).replace(/-+$/g, "")}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

function fallbackName(originalName: string, index: number): string {
  const withoutExtension = safeBasename(originalName).replace(/\.[^.]+$/, "");
  return slugifyName(withoutExtension) || `untitled-asset-${index + 1}`;
}

async function validateImage(
  originalName: string,
  buffer: Buffer,
): Promise<StoredImageInput> {
  if (buffer.byteLength > maxImageBytes) {
    throw new UploadInputError(
      `"${safeBasename(originalName)}" is larger than the 20 MB per-image limit.`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: maxImagePixels }).metadata();
  } catch {
    throw new UploadInputError(
      `"${safeBasename(originalName)}" is not a readable PNG or JPEG image.`,
    );
  }

  if (metadata.format !== "png" && metadata.format !== "jpeg") {
    throw new UploadInputError(
      `"${safeBasename(originalName)}" is not a PNG or JPEG image.`,
    );
  }

  if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxImagePixels) {
    throw new UploadInputError(
      `"${safeBasename(originalName)}" has too many pixels to process safely.`,
    );
  }

  return {
    originalName: safeBasename(originalName),
    originalPath: safeArchivePath(originalName),
    extension: metadata.format === "png" ? "png" : "jpg",
    buffer,
  };
}

async function expandZip(buffer: Buffer): Promise<StoredImageInput[]> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: false });
  } catch {
    throw new UploadInputError(
      "The ZIP could not be opened. Check that it is a valid archive and try again.",
    );
  }

  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > maxZipEntries) {
    throw new UploadInputError("The ZIP contains too many files to inspect safely.");
  }

  const images = entries.filter((entry) => {
    const normalized = entry.name.replace(/\\/g, "/");
    const basename = path.posix.basename(normalized);
    if (!basename || basename.startsWith(".") || normalized.startsWith("__MACOSX/")) {
      return false;
    }
    return /\.(png|jpe?g)$/i.test(basename);
  });

  if (images.length === 0) {
    throw new UploadInputError("The ZIP does not contain any PNG or JPEG images.");
  }
  if (images.length > maxFiles) {
    throw new UploadInputError("A ZIP can contain at most 50 PNG/JPEG images.");
  }

  let declaredUncompressedBytes = 0;
  let actualUncompressedBytes = 0;
  const expanded: StoredImageInput[] = [];
  for (const entry of images) {
    const declaredSize = (
      entry as unknown as { _data?: { uncompressedSize?: number } }
    )._data?.uncompressedSize;
    if (typeof declaredSize === "number" && Number.isFinite(declaredSize)) {
      if (declaredSize > maxImageBytes) {
        throw new UploadInputError(
          `"${safeBasename(entry.name)}" is larger than the 20 MB per-image limit.`,
        );
      }
      declaredUncompressedBytes += declaredSize;
      if (declaredUncompressedBytes > maxZipUncompressedBytes) {
        throw new UploadInputError(
          "The ZIP expands beyond the 150 MB uncompressed batch limit.",
        );
      }
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = await entry.async("nodebuffer");
    } catch {
      throw new UploadInputError(
        `"${safeBasename(entry.name)}" could not be extracted from the ZIP.`,
      );
    }
    actualUncompressedBytes += imageBuffer.byteLength;
    if (actualUncompressedBytes > maxZipUncompressedBytes) {
      throw new UploadInputError(
        "The ZIP expands beyond the 100 MB uncompressed batch limit.",
      );
    }

    const validated = await validateImage(
      entry.name,
      imageBuffer,
    );
    expanded.push(validated);
  }

  return expanded;
}

async function collectImages(files: Express.Multer.File[]): Promise<StoredImageInput[]> {
  if (files.length === 0) {
    throw new UploadInputError("Choose a ZIP archive or at least one PNG/JPG image.");
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maxRequestBytes) {
    throw new UploadInputError("The upload is larger than the 120 MB batch limit.");
  }

  if (files.length === 1 && /\.zip$/i.test(files[0].originalname)) {
    if (files[0].size > maxRequestBytes) {
      throw new UploadInputError("The ZIP is larger than the 120 MB upload limit.");
    }
    return expandZip(await readFile(files[0].path));
  }

  if (files.some((file) => /\.zip$/i.test(file.originalname))) {
    throw new UploadInputError("Upload one ZIP archive or individual images, not both.");
  }
  if (files.length > maxFiles) {
    throw new UploadInputError("A batch can contain at most 50 images.");
  }

  const images: StoredImageInput[] = [];
  for (const file of files) {
    if (!/\.(png|jpe?g)$/i.test(file.originalname)) {
      throw new UploadInputError(
        `"${safeBasename(file.originalname)}" is not a PNG or JPEG image.`,
      );
    }
    images.push(
      await validateImage(file.originalname, await readFile(file.path)),
    );
  }

  return images;
}

function toPublicJob(job: StoredVectorizerJob) {
  return GetVectorizerJobResponse.parse({
    id: job.id,
    status: job.status,
    totalFiles: job.totalFiles,
    completedFiles: job.completedFiles,
    options: job.options,
    items: job.items.map((item) => ({
      id: item.id,
      originalName: item.originalName,
      originalPath: item.originalPath,
      suggestedName: item.suggestedName,
      includeSvg: item.includeSvg,
      status: item.status,
      error: item.error,
      pngReady: item.pngReady,
      svgReady: item.svgReady,
    })),
    error: job.error,
  });
}

function outputArchivePath(
  job: StoredVectorizerJob,
  item: StoredVectorizerJob["items"][number],
  format: "png" | "svg",
): string {
  const filename = `${item.suggestedName}.${format}`;
  if (!job.options.preserveFolderStructure) return filename;

  const directory = path.posix.dirname(safeArchivePath(item.originalPath));
  return directory === "." ? filename : path.posix.join(directory, filename);
}

function addItemWarning(item: StoredVectorizerJob["items"][number], warning: string): void {
  item.error = item.error ? `${item.error} ${warning}` : warning;
}

async function analyzeJob(job: StoredVectorizerJob): Promise<void> {
  const usedNames = new Set<string>();
  try {
    for (const [index, item] of job.items.entries()) {
      if (job.cancelled) return;
      if (!job.options.seoNaming && !job.options.svgOutput) {
        item.suggestedName = uniqueName(fallbackName(item.originalName, index), usedNames);
        item.suggestedNameHistory = [item.suggestedName];
        item.includeSvg = false;
        item.status = "ready";
        job.lastAccessedAt = Date.now();
        continue;
      }
      try {
        const source = await readFile(item.sourcePath);
        const analysis = await analyzeSourceImage(source, item.originalName);
        item.suggestedName = uniqueName(
          job.options.seoNaming
            ? analysis.suggestedName
            : fallbackName(item.originalName, index),
          usedNames,
        );
        item.includeSvg = job.options.svgOutput && analysis.includeSvg;
      } catch (error) {
        const fallback = fallbackName(item.originalName, index);
        item.suggestedName = uniqueName(fallback, usedNames);
        item.includeSvg = job.options.svgOutput;
        item.error = job.options.seoNaming
          ? "AI analysis was unavailable. Review this filename; SVG output will still be attempted if enabled."
          : "SVG suitability analysis was unavailable. SVG output will still be attempted.";
        logger.warn(
          { err: error, jobId: job.id, itemId: item.id },
          "Image analysis failed; keeping the item available for manual review",
        );
      }
      item.suggestedNameHistory = item.suggestedName ? [item.suggestedName] : [];
      item.status = "ready";
      job.lastAccessedAt = Date.now();
    }

    if (!job.cancelled) {
      job.status = "ready";
      job.lastAccessedAt = Date.now();
    }
  } catch (error) {
    if (job.cancelled) return;
    job.status = "failed";
    job.error = "Batch analysis could not be completed. Please start a fresh batch.";
    for (const item of job.items) {
      if (item.status === "analyzing") item.status = "failed";
    }
    logger.error({ err: error, jobId: job.id }, "Batch analysis failed");
  }
}

async function processJob(
  job: StoredVectorizerJob,
  concurrency: number,
): Promise<void> {
  let successfulPngCount = 0;
  let totalOutputBytes = 0;

  const processItem = async (
    item: StoredVectorizerJob["items"][number],
  ): Promise<void> => {
    if (job.cancelled) return;
    try {
      item.status = job.options.backgroundRemoval ? "removing-background" : "converting-png";
      const source = await readFile(item.sourcePath);
      const outputPng = job.options.backgroundRemoval
        ? await removeImageBackground(source)
        : await encodeImageAsPng(source);
      if (job.cancelled) return;
      if (outputPng.byteLength + totalOutputBytes > maxBatchOutputBytes) {
        throw new Error("Processed outputs exceeded the 100 MB batch limit.");
      }

      item.pngPath = path.join(job.directoryPath, `${item.suggestedName}.png`);
      totalOutputBytes += outputPng.byteLength;
      try {
        await writeFile(item.pngPath, outputPng);
      } catch (error) {
        totalOutputBytes -= outputPng.byteLength;
        throw error;
      }
      item.pngReady = true;
      successfulPngCount += 1;

      if (item.includeSvg && job.options.svgOutput) {
        item.status = "vectorizing";
        try {
          const svg = await traceTransparentPngToSvg(outputPng);
          if (job.cancelled) return;
          if (svg.byteLength + totalOutputBytes > maxBatchOutputBytes) {
            item.status = "png-only";
            addItemWarning(
              item,
              "The SVG was omitted to keep the completed batch under the 100 MB output limit.",
            );
            return;
          }
          item.svgPath = path.join(job.directoryPath, `${item.suggestedName}.svg`);
          totalOutputBytes += svg.byteLength;
          try {
            await writeFile(item.svgPath, svg);
          } catch (error) {
            totalOutputBytes -= svg.byteLength;
            throw error;
          }
          item.svgReady = true;
          item.status = "completed";
        } catch (error) {
          item.status = "png-only";
          addItemWarning(
            item,
            "The PNG is ready, but SVG tracing failed for this image.",
          );
          logger.warn(
            { err: error, jobId: job.id, itemId: item.id },
            "SVG tracing failed after PNG background removal",
          );
        }
      } else {
        item.status = "completed";
      }
    } catch (error) {
      item.status = "failed";
      item.pngReady = false;
      item.svgReady = false;
      item.pngPath = null;
      item.svgPath = null;
      addItemWarning(
        item,
        error instanceof Error &&
          error.message === "Processed outputs exceeded the 100 MB batch limit."
          ? "The batch reached its 100 MB output limit. Reduce the batch size and retry."
          : job.options.backgroundRemoval
            ? "Background removal failed. Try a different source image or start a fresh batch."
            : "PNG conversion failed. Try a different source image or start a fresh batch.",
      );
      logger.error(
        { err: error, jobId: job.id, itemId: item.id },
        "Image processing failed",
      );
    } finally {
      job.completedFiles += 1;
      job.lastAccessedAt = Date.now();
    }
  };

  let nextItemIndex = 0;
  const workerCount = Math.min(concurrency, job.items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!job.cancelled) {
        const item = job.items[nextItemIndex++];
        if (!item) return;
        await processItem(item);
      }
    }),
  );

  if (job.cancelled) return;
  job.status = successfulPngCount > 0 ? "completed" : "failed";
  if (successfulPngCount === 0) {
    job.error = "No images could be processed. Review the errors and start a fresh batch.";
  }
  job.lastAccessedAt = Date.now();
}

function batchId(req: Request): string | null {
  const parsed = GetVectorizerJobParams.safeParse({ jobId: req.params.jobId });
  return parsed.success ? parsed.data.jobId : null;
}

router.post("/vectorizer/jobs", receiveUploads, async (req, res): Promise<void> => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  try {
    const optionsInput = (req.body ?? {}) as Record<string, unknown>;
    const parseBoolean = (value: unknown, defaultValue: boolean): boolean | null => {
      if (value === undefined) return defaultValue;
      if (value === true || value === "true") return true;
      if (value === false || value === "false") return false;
      return null;
    };
    const backgroundRemoval = parseBoolean(optionsInput.backgroundRemoval, true);
    const seoNaming = parseBoolean(optionsInput.seoNaming, true);
    const svgOutput = parseBoolean(optionsInput.svgOutput, true);
    const preserveFolderStructure = parseBoolean(optionsInput.preserveFolderStructure, true);
    if (
      backgroundRemoval === null ||
      seoNaming === null ||
      svgOutput === null ||
      preserveFolderStructure === null
    ) {
      res.status(400).json({ error: "Choose valid on/off settings for this batch." });
      return;
    }
    const options: VectorizerProcessingOptions = {
      backgroundRemoval,
      seoNaming,
      svgOutput,
      preserveFolderStructure,
    };
    const userId = currentUserId(req);
    if (listOwnedVectorizerJobs(userId).length >= 3) {
      res.status(429).json({
        error: "You have several temporary batches. Delete an older batch before uploading another.",
      });
      return;
    }

    const images = await collectImages(files);
    const job = await createStoredVectorizerJob(userId, images, options);
    void analyzeJob(job);
    res.status(202).json(
      CreateVectorizerJobResponse.parse({ id: job.id, status: "analyzing" }),
    );
  } catch (error) {
    if (error instanceof UploadInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Could not create image batch");
    res.status(500).json({ error: "The batch could not be created. Please try again." });
  } finally {
    await Promise.all(
      files.map((file) => rm(file.path, { force: true }).catch(() => undefined)),
    );
  }
});

router.get("/vectorizer/jobs/:jobId", (req, res): void => {
  const id = batchId(req);
  if (!id) {
    res.status(400).json({ error: "Invalid batch ID." });
    return;
  }

  const job = getOwnedVectorizerJob(id, currentUserId(req));
  if (!job) {
    res.status(404).json({ error: "Batch not found." });
    return;
  }

  res.json(toPublicJob(job));
});

router.patch("/vectorizer/jobs/:jobId", (req, res): void => {
  const id = batchId(req);
  if (!id) {
    res.status(400).json({ error: "Invalid batch ID." });
    return;
  }

  const job = getOwnedVectorizerJob(id, currentUserId(req));
  if (!job) {
    res.status(404).json({ error: "Batch not found." });
    return;
  }
  if (job.status !== "ready") {
    res.status(409).json({ error: "This batch is not ready for review changes." });
    return;
  }

  const body = UpdateVectorizerJobItemsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Provide a valid name and SVG selection for each image." });
    return;
  }
  if (
    body.data.items.length !== job.items.length ||
    new Set(body.data.items.map((item) => item.id)).size !== job.items.length ||
    job.items.some((item) => !body.data.items.some((update) => update.id === item.id))
  ) {
    res.status(400).json({ error: "Review settings must include every image exactly once." });
    return;
  }

  const updates = new Map(body.data.items.map((item) => [item.id, item]));
  const usedNames = new Set<string>();
  for (const item of job.items) {
    const update = updates.get(item.id);
    if (!update) continue;
    const normalizedName = slugifyName(update.suggestedName);
    if (!normalizedName) {
      res.status(400).json({
        error: `The name for "${item.originalName}" must include at least one letter or number.`,
      });
      return;
    }
    item.suggestedName = uniqueName(normalizedName, usedNames);
    item.includeSvg = job.options.svgOutput && update.includeSvg;
  }

  res.json(toPublicJob(job));
});

router.post(
  "/vectorizer/jobs/:jobId/process",
  (req, res): void => {
    const id = batchId(req);
    if (!id) {
      res.status(400).json({ error: "Invalid batch ID." });
      return;
    }

    const body = ProcessVectorizerJobBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const job = getOwnedVectorizerJob(id, currentUserId(req));
    if (!job) {
      res.status(404).json({ error: "Batch not found." });
      return;
    }
    if (job.status !== "ready") {
      res.status(409).json({ error: "The batch must finish analysis before processing." });
      return;
    }

    job.status = "processing";
    job.completedFiles = 0;
    job.error = null;
    void processJob(job, body.data.concurrency);
    res.status(202).json(
      CreateVectorizerJobResponse.parse({ id: job.id, status: "processing" }),
    );
  },
);

router.delete("/vectorizer/jobs/:jobId", async (req, res): Promise<void> => {
  const id = batchId(req);
  if (!id) {
    res.status(400).json({ error: "Invalid batch ID." });
    return;
  }

  const job = getOwnedVectorizerJob(id, currentUserId(req));
  if (!job) {
    res.status(404).json({ error: "Batch not found." });
    return;
  }

  await deleteStoredVectorizerJob(job.id);
  res.sendStatus(204);
});

router.post(
  "/vectorizer/jobs/:jobId/items/:itemId/regenerate-name",
  async (req, res): Promise<void> => {
    const params = RegenerateVectorizerJobItemNameParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid batch or image ID." });
      return;
    }

    const job = getOwnedVectorizerJob(params.data.jobId, currentUserId(req));
    if (!job) {
      res.status(404).json({ error: "Batch not found." });
      return;
    }
    if (
      job.status !== "completed" ||
      job.items.length !== 1 ||
      !job.options.seoNaming
    ) {
      res.status(409).json({
        error: "Filename regeneration is available for completed, SEO-enabled single-image conversions.",
      });
      return;
    }

    const item = job.items.find((candidate) => candidate.id === params.data.itemId);
    if (!item) {
      res.status(404).json({ error: "Image not found in this batch." });
      return;
    }

    const lockKey = `${job.id}:${item.id}`;
    if (nameRegenerationLocks.has(lockKey)) {
      res.status(409).json({ error: "A new filename is already being generated for this image." });
      return;
    }
    nameRegenerationLocks.add(lockKey);

    try {
      const source = await readFile(item.sourcePath);
      const otherNames = job.items
        .filter((candidate) => candidate.id !== item.id)
        .map((candidate) => slugifyName(candidate.suggestedName))
        .filter(Boolean);
      const previousNames = [
        ...new Set([
          ...(item.suggestedNameHistory ?? []),
          item.suggestedName,
          ...otherNames,
        ].map((name) => slugifyName(name)).filter(Boolean)),
      ];
      let nextName = "";

      for (let variation = 1; variation <= 2; variation += 1) {
        const analysis = await analyzeSourceImage(source, item.originalName, {
          avoidNames: previousNames,
          variation,
        });
        const candidate = slugifyName(analysis.suggestedName);
        if (candidate && !previousNames.includes(candidate)) {
          nextName = candidate;
          break;
        }
      }

      if (!nextName) {
        throw new Error("The filename generator did not produce a distinct alternative.");
      }

      const currentJob = getOwnedVectorizerJob(params.data.jobId, currentUserId(req));
      const currentItem = currentJob?.items.find((candidate) => candidate.id === item.id);
      if (!currentJob || currentJob.status !== "completed" || !currentItem) {
        res.status(409).json({ error: "This conversion changed while its filename was being generated. Try again." });
        return;
      }

      currentItem.suggestedNameHistory = [
        ...new Set([...(currentItem.suggestedNameHistory ?? []), currentItem.suggestedName]),
      ].slice(-12);
      const usedNames = new Set(
        currentJob.items
          .filter((candidate) => candidate.id !== currentItem.id)
          .map((candidate) => slugifyName(candidate.suggestedName))
          .filter(Boolean),
      );
      currentItem.suggestedName = uniqueName(nextName, usedNames);
      res.json(GetVectorizerJobResponse.parse(toPublicJob(currentJob)));
    } catch (error) {
      req.log.warn({ err: error, jobId: job.id, itemId: item.id }, "Could not regenerate SEO filename");
      res.status(502).json({
        error: "A new filename could not be generated. Your current name and outputs are unchanged.",
      });
    } finally {
      nameRegenerationLocks.delete(lockKey);
    }
  },
);

async function sendVectorizerItemOutput(
  req: Request,
  res: Response,
  format: "png" | "svg",
): Promise<void> {
  const params = format === "png"
    ? GetVectorizerJobItemPngParams.safeParse(req.params)
    : GetVectorizerJobItemSvgParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid batch or image ID." });
    return;
  }

  const job = getOwnedVectorizerJob(params.data.jobId, currentUserId(req));
  if (!job) {
    res.status(404).json({ error: "Batch not found." });
    return;
  }
  if (job.status !== "completed") {
    res.status(409).json({ error: "Wait until processing is complete before opening this image." });
    return;
  }

  const item = job.items.find((candidate) => candidate.id === params.data.itemId);
  if (!item) {
    res.status(404).json({ error: "Image not found in this batch." });
    return;
  }
  const outputPath = format === "png"
    ? item.pngReady ? item.pngPath : null
    : item.svgReady && item.includeSvg ? item.svgPath : null;
  if (!outputPath) {
    res.status(409).json({ error: `This image does not have a ready ${format.toUpperCase()} output.` });
    return;
  }

  try {
    const output = await readFile(outputPath);
    const filename = `${item.suggestedName}.${format}`;
    res
      .status(200)
      .type(format === "png" ? "image/png" : "image/svg+xml")
      .setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .send(output);
  } catch (error) {
    req.log.error({ err: error, jobId: job.id, itemId: item.id, format }, "Could not read image output");
    res.status(500).json({ error: "The image output could not be opened. Please try again." });
  }
}

router.get(
  "/vectorizer/jobs/:jobId/items/:itemId/png",
  async (req, res): Promise<void> => {
    await sendVectorizerItemOutput(req, res, "png");
  },
);

router.get(
  "/vectorizer/jobs/:jobId/items/:itemId/svg",
  async (req, res): Promise<void> => {
    await sendVectorizerItemOutput(req, res, "svg");
  },
);

router.get("/vectorizer/jobs/:jobId/download", async (req, res): Promise<void> => {
  const id = batchId(req);
  if (!id) {
    res.status(400).json({ error: "Invalid batch ID." });
    return;
  }

  const job = getOwnedVectorizerJob(id, currentUserId(req));
  if (!job) {
    res.status(404).json({ error: "Batch not found." });
    return;
  }
  if (job.status !== "completed") {
    res.status(409).json({ error: "Wait until processing is complete before downloading." });
    return;
  }

  try {
    const archive = new JSZip();
    for (const item of job.items) {
      if (item.pngReady && item.pngPath) {
        archive.file(
          outputArchivePath(job, item, "png"),
          await readFile(item.pngPath),
          { compression: "STORE" },
        );
      }
      if (item.includeSvg && item.svgReady && item.svgPath) {
        archive.file(
          outputArchivePath(job, item, "svg"),
          await readFile(item.svgPath),
          { compression: "DEFLATE", compressionOptions: { level: 6 } },
        );
      }
    }

    if (Object.keys(archive.files).length === 0) {
      res.status(409).json({ error: "This batch has no completed output files." });
      return;
    }

    const output = await archive.generateAsync({
      type: "nodebuffer",
    });
    res
      .status(200)
      .type("application/zip")
      .attachment("vector-batch-assets.zip")
      .send(output);
  } catch (error) {
    req.log.error({ err: error, jobId: job.id }, "Could not build batch ZIP");
    res.status(500).json({ error: "The ZIP could not be prepared. Please try again." });
  }
});

export default router;