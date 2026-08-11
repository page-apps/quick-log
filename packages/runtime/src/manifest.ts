export type AuthMethod = "pat" | "device-flow";
export type CredentialPersistence = "none" | "optional" | "persistent";

export interface RepoAppManifest {
  readonly id: string;
  readonly title: string;
  readonly repository: {
    readonly mode: "self";
    readonly branch: string;
    readonly dataRoot: string;
  };
  readonly auth: {
    readonly methods: readonly AuthMethod[];
    readonly persistence: CredentialPersistence;
    readonly sharedCredential: boolean;
  };
  readonly demo: { readonly fixture: string };
  readonly writes: {
    readonly defaultStrategy: "direct";
    readonly conflictStrategy: "prompt";
  };
}

export interface RuntimeBuildMetadata {
  readonly githubRepository: string;
  readonly appVersion?: string;
  readonly branch?: string;
  readonly commitSha?: string;
}

export interface RepoAppRuntimeConfig {
  readonly appId: string;
  readonly title: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly branch: string;
    readonly dataRoot: string;
  };
  readonly appVersion: string;
  readonly commitSha?: string;
}

export function defineRepoApp<const T extends RepoAppManifest>(manifest: T): T {
  validateManifest(manifest);
  return Object.freeze(manifest);
}

/** Resolve trusted Actions build metadata into public, token-free runtime config. */
export function resolveRuntimeConfig(
  manifest: RepoAppManifest,
  metadata: RuntimeBuildMetadata,
): RepoAppRuntimeConfig {
  validateManifest(manifest);
  const parts = metadata.githubRepository.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new Error("githubRepository must use the trusted 'owner/repository' form.");
  }
  return Object.freeze({
    appId: manifest.id,
    title: manifest.title,
    repository: Object.freeze({
      owner: parts[0],
      name: parts[1],
      branch: metadata.branch?.trim() || manifest.repository.branch,
      dataRoot: manifest.repository.dataRoot,
    }),
    appVersion: metadata.appVersion?.trim() || metadata.commitSha?.slice(0, 12) || "development",
    ...(metadata.commitSha === undefined ? {} : { commitSha: metadata.commitSha }),
  });
}

function validateManifest(manifest: RepoAppManifest): void {
  if (!manifest.id.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
    throw new Error("Repo app id must be a non-empty lowercase slug.");
  }
  if (!manifest.title.trim()) throw new Error("Repo app title is required.");
  if (manifest.repository.mode !== "self") throw new Error("Only self repository mode is supported.");
  if (!manifest.repository.branch.trim() || !safeRelativePath(manifest.repository.dataRoot)) {
    throw new Error("Repository branch and a safe relative dataRoot are required.");
  }
  if (!manifest.auth.methods.length) throw new Error("At least one authentication method is required.");
  if (!safeRelativePath(manifest.demo.fixture.replace(/^\.\//, ""))) throw new Error("Demo fixture must be relative.");
  if (manifest.writes.defaultStrategy !== "direct" || manifest.writes.conflictStrategy !== "prompt") {
    throw new Error("The MVP requires direct writes and prompt conflict handling.");
  }
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "");
}
