import {
  PersistentPatCredentialProvider,
  SessionPatCredentialProvider,
  type CredentialProvider
} from "@repo-apps/credentials";
import { createRepositoryClient } from "@repo-apps/repo-client";
import type { QuickLogCollection } from "./schema";
import { formatCollection, parseCollectionText } from "./schema";

export interface RepositoryIdentity {
  owner: string;
  name: string;
  branch: string;
}

export interface LoadedCollection {
  collection: QuickLogCollection;
  sha: string;
}

export interface SaveResult {
  contentSha: string;
  commitSha: string;
  commitUrl?: string | undefined;
}

export interface PublicationStatus {
  phase: "building" | "published" | "failed";
  url?: string | undefined;
  detail?: string | undefined;
}

export interface QuickLogRepository {
  verifyAccess(): Promise<{ login?: string }>;
  load(): Promise<LoadedCollection>;
  save(collection: QuickLogCollection, expectedSha: string, message: string): Promise<SaveResult>;
  publication(commitSha: string): Promise<PublicationStatus>;
}

type ClientShape = ReturnType<typeof createRepositoryClient>;

class FrameworkRepository implements QuickLogRepository {
  constructor(
    private readonly client: ClientShape,
    private readonly identity: RepositoryIdentity,
    private readonly dataPath: string
  ) {}

  async verifyAccess(): Promise<{ login?: string }> {
    const result = await this.client.verifyAccess();
    if (!result.canRead || !result.canWrite) {
      const error = new Error("The token needs Contents: read and write for this repository.");
      error.name = "PermissionError";
      throw error;
    }
    return {};
  }

  async load(): Promise<LoadedCollection> {
    const file = await this.client.readFile(this.dataPath);
    return { collection: parseCollectionText(file.content), sha: file.sha };
  }

  async save(collection: QuickLogCollection, expectedSha: string, message: string): Promise<SaveResult> {
    const result = await this.client.updateFile({
      path: this.dataPath,
      content: formatCollection(collection),
      message,
      expectedSha
    });
    const value = result as unknown as Record<string, unknown>;
    const commit = (value.commit ?? {}) as Record<string, unknown>;
    const content = (value.content ?? {}) as Record<string, unknown>;
    const commitSha = String(value.commitSha ?? commit.sha ?? value.sha ?? "");
    const contentSha = String(value.contentSha ?? content.sha ?? value.sha ?? "");
    return {
      commitSha,
      contentSha,
      commitUrl: typeof value.commitUrl === "string"
        ? value.commitUrl
        : commitSha
          ? `https://github.com/${this.identity.owner}/${this.identity.name}/commit/${commitSha}`
          : undefined
    };
  }

  async publication(commitSha: string): Promise<PublicationStatus> {
    const [workflow, pages] = await Promise.all([
      this.client.getWorkflowStatus(commitSha),
      this.client.getPagesDeploymentStatus(commitSha)
    ]);
    const workflowValue = workflow as unknown as Record<string, unknown>;
    const pagesValue = pages as unknown as Record<string, unknown>;
    const pagesState = String(pagesValue.phase ?? pagesValue.status ?? pagesValue.state ?? "").toLowerCase();
    const workflowState = String(workflowValue.phase ?? workflowValue.status ?? workflowValue.state ?? "").toLowerCase();
    const conclusion = String(workflowValue.conclusion ?? "").toLowerCase();
    if (["published", "active", "success", "succeeded"].includes(pagesState)) {
      return {
        phase: "published",
        url: typeof pagesValue.environmentUrl === "string"
          ? pagesValue.environmentUrl
          : typeof pagesValue.url === "string"
            ? pagesValue.url
            : undefined
      };
    }
    if (["failure", "failed", "cancelled"].includes(conclusion) || ["failure", "failed"].includes(workflowState)) {
      return { phase: "failed", detail: "The build did not complete. Open GitHub Actions for details." };
    }
    return { phase: "building" };
  }
}

class FakeRepository implements QuickLogRepository {
  private sha = "fixture-sha-1";
  private commit = 0;

  constructor(private collection: QuickLogCollection, private readonly identity: RepositoryIdentity) {}

  async verifyAccess(): Promise<{ login: string }> {
    return { login: "octocat" };
  }

  async load(): Promise<LoadedCollection> {
    return { collection: structuredClone(this.collection), sha: this.sha };
  }

  async save(collection: QuickLogCollection, expectedSha: string): Promise<SaveResult> {
    if (expectedSha !== this.sha) {
      const error = new Error("The remote collection changed.");
      error.name = "ConflictError";
      throw error;
    }
    this.collection = structuredClone(collection);
    this.commit += 1;
    this.sha = `fixture-sha-${this.commit + 1}`;
    const commitSha = `0123456789abcdef${String(this.commit).padStart(4, "0")}`;
    return {
      contentSha: this.sha,
      commitSha,
      commitUrl: `https://github.com/${this.identity.owner}/${this.identity.name}/commit/${commitSha}`
    };
  }

  async publication(): Promise<PublicationStatus> {
    return { phase: "published", url: "https://example.test/quick-log/" };
  }
}

export function createPatProvider(
  appId: string,
  persistence: "session" | "persistent",
  requestToken: () => Promise<string>
): CredentialProvider {
  const options = { appId, requestToken };
  return persistence === "persistent"
    ? new PersistentPatCredentialProvider(options)
    : new SessionPatCredentialProvider(options);
}

export function createQuickLogRepository(options: {
  identity: RepositoryIdentity;
  dataPath: string;
  credentials: CredentialProvider;
  fake: boolean;
  fixture: QuickLogCollection;
}): QuickLogRepository {
  if (options.fake) return new FakeRepository(structuredClone(options.fixture), options.identity);
  const client = createRepositoryClient({ repository: options.identity, credentials: options.credentials });
  return new FrameworkRepository(client, options.identity, options.dataPath);
}
