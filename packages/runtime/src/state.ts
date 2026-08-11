export const RUNTIME_STATUSES = [
  "demo", "disconnected", "connecting", "unauthorised-for-repository", "loading", "ready",
  "dirty", "offline", "syncing", "committed", "building", "published", "conflicted",
  "rate-limited", "token-expired", "failed",
] as const;

export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export interface RuntimeConflict<T = unknown> {
  readonly local: T;
  readonly remote?: T;
  readonly expectedSha?: string;
}

export interface OfflineDraft<T = unknown> {
  readonly data: T;
  readonly savedAt: string;
  readonly baseRevision?: string;
}

export interface PendingMutation<T = unknown> {
  readonly id: string;
  readonly operation: "save" | "delete";
  readonly path: string;
  readonly message: string;
  readonly queuedAt: string;
  readonly expectedSha?: string;
  readonly data?: T;
}

export interface RuntimeState<T = unknown> {
  readonly status: RuntimeStatus;
  readonly data?: T;
  readonly revision?: string;
  readonly commitSha?: string;
  readonly commitUrl?: string;
  readonly conflict?: RuntimeConflict<T>;
  readonly message?: string;
  readonly retryAt?: string;
  readonly draft?: OfflineDraft<T>;
  readonly pendingMutations?: readonly PendingMutation<T>[];
}

export type RuntimeAction<T = unknown> =
  | { readonly type: "CONNECT" }
  | { readonly type: "DISCONNECT" }
  | { readonly type: "LOAD_DEMO"; readonly data: T }
  | { readonly type: "LOAD_START" }
  | { readonly type: "LOAD_SUCCESS"; readonly data: T; readonly revision: string }
  | { readonly type: "DIRTY"; readonly data: T }
  | { readonly type: "SYNC_START" }
  | { readonly type: "COMMIT_SUCCESS"; readonly revision: string; readonly commitSha: string; readonly commitUrl?: string }
  | { readonly type: "DELETE_SUCCESS"; readonly commitSha: string; readonly commitUrl?: string }
  | { readonly type: "BATCH_COMMIT_SUCCESS"; readonly commitSha: string; readonly commitUrl?: string }
  | { readonly type: "BUILD_START" }
  | { readonly type: "PUBLISH_SUCCESS" }
  | { readonly type: "CONFLICT"; readonly local: T; readonly remote?: T; readonly expectedSha?: string }
  | { readonly type: "OFFLINE"; readonly message?: string }
  | { readonly type: "UNAUTHORISED"; readonly message?: string }
  | { readonly type: "TOKEN_EXPIRED"; readonly message?: string }
  | { readonly type: "RATE_LIMITED"; readonly retryAt?: string }
  | { readonly type: "DRAFT_SAVED"; readonly draft: OfflineDraft<T> }
  | { readonly type: "DRAFT_RESTORED"; readonly draft: OfflineDraft<T> }
  | { readonly type: "DRAFT_CLEARED" }
  | { readonly type: "MUTATION_QUEUED"; readonly mutation: PendingMutation<T> }
  | { readonly type: "MUTATION_REMOVED"; readonly id: string }
  | { readonly type: "FAIL"; readonly message: string };

export function createInitialRuntimeState(options: { hasCredential?: boolean } = {}): RuntimeState {
  return { status: options.hasCredential ? "loading" : "demo" };
}

export function runtimeReducer<T>(state: RuntimeState<T>, action: RuntimeAction<T>): RuntimeState<T> {
  switch (action.type) {
    case "CONNECT": return preserve(state, { status: "connecting" });
    case "DISCONNECT": return { status: "demo", ...(state.data === undefined ? {} : { data: state.data }) };
    case "LOAD_DEMO": return { status: "demo", data: action.data };
    case "LOAD_START": return preserve(state, { status: "loading", message: undefined });
    case "LOAD_SUCCESS": return preserve(state, { status: "ready", data: action.data, revision: action.revision, message: undefined });
    case "DIRTY": return preserve(state, { status: "dirty", data: action.data });
    case "SYNC_START": return preserve(state, { status: "syncing", message: undefined });
    case "COMMIT_SUCCESS": return preserve(state, {
      status: "committed", revision: action.revision, commitSha: action.commitSha,
      commitUrl: action.commitUrl, draft: undefined,
    });
    case "DELETE_SUCCESS": return preserve(state, {
      status: "committed", data: undefined, revision: undefined, commitSha: action.commitSha,
      commitUrl: action.commitUrl, draft: undefined,
    });
    case "BATCH_COMMIT_SUCCESS": return preserve(state, {
      status: "committed", commitSha: action.commitSha, commitUrl: action.commitUrl,
    });
    case "BUILD_START": return preserve(state, { status: "building" });
    case "PUBLISH_SUCCESS": return preserve(state, { status: "published" });
    case "CONFLICT": return preserve(state, {
      status: "conflicted",
      conflict: { local: action.local, ...(action.remote === undefined ? {} : { remote: action.remote }), ...(action.expectedSha === undefined ? {} : { expectedSha: action.expectedSha }) },
    });
    case "OFFLINE": return preserve(state, { status: "offline", message: action.message });
    case "UNAUTHORISED": return preserve(state, { status: "unauthorised-for-repository", message: action.message });
    case "TOKEN_EXPIRED": return preserve(state, { status: "token-expired", message: action.message });
    case "RATE_LIMITED": return preserve(state, { status: "rate-limited", retryAt: action.retryAt });
    case "DRAFT_SAVED": return preserve(state, { draft: action.draft });
    case "DRAFT_RESTORED": return preserve(state, { status: "dirty", data: action.draft.data, draft: action.draft });
    case "DRAFT_CLEARED": return preserve(state, { draft: undefined });
    case "MUTATION_QUEUED": return preserve(state, {
      pendingMutations: [...(state.pendingMutations ?? []), action.mutation],
    });
    case "MUTATION_REMOVED": return preserve(state, {
      pendingMutations: (state.pendingMutations ?? []).filter((mutation) => mutation.id !== action.id),
    });
    case "FAIL": return preserve(state, { status: "failed", message: action.message });
  }
}

type RuntimeChanges<T> = {
  [K in keyof RuntimeState<T>]?: RuntimeState<T>[K] | undefined;
};

function preserve<T>(state: RuntimeState<T>, changes: RuntimeChanges<T>): RuntimeState<T> {
  const result = { ...state, ...changes };
  for (const key of ["message", "commitUrl", "retryAt", "data", "revision", "draft"] as const) {
    if (changes[key] === undefined && key in changes) delete result[key];
  }
  return result as RuntimeState<T>;
}
