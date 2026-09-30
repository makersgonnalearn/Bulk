import type { VectorizerJob } from "@workspace/api-client-react";

const databaseName = "vector-batch-studio-local";
const databaseVersion = 2;
const batchStoreName = "batches";
const sourceStoreName = "sources";
const archiveStoreName = "archives";

export type SavedSourceFile = {
  index: number;
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
};

export type BatchProcessingOptions = {
  backgroundRemoval: boolean;
  seoNaming: boolean;
  svgOutput: boolean;
  preserveFolderStructure?: boolean;
  quickConvert?: boolean;
};

export type SavedBatch = {
  id: string;
  ownerId: string;
  jobId: string | null;
  createdAt: number;
  updatedAt: number;
  sourceFileCount: number;
  hasResultArchive: boolean;
  processingOptions?: BatchProcessingOptions;
  job: VectorizerJob | null;
};

export type SavedBatchRecord = SavedBatch & {
  sourceFiles: SavedSourceFile[];
  resultArchive: Blob | null;
};

export type BrowserStorageEstimate = {
  usage: number | null;
  quota: number | null;
  ratio: number | null;
};

type StoredSourceFile = SavedSourceFile & {
  key: string;
  batchId: string;
  ownerId: string;
};

type StoredArchive = {
  batchId: string;
  ownerId: string;
  blob: Blob;
};

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser does not support local file storage."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      let batches: IDBObjectStore;
      if (!database.objectStoreNames.contains(batchStoreName)) {
        batches = database.createObjectStore(batchStoreName, { keyPath: "id" });
      } else {
        batches = request.transaction!.objectStore(batchStoreName);
      }
      if (!batches.indexNames.contains("ownerId")) {
        batches.createIndex("ownerId", "ownerId", { unique: false });
      }

      let sources: IDBObjectStore;
      if (!database.objectStoreNames.contains(sourceStoreName)) {
        sources = database.createObjectStore(sourceStoreName, { keyPath: "key" });
      } else {
        sources = request.transaction!.objectStore(sourceStoreName);
      }
      if (!sources.indexNames.contains("batchId")) {
        sources.createIndex("batchId", "batchId", { unique: false });
      }
      if (!sources.indexNames.contains("ownerId")) {
        sources.createIndex("ownerId", "ownerId", { unique: false });
      }

      let archives: IDBObjectStore;
      if (!database.objectStoreNames.contains(archiveStoreName)) {
        archives = database.createObjectStore(archiveStoreName, { keyPath: "batchId" });
      } else {
        archives = request.transaction!.objectStore(archiveStoreName);
      }

      if (event.oldVersion === 1) {
        const cursorRequest = batches.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const old = cursor.value as SavedBatchRecord;
          for (const [index, file] of (old.sourceFiles ?? []).entries()) {
            sources.put({
              ...file,
              index,
              key: `${old.id}:${index}`,
              batchId: old.id,
              ownerId: old.ownerId,
            } satisfies StoredSourceFile);
          }
          if (old.resultArchive) {
            archives.put({ batchId: old.id, ownerId: old.ownerId, blob: old.resultArchive } satisfies StoredArchive);
          }
          const migrated: SavedBatch = {
            id: old.id,
            ownerId: old.ownerId,
            jobId: old.jobId,
            createdAt: old.createdAt,
            updatedAt: old.updatedAt,
            sourceFileCount: old.sourceFiles?.length ?? 0,
            hasResultArchive: Boolean(old.resultArchive),
            processingOptions: old.processingOptions,
            job: old.job ?? null,
          };
          cursor.update(migrated);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local archive could not be opened."));
    request.onblocked = () => reject(new Error("Close other Vector Batch Studio tabs to update local storage."));
  });
}

function runTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction, setResult: (value: T) => void) => void,
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeNames, mode);
    let result: T | undefined;
    run(transaction, (value) => { result = value; });
    transaction.oncomplete = () => {
      database.close();
      resolve(result as T);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Local archive operation failed."));
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Local archive operation failed."));
    };
  }));
}

function metadataFromRecord(record: SavedBatchRecord): SavedBatch {
  const { sourceFiles, resultArchive, ...metadata } = record;
  return {
    ...metadata,
    sourceFileCount: sourceFiles.length,
    hasResultArchive: Boolean(resultArchive),
  };
}

export function createSavedBatch(
  ownerId: string,
  files: File[],
  processingOptions: BatchProcessingOptions,
): SavedBatchRecord {
  const now = Date.now();
  const id = crypto.randomUUID();
  const sourceFiles = files.map((file, index) => ({
    index,
    name: file.name,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
    blob: file.slice(0, file.size, file.type || "application/octet-stream"),
  }));
  return {
    id,
    ownerId,
    jobId: null,
    createdAt: now,
    updatedAt: now,
    sourceFileCount: sourceFiles.length,
    hasResultArchive: false,
    processingOptions,
    sourceFiles,
    job: null,
    resultArchive: null,
  };
}

export function saveBatch(record: SavedBatchRecord): Promise<string> {
  const metadata = metadataFromRecord(record);
  return runTransaction(
    [batchStoreName, sourceStoreName],
    "readwrite",
    (transaction, setResult) => {
      transaction.objectStore(batchStoreName).put(metadata);
      const sources = transaction.objectStore(sourceStoreName);
      for (const file of record.sourceFiles) {
        sources.put({
          ...file,
          key: `${record.id}:${file.index}`,
          batchId: record.id,
          ownerId: record.ownerId,
        } satisfies StoredSourceFile);
      }
      setResult(record.id);
    },
  );
}

