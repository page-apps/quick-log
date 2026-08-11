import {
  AuthenticationError,
  ConflictError,
  RepositoryError,
  ValidationError,
  errorForResponse,
} from "./errors.js";
import type {
  BatchCommitInput,
  BatchCommitResult,
  BatchChange,
  CommitResult,
  CommitStatus,
  DeleteFileInput,
  DeleteResult,
  DeploymentPhase,
  FetchLike,
  FetchResponse,
  PagesDeploymentStatus,
  RepositoryAccess,
  RepositoryClient,
  RepositoryClientOptions,
  RepositoryEntry,
  RepositoryFile,
  SelfRepository,
  UpdateFileInput,
  WorkflowPhase,
  WorkflowStatus,
  WriteFileInput,
} from "./types.js";

export function createRepositoryClient(options: RepositoryClientOptions): RepositoryClient {
  return new GitHubRepositoryClient(options);
}

export class GitHubRepositoryClient implements RepositoryClient {
  readonly repository: SelfRepository;
  readonly #credentials: RepositoryClientOptions["credentials"];
  readonly #fetch: FetchLike;
  readonly #base: string;

  constructor(options: RepositoryClientOptions) {
    this.repository = validateRepository(options.repository);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#base = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  async verifyAccess(): Promise<RepositoryAccess> {
    const value = asRecord(await this.#request(this.#repoPath()));
    const permissions = isRecord(value.permissions) ? value.permissions : {};
    return {
      fullName: stringField(value, "full_name"),
      canRead: permissions.pull === true || permissions.push === true || permissions.admin === true,
      canWrite: permissions.push === true || permissions.admin === true || permissions.maintain === true,
      defaultBranch: stringField(value, "default_branch"),
    };
  }

  async readFile(path: string): Promise<RepositoryFile> {
    const value = asRecord(await this.#request(this.#contentsPath(path, true)));
    if (value.type !== "file") throw new ValidationError("The requested path is not a file.");
    return {
      path: stringField(value, "path"),
      sha: stringField(value, "sha"),
      content: decodeBase64(stringField(value, "content").replace(/\s/g, "")),
      size: numberField(value, "size"),
      ...(typeof value.html_url === "string" ? { htmlUrl: value.html_url } : {}),
    };
  }

  async list(path = ""): Promise<readonly RepositoryEntry[]> {
    const value = await this.#request(this.#contentsPath(path, true));
    if (!Array.isArray(value)) throw new ValidationError("The requested path is not a directory.");
    return value.map((entry) => {
      const item = asRecord(entry);
      const type = item.type;
      if (type !== "file" && type !== "dir" && type !== "symlink" && type !== "submodule") {
        throw invalidResponse("directory entry type");
      }
      return {
        type,
        path: stringField(item, "path"),
        name: stringField(item, "name"),
        sha: stringField(item, "sha"),
        size: numberField(item, "size"),
        ...(typeof item.download_url === "string" ? { downloadUrl: item.download_url } : {}),
      };
    });
  }

  async createFile(input: WriteFileInput): Promise<CommitResult> {
    validateWrite(input);
    return this.#write(input, undefined);
  }

  async updateFile(input: UpdateFileInput): Promise<CommitResult> {
    validateWrite(input);
    if (!input.expectedSha.trim()) throw new ValidationError("expectedSha is required for an update.");
    return this.#write(input, input.expectedSha);
  }

  async getCommitStatus(ref: string): Promise<CommitStatus> {
    const safeRef = validateRef(ref);
    const value = asRecord(await this.#request(`${this.#repoPath()}/commits/${encodeURIComponent(safeRef)}/status`));
    const state = value.state;
    return {
      sha: stringField(value, "sha"),
      state: state === "pending" || state === "success" || state === "failure" || state === "error" ? state : "unknown",
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(typeof value.target_url === "string" ? { targetUrl: value.target_url } : {}),
    };
  }

  async getWorkflowStatus(ref: string): Promise<WorkflowStatus> {
    const safeRef = validateRef(ref);
    const query = new URLSearchParams({ branch: this.repository.branch, head_sha: safeRef, per_page: "10" });
    const value = asRecord(await this.#request(`${this.#repoPath()}/actions/runs?${query}`));
    const runs = Array.isArray(value.workflow_runs) ? value.workflow_runs : [];
    const first = runs.find((run) => isRecord(run) && run.head_sha === safeRef);
    if (!isRecord(first)) return { phase: "unknown" };
    const conclusion = typeof first.conclusion === "string" ? first.conclusion : undefined;
    return {
      phase: workflowPhase(first.status, conclusion),
      ...(typeof first.id === "number" ? { runId: first.id } : {}),
      ...(typeof first.html_url === "string" ? { url: first.html_url } : {}),
      ...(conclusion === undefined ? {} : { conclusion }),
    };
  }

  async getPagesDeploymentStatus(ref: string): Promise<PagesDeploymentStatus> {
    const safeRef = validateRef(ref);
    const query = new URLSearchParams({ sha: safeRef, environment: "github-pages", per_page: "1" });
    const deployments = await this.#request(`${this.#repoPath()}/deployments?${query}`);
    if (!Array.isArray(deployments) || !isRecord(deployments[0]) || typeof deployments[0].id !== "number") {
      return { phase: "unknown" };
    }
    const deployment = deployments[0];
    const deploymentId = deployment.id as number;
    const statuses = await this.#request(`${this.#repoPath()}/deployments/${deploymentId}/statuses?per_page=1`);
    const status = Array.isArray(statuses) && isRecord(statuses[0]) ? statuses[0] : undefined;
    return {
      phase: deploymentPhase(status?.state),
      deploymentId,
      ...(typeof deployment.url === "string" ? { url: deployment.url } : {}),
      ...(typeof status?.environment_url === "string" ? { environmentUrl: status.environment_url } : {}),
    };
  }

  async deleteFile(input: DeleteFileInput): Promise<DeleteResult> {
    validateWrite(input);
    if (!input.expectedSha.trim()) throw new ValidationError("expectedSha is required for a delete.");
    const value = asRecord(await this.#request(
      this.#contentsPath(input.path, false),
      {
        method: "DELETE",
        body: JSON.stringify({
          message: input.message,
          sha: input.expectedSha,
          branch: this.repository.branch,
        }),
      },
      input.expectedSha,
    ));
    const commit = asRecord(value.commit);
    return {
      path: validatePath(input.path),
      deletedSha: input.expectedSha,
      commitSha: stringField(commit, "sha"),
      ...(typeof commit.html_url === "string" ? { commitUrl: commit.html_url } : {}),
    };
  }

  async batchCommit(input: BatchCommitInput): Promise<BatchCommitResult> {
    validateBatch(input);
    const refPath = `${this.#repoPath()}/git/ref/heads/${encodeRefPath(this.repository.branch)}`;
    const ref = asRecord(await this.#request(refPath));
    const refObject = asRecord(ref.object);
    const previousHeadSha = stringField(refObject, "sha");
    if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== previousHeadSha) {
      throw new ConflictError(input.expectedHeadSha);
    }

    const currentCommit = asRecord(await this.#request(`${this.#repoPath()}/git/commits/${encodeURIComponent(previousHeadSha)}`));
    const baseTreeSha = stringField(asRecord(currentCommit.tree), "sha");
    await this.#verifyBatchRevisions(input.changes);

    const tree = await Promise.all(input.changes.map(async (change) => {
      const path = validatePath(change.path);
      if (change.operation === "delete") {
        return { path, mode: "100644", type: "blob", sha: null };
      }
      const blob = asRecord(await this.#request(`${this.#repoPath()}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: change.content, encoding: "utf-8" }),
      }));
      return { path, mode: "100644", type: "blob", sha: stringField(blob, "sha") };
    }));

    const newTree = asRecord(await this.#request(`${this.#repoPath()}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    }));
    const treeSha = stringField(newTree, "sha");
    const commit = asRecord(await this.#request(`${this.#repoPath()}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: input.message, tree: treeSha, parents: [previousHeadSha] }),
    }));
    const commitSha = stringField(commit, "sha");

    // force:false makes a concurrent branch advance fail rather than overwrite it.
    await this.#request(`${this.#repoPath()}/git/refs/heads/${encodeRefPath(this.repository.branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commitSha, force: false }),
    }, input.expectedHeadSha ?? previousHeadSha);
    return {
      previousHeadSha,
      commitSha,
      treeSha,
      changedPaths: input.changes.map((change) => validatePath(change.path)),
      ...(typeof commit.html_url === "string" ? { commitUrl: commit.html_url } : {}),
    };
  }

  async #verifyBatchRevisions(changes: readonly BatchChange[]): Promise<void> {
    await Promise.all(changes.map(async (change) => {
      if (change.expectedSha === undefined) return;
      let current: RepositoryFile;
      try {
        current = await this.readFile(change.path);
      } catch (error) {
        if (error instanceof RepositoryError && error.code === "not-found") {
          throw new ConflictError(change.expectedSha, 404);
        }
        throw error;
      }
      if (current.sha !== change.expectedSha) throw new ConflictError(change.expectedSha);
    }));
  }

  async #write(input: WriteFileInput, expectedSha: string | undefined): Promise<CommitResult> {
    const body = {
      message: input.message,
      content: encodeBase64(input.content),
      branch: this.repository.branch,
      ...(expectedSha === undefined ? {} : { sha: expectedSha }),
    };
    const value = asRecord(
      await this.#request(this.#contentsPath(input.path, false), {
        method: "PUT",
        body: JSON.stringify(body),
      }, expectedSha),
    );
    const content = asRecord(value.content);
    const commit = asRecord(value.commit);
    return {
      path: stringField(content, "path"),
      contentSha: stringField(content, "sha"),
      commitSha: stringField(commit, "sha"),
      ...(typeof commit.html_url === "string" ? { commitUrl: commit.html_url } : {}),
    };
  }

  async #request(path: string, init: RequestInit = {}, expectedSha?: string): Promise<unknown> {
    const credential = await this.#credentials.get();
    if (!credential?.token) throw new AuthenticationError();
    let response: FetchResponse;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headerRecord(init.headers),
        },
      });
    } catch (cause) {
      throw new RepositoryError("network", "Could not reach the GitHub API.", { cause });
    }
    if (!response.ok) throw errorForResponse(response, expectedSha);
    try {
      return await response.json();
    } catch (cause) {
      throw new RepositoryError("invalid-response", "GitHub returned an unreadable response.", { cause });
    }
  }

  #repoPath(): string {
    return `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}`;
  }

  #contentsPath(path: string, includeRef: boolean): string {
    const encoded = validatePath(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const base = `${this.#repoPath()}/contents${encoded ? `/${encoded}` : ""}`;
    return includeRef ? `${base}?${new URLSearchParams({ ref: this.repository.branch })}` : base;
  }
}

