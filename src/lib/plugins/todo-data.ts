import type { CredentialProvider } from "@repo-apps/credentials";
import { createPrivatePluginStateCapability } from "@repo-apps/plugin-runtime";
import { createRepositoryClient } from "@repo-apps/repo-client";
import { z } from "zod";

export const TODO_PLUGIN_APP_ID = "quick-log:todo-list";
export const TODO_PLUGIN_REPOSITORY = Object.freeze({
  owner: "page-apps",
  name: "todo-list-plugin",
  branch: "main"
});
export const TODO_STATE_REPOSITORY = Object.freeze({
  owner: "page-apps",
  name: "todo-list-data",
  branch: "main"
});
export const TODO_STATE_PATH = "data/tasks.json";

const taskSchema = z.strictObject({
  id: z.string().regex(/^task-[a-z0-9-]{8,64}$/),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  status: z.enum(["todo", "in-progress", "done"]),
  priority: z.enum(["low", "medium", "high"]),
  tags: z.array(z.string().min(1).max(30).regex(/^[a-z0-9][a-z0-9-]*$/)).max(8),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});

const taskCollectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tasks: z.array(taskSchema)
}).superRefine(({ tasks }, context) => {
  const ids = new Set<string>();
  tasks.forEach((task, index) => {
    if (ids.has(task.id)) context.addIssue({ code: "custom", message: `Duplicate task id: ${task.id}`, path: ["tasks", index, "id"] });
    ids.add(task.id);
    if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) {
      context.addIssue({ code: "custom", message: "updatedAt cannot be earlier than createdAt", path: ["tasks", index, "updatedAt"] });
    }
  });
});

export type Task = z.infer<typeof taskSchema>;
export type TaskCollection = z.infer<typeof taskCollectionSchema>;

export interface TodoCapabilities {
  loadTasks(): Promise<{ collection: TaskCollection; revision: string }>;
  saveTasks(collection: TaskCollection, expectedRevision: string): Promise<{
    revision: string;
    commitSha?: string;
    commitUrl?: string;
  }>;
}

export function parseTaskCollectionText(content: string): TaskCollection {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("The Todo data repository returned malformed JSON.");
  }
  return taskCollectionSchema.parse(value);
}

export function formatTaskCollection(value: TaskCollection): string {
  return `${JSON.stringify(taskCollectionSchema.parse(value), null, 2)}\n`;
}

export async function verifyTodoPluginArtifactAccess(
  credentials: CredentialProvider,
  apiBaseUrl?: string
): Promise<void> {
  const client = createRepositoryClient({
    repository: TODO_PLUGIN_REPOSITORY,
    credentials,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl })
  });
  const access = await client.verifyAccess();
  if (!access.canRead) {
    const error = new Error("The shared PAT needs Contents: read access to page-apps/todo-list-plugin.");
    error.name = "PermissionError";
    throw error;
  }
}

export async function createTodoRepositoryCapabilities(
  credentials: CredentialProvider,
  apiBaseUrl?: string
): Promise<TodoCapabilities> {
  const client = createRepositoryClient({
    repository: TODO_STATE_REPOSITORY,
    credentials,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl })
  });
  const access = await client.verifyAccess();
  if (!access.canRead || !access.canWrite) {
    const error = new Error("The shared PAT needs Contents: read and write access to page-apps/todo-list-data.");
    error.name = "PermissionError";
    throw error;
  }
  const state = createPrivatePluginStateCapability({
    client,
    path: TODO_STATE_PATH,
    parse: parseTaskCollectionText,
    format: formatTaskCollection,
    commitMessage: "Update Todo tasks"
  });
  return Object.freeze({
    async loadTasks() {
      const snapshot = await state.load();
      return { collection: snapshot.state, revision: snapshot.revision };
    },
    async saveTasks(collection: TaskCollection, expectedRevision: string) {
      const result = await state.save(collection, expectedRevision);
      return {
        revision: result.revision,
        commitSha: result.commitSha,
        ...(result.commitUrl === undefined ? {} : { commitUrl: result.commitUrl })
      };
    }
  });
}
