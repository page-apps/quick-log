import { getInstance, init, loadRemote, registerRemotes } from "@module-federation/runtime";
import {
  definePrivatePlugin,
  ensureServiceWorkerControl,
  postPrivatePluginWorkerMessage,
  privatePluginEntryUrl
} from "@repo-apps/plugin-runtime";
import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import type { ComponentType } from "react";

interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "done";
  priority: "low" | "medium" | "high";
  tags: string[];
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskCollection {
  schemaVersion: 1;
  tasks: Task[];
}

interface TodoCapabilities {
  loadTasks(): Promise<{ collection: TaskCollection; revision: string }>;
  saveTasks(collection: TaskCollection, expectedRevision: string): Promise<{ revision: string }>;
}

interface TodoPluginProps {
  capabilities: TodoCapabilities;
  modeLabel: string;
}

interface RemoteModule {
  default: ComponentType<TodoPluginProps>;
}

interface TodoPluginConfig {
  commitSha: string;
  baseUrl: string;
  fake: boolean;
}

const readConfig = (): TodoPluginConfig => {
  const raw = document.getElementById("todo-plugin-config")?.textContent;
  if (!raw) throw new Error("Missing Todo plugin configuration.");
  return JSON.parse(raw) as TodoPluginConfig;
};

function createDemoCapabilities(): TodoCapabilities {
  let revision = 1;
  let collection: TaskCollection = {
    schemaVersion: 1,
    tasks: [
      {
        id: "task-quick-log-plugin-proof",
        title: "Verify the private plugin transport",
        description: "Loaded through Quick Log's Service Worker virtual origin and Module Federation runtime.",
        status: "in-progress",
        priority: "high",
        tags: ["repo-apps", "federation"],
        dueAt: "2026-08-20T09:00:00.000Z",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z"
      }
    ]
  };
  return {
    async loadTasks() {
      return { collection: structuredClone(collection), revision: `quick-log-demo-${revision}` };
    },
    async saveTasks(next, expectedRevision) {
      if (expectedRevision !== `quick-log-demo-${revision}`) {
        const error = new Error("The Todo plugin demo snapshot changed. Reload before saving again.");
        error.name = "ConflictError";
        throw error;
      }
      collection = structuredClone(next);
      revision += 1;
      return { revision: `quick-log-demo-${revision}` };
    }
  };
}

function initialiseFederationHost(): void {
  if (getInstance()) return;
  const shared = {
    version: "19.2.8",
    scope: "default",
    shareConfig: { singleton: true, requiredVersion: "19.2.8" }
  } as const;
  init({
    name: "quick_log_private_plugin_host",
    remotes: [],
    shared: {
      react: { ...shared, lib: () => React },
      "react-dom": { ...shared, lib: () => ReactDom },
      "react/jsx-runtime": { ...shared, lib: () => ReactJsxRuntime },
      "react-dom/client": { ...shared, lib: () => ReactDomClient }
    }
  });
}

export function startTodoPluginHost(): void {
  const config = readConfig();
  const form = document.querySelector<HTMLFormElement>("[data-todo-plugin-form]");
  const tokenInput = document.querySelector<HTMLInputElement>("[data-testid='todo-plugin-token']");
  const loadButton = document.querySelector<HTMLButtonElement>("[data-testid='todo-plugin-load']");
  const disconnectButton = document.querySelector<HTMLButtonElement>("[data-testid='todo-plugin-disconnect']");
  const status = document.querySelector<HTMLElement>("[data-testid='todo-plugin-status']");
  const mount = document.querySelector<HTMLElement>("[data-testid='todo-plugin-mount']");
  if (!form || !tokenInput || !loadButton || !disconnectButton || !status || !mount) {
    throw new Error("Quick Log is missing the Todo plugin host controls.");
  }

  let root: ReactDomClient.Root | null = null;
  let worker: ServiceWorker | null = null;

  const disconnect = async (): Promise<void> => {
    root?.unmount();
    root = null;
    mount.replaceChildren();
    if (worker) await postPrivatePluginWorkerMessage(worker, { type: "todo-plugin-credential-cleared" });
    worker = null;
    form.hidden = false;
    disconnectButton.hidden = true;
    status.textContent = "Disconnected. The worker credential and immutable private cache were cleared.";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) {
      status.textContent = "Enter a fine-grained token with Contents: read access to page-apps/todo-list-plugin.";
      return;
    }
    loadButton.disabled = true;
    status.textContent = "Starting the Service Worker and loading the pinned federation graph…";
    try {
      const plugin = definePrivatePlugin({
        id: "todo-list",
        owner: "page-apps",
        repository: "todo-list-plugin",
        artifactPrefix: "dist",
        commitSha: config.commitSha,
        entryPath: "mf-manifest.json"
      });
      worker = await ensureServiceWorkerControl({
        scriptUrl: new URL("plugin-worker.js", new URL(config.baseUrl, window.location.origin)),
        scope: config.baseUrl
      });
      await postPrivatePluginWorkerMessage(worker, {
        type: "todo-plugin-credential-ready",
        token,
        fixture: config.fake
      });
      tokenInput.value = "";
      initialiseFederationHost();
      registerRemotes([{ name: "todo_list", entry: new URL(privatePluginEntryUrl(plugin, config.baseUrl), window.location.origin).toString() }], { force: true });
      const remote = await loadRemote<RemoteModule>("todo_list/App");
      if (!remote?.default) throw new Error("The private remote did not expose todo_list/App.");
      root = ReactDomClient.createRoot(mount);
      root.render(React.createElement(remote.default, {
        capabilities: createDemoCapabilities(),
        modeLabel: "Private Todo plugin · Quick Log host"
      }));
      form.hidden = true;
      disconnectButton.hidden = false;
      status.textContent = `Loaded private plugin ${config.commitSha.slice(0, 7)} through the Service Worker virtual origin.`;
    } catch (error) {
      if (worker) {
        await postPrivatePluginWorkerMessage(worker, { type: "todo-plugin-credential-cleared" }).catch(() => undefined);
        worker = null;
      }
      status.textContent = error instanceof Error ? error.message : "The private Todo plugin could not be loaded.";
    } finally {
      loadButton.disabled = false;
    }
  });

  disconnectButton.addEventListener("click", () => void disconnect());
}