export function updateSavedBatch(
  batchId: string,
  update: (batch: SavedBatch) => SavedBatch,
): Promise<SavedBatch | null> {
  return runTransaction([batchStoreName], "readwrite", (transaction, setResult) => {
    const store = transaction.objectStore(batchStoreName);
    const request = store.get(batchId);
    request.onsuccess = () => {
      const existing = request.result as SavedBatch | undefined;
      if (!existing) {
        setResult(null);
        return;
      }
      const updated = update(existing);
      store.put(updated);
      setResult(updated);
    };
  });
}

export function saveResultArchive(batchId: string, ownerId: string, archive: Blob): Promise<boolean> {
  return runTransaction(
    [batchStoreName, archiveStoreName],
    "readwrite",
    (transaction, setResult) => {
      const batches = transaction.objectStore(batchStoreName);
      const request = batches.get(batchId);
      request.onsuccess = () => {
        const batch = request.result as SavedBatch | undefined;
        if (!batch || batch.ownerId !== ownerId) {
          setResult(false);
          return;
        }
        batches.put({ ...batch, hasResultArchive: true, updatedAt: Date.now() });
        transaction.objectStore(archiveStoreName).put({ batchId, ownerId, blob: archive } satisfies StoredArchive);
        setResult(true);
      };
    },
  );
}

export async function getSavedBatch(batchId: string): Promise<SavedBatchRecord | null> {
  return runTransaction(
    [batchStoreName, sourceStoreName, archiveStoreName],
    "readonly",
    (transaction, setResult) => {
      let metadata: SavedBatch | undefined;
      let sourceFiles: StoredSourceFile[] = [];
      let resultArchive: Blob | null = null;
      let pending = 3;
      const complete = () => {
        pending -= 1;
        if (pending !== 0) return;
        setResult(metadata ? {
          ...metadata,
          sourceFiles: sourceFiles
            .sort((a, b) => a.index - b.index)
            .map(({ key: _key, batchId: _batchId, ownerId: _ownerId, ...file }) => file),
          resultArchive,
        } : null);
      };

      const batchRequest = transaction.objectStore(batchStoreName).get(batchId);
      batchRequest.onsuccess = () => { metadata = batchRequest.result as SavedBatch | undefined; complete(); };
      const sourceRequest = transaction.objectStore(sourceStoreName).index("batchId").getAll(IDBKeyRange.only(batchId));
      sourceRequest.onsuccess = () => { sourceFiles = sourceRequest.result as StoredSourceFile[]; complete(); };
      const archiveRequest = transaction.objectStore(archiveStoreName).get(batchId);
      archiveRequest.onsuccess = () => {
        resultArchive = (archiveRequest.result as StoredArchive | undefined)?.blob ?? null;
        complete();
      };
    },
  );
}

export function getSavedSourceFiles(batchId: string): Promise<SavedSourceFile[]> {
  return runTransaction([sourceStoreName], "readonly", (transaction, setResult) => {
    const request = transaction.objectStore(sourceStoreName).index("batchId").getAll(IDBKeyRange.only(batchId));
    request.onsuccess = () => {
      const sources = request.result as StoredSourceFile[];
      setResult(sources
        .sort((a, b) => a.index - b.index)
        .map(({ key: _key, batchId: _batchId, ownerId: _ownerId, ...file }) => file));
    };
  });
}

export function getSavedResultArchive(batchId: string): Promise<Blob | null> {
  return runTransaction([archiveStoreName], "readonly", (transaction, setResult) => {
    const request = transaction.objectStore(archiveStoreName).get(batchId);
    request.onsuccess = () => setResult((request.result as StoredArchive | undefined)?.blob ?? null);
  });
}

export function listSavedBatches(ownerId: string): Promise<SavedBatch[]> {
  return runTransaction([batchStoreName], "readonly", (transaction, setResult) => {
    const request = transaction
      .objectStore(batchStoreName)
      .index("ownerId")
      .getAll(IDBKeyRange.only(ownerId));
    request.onsuccess = () => {
      const batches = request.result as SavedBatch[];
      setResult(batches.sort((a, b) => b.updatedAt - a.updatedAt));
    };
  });
}

export function deleteSavedBatch(batchId: string): Promise<undefined> {
  return runTransaction(
    [batchStoreName, sourceStoreName, archiveStoreName],
    "readwrite",
    (transaction, setResult) => {
      transaction.objectStore(batchStoreName).delete(batchId);
      transaction.objectStore(archiveStoreName).delete(batchId);
      const request = transaction.objectStore(sourceStoreName).index("batchId").openCursor(IDBKeyRange.only(batchId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      setResult(undefined);
    },
  );
}

export async function deleteAllSavedBatches(ownerId: string): Promise<number> {
  const batches = await listSavedBatches(ownerId);
  await Promise.all(batches.map((batch) => deleteSavedBatch(batch.id)));
  return batches.length;
}

export async function getBrowserStorageEstimate(): Promise<BrowserStorageEstimate> {
  try {
    const estimate = await navigator.storage?.estimate();
    const usage = typeof estimate?.usage === "number" ? estimate.usage : null;
    const quota = typeof estimate?.quota === "number" ? estimate.quota : null;
    return {
      usage,
      quota,
      ratio: usage !== null && quota ? usage / quota : null,
    };
  } catch {
    return { usage: null, quota: null, ratio: null };
  }
}

export async function requestPersistentBrowserStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is best-effort; saved batches remain available in IndexedDB.
  }
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}