import { useEffect, useState } from "react";
import { Archive, ChevronDown, Download, HardDrive, TriangleAlert, Trash2 } from "lucide-react";
import {
  deleteAllSavedBatches,
  deleteSavedBatch,
  formatStorageBytes,
  getBrowserStorageEstimate,
  getSavedResultArchive,
  getSavedSourceFiles,
  listSavedBatches,
  type BrowserStorageEstimate,
  type SavedBatch,
  type SavedSourceFile,
} from "@/lib/local-archive";

type LocalArchivePanelProps = {
  ownerId: string;
  refreshKey: number;
  onOpenJob: (batchId: string, jobId: string, quickConvert: boolean) => void;
  onRetryBatch: (batchId: string) => void;
  onDeleteBatch: (batchId: string) => void;
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function batchStatus(batch: SavedBatch): string {
  if (batch.job?.status === "processing") return "Processing";
  if (batch.job?.status === "analyzing") return "Analyzing";
  if (batch.job?.status === "ready") return "Ready to process";
  if (batch.job?.status === "failed") return "Needs attention";
  if (batch.job?.status === "completed" && batch.hasResultArchive) return "Results saved";
  if (batch.job?.status === "completed") return "Completed";
  if (batch.hasResultArchive) return "Results saved";
  if (batch.jobId) return "Uploaded";
  return "Originals saved";
}

export function LocalArchivePanel({
  ownerId,
  refreshKey,
  onOpenJob,
  onRetryBatch,
  onDeleteBatch,
}: LocalArchivePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [batches, setBatches] = useState<SavedBatch[]>([]);
  const [storage, setStorage] = useState<BrowserStorageEstimate>({
    usage: null,
    quota: null,
    ratio: null,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadedSources, setLoadedSources] = useState<Record<string, SavedSourceFile[]>>({});

  const refresh = async () => {
    try {
      const [saved, estimate] = await Promise.all([
        listSavedBatches(ownerId),
        getBrowserStorageEstimate(),
      ]);
      setBatches(saved);
      setStorage(estimate);
      setError("");
    } catch {
      setError("Local copies could not be read in this browser.");
    }
  };

  useEffect(() => {
    void refresh();
  }, [ownerId, refreshKey]);

  const removeBatch = async (batch: SavedBatch) => {
    if (!window.confirm(`Delete the local copy of this batch and its ${batch.sourceFileCount} original file(s)?`)) return;
    setBusy(true);
    try {
      await deleteSavedBatch(batch.id);
      onDeleteBatch(batch.id);
      await refresh();
    } catch {
      setError("This local copy could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    if (!batches.length || !window.confirm(`Delete all ${batches.length} locally saved batch(es) from this browser?`)) return;
    setBusy(true);
    try {
      await deleteAllSavedBatches(ownerId);
      batches.forEach((batch) => onDeleteBatch(batch.id));
      await refresh();
    } catch {
      setError("The local copies could not be cleared.");
    } finally {
      setBusy(false);
    }
  };

  const storagePercent = storage.ratio === null ? null : Math.min(100, Math.round(storage.ratio * 100));
  const storageIsHigh = storage.ratio !== null && storage.ratio >= 0.8;

  const loadSources = async (batchId: string): Promise<SavedSourceFile[]> => {
    if (loadedSources[batchId]) return loadedSources[batchId];
    try {
      const files = await getSavedSourceFiles(batchId);
      setLoadedSources((existing) => ({ ...existing, [batchId]: files }));
      return files;
    } catch {
      setError("The saved originals could not be read.");
      return [];
    }
  };

  const downloadArchive = async (batchId: string) => {
    try {
      const archive = await getSavedResultArchive(batchId);
      if (!archive) throw new Error("Archive is missing");
      downloadBlob(archive, "vector-batch-assets.zip");
    } catch {
      setError("The saved result ZIP could not be read.");
    }
  };

  return (
    <section className="border-b border-border bg-card/70 px-5 py-3 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 items-center gap-2 text-xs font-bold text-foreground"
        >
          <HardDrive size={15} className="shrink-0 text-primary" />
          <span>Saved on this browser</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{batches.length}</span>
          {storagePercent !== null && (
            <span className={`text-[10px] font-medium ${storageIsHigh ? "text-destructive" : "text-muted-foreground"}`}>
              {storagePercent}% storage used
            </span>
          )}
          <ChevronDown size={14} className={`text-muted-foreground transition ${expanded ? "rotate-180" : ""}`} />
        </button>
        <p className="text-[10px] text-muted-foreground">Originals and completed ZIPs stay here until you delete them.</p>
      </div>

      {storageIsHigh && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            Browser storage is getting full. Download important ZIPs, then clear saved batches to make room.
            {storage.usage !== null && storage.quota !== null && ` (${formatStorageBytes(storage.usage)} of ${formatStorageBytes(storage.quota)} used)`}
          </span>
        </div>
      )}

      {expanded && (
        <div className="mt-4 rounded-xl border border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="text-xs font-bold">Local batch copies</p>
              <p className="mt-1 text-[10px] text-muted-foreground">Only this browser profile can see these files. Clearing site data also removes them.</p>
            </div>
            <button
              type="button"
              onClick={removeAll}
              disabled={busy || batches.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[10px] font-bold text-muted-foreground transition hover:bg-muted disabled:opacity-40"
            >
              <Trash2 size={12} /> Clear saved copies
            </button>
          </div>

          {error && <p role="alert" className="px-4 py-3 text-xs text-destructive">{error}</p>}
          {batches.length === 0 && !error && (
            <p className="px-4 py-5 text-xs text-muted-foreground">No batches are saved in this browser yet.</p>
          )}
          {batches.length > 0 && (
            <div className="divide-y divide-border">
              {batches.map((batch) => (
                <article key={batch.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-xs font-bold">{batch.job?.items[0]?.originalName ?? "Image batch"}</p>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[9px] font-bold text-muted-foreground">{batchStatus(batch)}</span>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {batch.sourceFileCount} original file(s) · {new Date(batch.updatedAt).toLocaleString()}
                    </p>
                    {batch.sourceFileCount > 1 && (
                      <details
                        className="mt-2 text-[10px] text-muted-foreground"
                        onToggle={(event) => { if (event.currentTarget.open) void loadSources(batch.id); }}
                      >
                        <summary className="cursor-pointer">Download original files individually</summary>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {(loadedSources[batch.id] ?? []).map((file) => (
                            <button
                              key={`${file.name}-${file.index}`}
                              type="button"
                              onClick={() => downloadBlob(file.blob, file.name)}
                              className="underline underline-offset-2 hover:text-foreground"
                            >
                              {file.name}
                            </button>
                          ))}
                        </div>
                      </details>
                    )}
                    {batch.sourceFileCount === 1 && (
                      <button
                        type="button"
                        onClick={() => void loadSources(batch.id).then((files) => {
                          const file = files[0];
                          if (file) downloadBlob(file.blob, file.name);
                        })}
                        className="mt-2 text-[10px] text-primary underline underline-offset-2"
                      >
                        Download original
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {batch.hasResultArchive && (
                      <button
                        type="button"
                        onClick={() => void downloadArchive(batch.id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[10px] font-bold text-primary-foreground"
                      >
                        <Download size={12} /> Results ZIP
                      </button>
                    )}
                    {batch.jobId ? (
                      <button
                        type="button"
                        onClick={() => onOpenJob(batch.id, batch.jobId!, batch.processingOptions?.quickConvert === true)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10px] font-bold hover:bg-muted"
                      >
                        <Archive size={12} /> Open batch
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onRetryBatch(batch.id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10px] font-bold hover:bg-muted"
                      >
                        <Archive size={12} /> Upload saved files
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Delete this local batch copy"
                      onClick={() => void removeBatch(batch)}
                      disabled={busy}
                      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}