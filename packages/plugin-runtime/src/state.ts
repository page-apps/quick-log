export interface RevisionedRepositoryFile {
  readonly content: string;
  readonly sha: string;
}

export interface RevisionedRepositoryWrite {
  readonly contentSha: string;
  readonly commitSha: string;
  readonly commitUrl?: string;
}

/** Structural subset of @repo-apps/repo-client kept behind the host boundary. */
export interface RevisionedRepositoryFileClient {
  readFile(path: string): Promise<RevisionedRepositoryFile>;
  updateFile(input: {
    readonly path: string;
    readonly content: string;
    readonly message: string;
    readonly expectedSha: string;
  }): Promise<RevisionedRepositoryWrite>;
}

export interface PrivatePluginStateSnapshot<T> {
  readonly state: T;
  readonly revision: string;
}

export interface PrivatePluginStateCommit {
  readonly revision: string;
  readonly commitSha: string;
  readonly commitUrl?: string;
}

export interface PrivatePluginStateCapability<T> {
  load(): Promise<PrivatePluginStateSnapshot<T>>;
  save(state: T, expectedRevision: string): Promise<PrivatePluginStateCommit>;
}

export interface PrivatePluginStateCapabilityOptions<T> {
  readonly client: RevisionedRepositoryFileClient;
  readonly path: string;
  /** Parse and validate repository text before it crosses into the remote. */
  readonly parse: (content: string) => T;
  /** Validate and serialise a proposed remote value before committing it. */
  readonly format: (state: T) => string;
  readonly commitMessage: string | ((state: T) => string);
}

/**
 * Adapts one manifest-fixed repository file into a narrow, optimistic-concurrency
 * capability. Repository identity, credential access and path selection stay in
 * the host closure; the remote sees only validated state and opaque revisions.
 */
export function createPrivatePluginStateCapability<T>(
  options: PrivatePluginStateCapabilityOptions<T>
): PrivatePluginStateCapability<T> {
  const path = assertFixedPath(options.path);
  return Object.freeze({
    async load(): Promise<PrivatePluginStateSnapshot<T>> {
      const file = await options.client.readFile(path);
      if (!file.sha.trim()) throw new Error("The private plugin state repository returned an empty revision.");
      return { state: options.parse(file.content), revision: file.sha };
    },

    async save(state: T, expectedRevision: string): Promise<PrivatePluginStateCommit> {
      const revision = expectedRevision.trim();
      if (!revision) throw new Error("A last-read private plugin state revision is required.");
      const validatedContent = options.format(state);
      const message = typeof options.commitMessage === "function"
        ? options.commitMessage(state)
        : options.commitMessage;
      if (!message.trim()) throw new Error("A private plugin state commit message is required.");
      const result = await options.client.updateFile({
        path,
        content: validatedContent,
        message,
        expectedSha: revision
      });
      return {
        revision: result.contentSha,
        commitSha: result.commitSha,
        ...(result.commitUrl === undefined ? {} : { commitUrl: result.commitUrl })
      };
    }
  });
}

function assertFixedPath(input: string): string {
  const path = input.replace(/^\/+|\/+$/g, "");
  const parts = path.split("/");
  if (!path || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Private plugin state path must be a safe fixed repository path.");
  }
  return path;
}
