import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type VectorizerJobStatus =
  | "analyzing"
  | "ready"
  | "processing"
  | "completed"
  | "failed";

export type VectorizerItemStatus =
  | "analyzing"
  | "ready"
  | "removing-background"
  | "converting-png"
  | "vectorizing"
  | "completed"
  | "png-only"
  | "failed";

export type StoredVectorizerItem = {
  id: string;
  originalName: string;
  originalPath: string;
  suggestedName: string;
  suggestedNameHistory: string[];
  includeSvg: boolean;
  status: VectorizerItemStatus;
  error: string | null;
  pngReady: boolean;
  svgReady: boolean;
  sourcePath: string;
  pngPath: string | null;
  svgPath: string | null;
};

export type VectorizerProcessingOptions = {
  backgroundRemoval: boolean;
  seoNaming: boolean;
  svgOutput: boolean;
  preserveFolderStructure: boolean;
};

export type StoredVectorizerJob = {
  id: string;
  ownerId: string;
  status: VectorizerJobStatus;
  totalFiles: number;
  completedFiles: number;
  options: VectorizerProcessingOptions;
  items: StoredVectorizerItem[];
  error: string | null;
  directoryPath: string;
  createdAt: number;
  lastAccessedAt: number;
  cancelled: boolean;
};

export type StoredImageInput = {
  originalName: string;
  originalPath: string;
  extension: "png" | "jpg";
  buffer: Buffer;
};

const jobs = new Map<string, StoredVectorizerJob>();
const jobRoot = path.join(tmpdir(), "vector-batch-studio", "jobs");
const jobTtlMs = 2 * 60 * 60 * 1000;

export async function createStoredVectorizerJob(
  ownerId: string,
  images: StoredImageInput[],
  options: VectorizerProcessingOptions,
): Promise<StoredVectorizerJob> {
  const id = randomUUID();
  const directoryPath = path.join(jobRoot, id);
  await mkdir(directoryPath, { recursive: true });

  const now = Date.now();
  const items: StoredVectorizerItem[] = [];

  try {
    for (const image of images) {
      const itemId = randomUUID();
      const sourcePath = path.join(
        directoryPath,
        `${itemId}-source.${image.extension}`,
      );
      await writeFile(sourcePath, image.buffer, { flag: "wx" });
      items.push({
        id: itemId,
        originalName: image.originalName,
        originalPath: image.originalPath,
        suggestedName: "",
        suggestedNameHistory: [],
        includeSvg: false,
        status: "analyzing",
        error: null,
        pngReady: false,
        svgReady: false,
        sourcePath,
        pngPath: null,
        svgPath: null,
      });
    }
  } catch (error) {
    await rm(directoryPath, { recursive: true, force: true });
    throw error;
  }

  const job: StoredVectorizerJob = {
    id,
    ownerId,
    status: "analyzing",
    totalFiles: items.length,
    completedFiles: 0,
    options,
    items,
    error: null,
    directoryPath,
    createdAt: now,
    lastAccessedAt: now,
    cancelled: false,
  };

  jobs.set(id, job);
  return job;
}

export function getOwnedVectorizerJob(
  jobId: string,
  ownerId: string,
): StoredVectorizerJob | null {
  const job = jobs.get(jobId);
  if (!job || job.ownerId !== ownerId || job.cancelled) return null;
  job.lastAccessedAt = Date.now();
  return job;
}

export function listOwnedVectorizerJobs(ownerId: string): StoredVectorizerJob[] {
  return [...jobs.values()].filter(
    (job) => job.ownerId === ownerId && !job.cancelled,
  );
}

export async function deleteStoredVectorizerJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.cancelled = true;
  jobs.delete(jobId);
  await rm(job.directoryPath, { recursive: true, force: true });
}

async function pruneExpiredJobs(): Promise<void> {
  const now = Date.now();
  const expired = [...jobs.values()].filter(
    (job) => now - job.lastAccessedAt > jobTtlMs,
  );
  await Promise.all(
    expired.map((job) => deleteStoredVectorizerJob(job.id).catch(() => undefined)),
  );
}

const cleanupTimer = setInterval(() => {
  void pruneExpiredJobs();
}, 10 * 60 * 1000);
cleanupTimer.unref();