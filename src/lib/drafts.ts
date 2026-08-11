export interface QuickLogDraft {
  id: string;
  title: string;
  body: string;
  tags: string;
  occurredAt: string;
  savedAt: string;
}

const databaseName = "quick-log-local-v1";
const storeName = "drafts";
const editorKey = "editor";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Could not open the local draft database.")));
    request.addEventListener("blocked", () => reject(new Error("Local draft storage is blocked by another tab.")));
  });
}

async function runStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("Local draft storage failed.")));
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Local draft storage was interrupted.")));
    });
  } finally {
    database.close();
  }
}

export async function loadDraft(): Promise<QuickLogDraft | null> {
  try {
    const value = await runStore<unknown>("readonly", (store) => store.get(editorKey));
    return isDraft(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveDraft(draft: QuickLogDraft): Promise<boolean> {
  try {
    await runStore<IDBValidKey>("readwrite", (store) => store.put(draft, editorKey));
    return true;
  } catch {
    return false;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await runStore<undefined>("readwrite", (store) => store.delete(editorKey));
  } catch {
    // Draft cleanup is best effort and must never break repository operations.
  }
}

export function isDraft(value: unknown): value is QuickLogDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return ["id", "title", "body", "tags", "occurredAt", "savedAt"].every((key) => typeof draft[key] === "string");
}

export function hasDraftContent(draft: Pick<QuickLogDraft, "title" | "body" | "tags">): boolean {
  return Boolean(draft.title.trim() || draft.body.trim() || draft.tags.trim());
}