const defaultFetch: FetchLike = async (input, init) => fetch(input, init);

function validateRepository(value: SelfRepository): SelfRepository {
  const owner = value.owner.trim();
  const name = value.name.trim();
  const branch = value.branch.trim();
  if (!owner || !name || !branch || owner.includes("/") || name.includes("/")) {
    throw new ValidationError("Repository owner, name and branch are required.");
  }
  return { owner, name, branch };
}

function validatePath(path: string): string {
  const value = path.replace(/^\/+|\/+$/g, "");
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ValidationError("Repository paths must not contain empty, '.' or '..' segments.");
  }
  return value;
}

function validateRef(ref: string): string {
  const value = ref.trim();
  if (!value) throw new ValidationError("A commit SHA or ref is required.");
  return value;
}

function validateWrite(input: Pick<WriteFileInput, "path" | "message">): void {
  if (!validatePath(input.path)) throw new ValidationError("A file path is required.");
  if (!input.message.trim()) throw new ValidationError("A commit message is required.");
}

function validateBatch(input: BatchCommitInput): void {
  if (!input.message.trim()) throw new ValidationError("A batch commit message is required.");
  if (!input.changes.length) throw new ValidationError("A batch commit requires at least one change.");
  const paths = new Set<string>();
  for (const change of input.changes) {
    const path = validatePath(change.path);
    if (paths.has(path)) throw new ValidationError(`Batch commit contains duplicate path: ${path}.`);
    paths.add(path);
    if (change.operation === "delete" && !change.expectedSha.trim()) {
      throw new ValidationError("Batch deletes require expectedSha.");
    }
    if (change.operation !== "write" && change.operation !== "delete") {
      throw new ValidationError("Batch change operation must be write or delete.");
    }
  }
  if (input.expectedHeadSha !== undefined && !input.expectedHeadSha.trim()) {
    throw new ValidationError("expectedHeadSha must not be empty.");
  }
}

function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch (cause) {
    throw new RepositoryError("invalid-response", "GitHub returned invalid file content.", { cause });
  }
}

function workflowPhase(status: unknown, conclusion: string | undefined): WorkflowPhase {
  if (status === "queued" || status === "waiting" || status === "pending") return "queued";
  if (status === "in_progress" || status === "requested") return "building";
  if (status !== "completed") return "unknown";
  if (conclusion === "success") return "succeeded";
  if (conclusion === "cancelled" || conclusion === "skipped") return "cancelled";
  return conclusion ? "failed" : "unknown";
}

function deploymentPhase(state: unknown): DeploymentPhase {
  if (state === "success") return "published";
  if (state === "pending" || state === "queued") return "pending";
  if (state === "in_progress") return "building";
  if (state === "failure" || state === "error") return "failed";
  if (state === "inactive") return "inactive";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse("object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw invalidResponse(field);
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") throw invalidResponse(field);
  return value;
}

function invalidResponse(field: string): RepositoryError {
  return new RepositoryError("invalid-response", `GitHub response is missing a valid ${field}.`);
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}
