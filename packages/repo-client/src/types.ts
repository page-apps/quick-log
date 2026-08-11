export interface SelfRepository {
  readonly owner: string;
  readonly name: string;
  readonly branch: string;
}

/** Structural subset accepted from @repo-apps/credentials without exposing it to app code. */
export interface RepositoryCredentialSource {
  get(): Promise<{ readonly token: string } | null>;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;

export interface RepositoryClientOptions {
  readonly repository: SelfRepository;
  readonly credentials: RepositoryCredentialSource;
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export interface RepositoryAccess {
  readonly fullName: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly defaultBranch: string;
}

export interface RepositoryFile {
  readonly path: string;
  readonly sha: string;
  readonly content: string;
  readonly size: number;
  readonly htmlUrl?: string;
}

export interface RepositoryEntry {
  readonly type: "file" | "dir" | "symlink" | "submodule";
  readonly path: string;
  readonly name: string;
  readonly sha: string;
  readonly size: number;
  readonly downloadUrl?: string;
}

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly message: string;
}

export interface UpdateFileInput extends WriteFileInput {
  readonly expectedSha: string;
}

export interface CommitResult {
  readonly path: string;
  readonly contentSha: string;
  readonly commitSha: string;
  readonly commitUrl?: string;
}

export type CommitCheckState = "pending" | "success" | "failure" | "error" | "unknown";
export interface CommitStatus {
  readonly sha: string;
  readonly state: CommitCheckState;
  readonly description?: string;
  readonly targetUrl?: string;
}

export type WorkflowPhase = "queued" | "building" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface WorkflowStatus {
  readonly phase: WorkflowPhase;
  readonly runId?: number;
  readonly url?: string;
  readonly conclusion?: string;
}

export type DeploymentPhase = "pending" | "building" | "published" | "failed" | "inactive" | "unknown";
export interface PagesDeploymentStatus {
  readonly phase: DeploymentPhase;
  readonly deploymentId?: number;
  readonly url?: string;
  readonly environmentUrl?: string;
}

export interface DeleteFileInput {
  readonly path: string;
  readonly expectedSha: string;
  readonly message: string;
}

export interface DeleteResult {
  readonly path: string;
  readonly deletedSha: string;
  readonly commitSha: string;
  readonly commitUrl?: string;
}

export interface BatchWriteChange {
  readonly operation: "write";
  readonly path: string;
  readonly content: string;
  /** Omit to create/replace; provide to reject a stale file revision. */
  readonly expectedSha?: string;
}

export interface BatchDeleteChange {
  readonly operation: "delete";
  readonly path: string;
  readonly expectedSha: string;
}

export type BatchChange = BatchWriteChange | BatchDeleteChange;

export interface BatchCommitInput {
  readonly message: string;
  readonly changes: readonly BatchChange[];
  /** Optional optimistic branch revision; a mismatch is an explicit conflict. */
  readonly expectedHeadSha?: string;
}

export interface BatchCommitResult {
  readonly previousHeadSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly changedPaths: readonly string[];
  readonly commitUrl?: string;
}

export interface RepositoryClient {
  readonly repository: SelfRepository;
  verifyAccess(): Promise<RepositoryAccess>;
  readFile(path: string): Promise<RepositoryFile>;
  list(path?: string): Promise<readonly RepositoryEntry[]>;
  createFile(input: WriteFileInput): Promise<CommitResult>;
  updateFile(input: UpdateFileInput): Promise<CommitResult>;
  getCommitStatus(ref: string): Promise<CommitStatus>;
  getWorkflowStatus(ref: string): Promise<WorkflowStatus>;
  getPagesDeploymentStatus(ref: string): Promise<PagesDeploymentStatus>;
  deleteFile(input: DeleteFileInput): Promise<DeleteResult>;
  batchCommit(input: BatchCommitInput): Promise<BatchCommitResult>;
}
