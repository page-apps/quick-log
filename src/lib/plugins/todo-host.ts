import { getInstance, init, loadRemote, registerRemotes } from "@module-federation/runtime";
import {
  definePrivatePlugin,
  ensureServiceWorkerControl,
  postPrivatePluginWorkerCredential,
  postPrivatePluginWorkerMessage,
  privatePluginEntryUrl
} from "@repo-apps/plugin-runtime";
import { SharedPatCredentialProvider } from "@repo-apps/credentials";
import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import type { ComponentType } from "react";
import {
  TODO_PLUGIN_APP_ID,
  TODO_STATE_REPOSITORY,
  createTodoRepositoryCapabilities,
  verifyTodoPluginArtifactAccess,
  type TodoCapabilities
} from "./todo-data";

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
  const loadButton = document.querySelector<HTMLButtonElement>("[data-testid='todo-plugin-load']");
  const disconnectButton = document.querySelector<HTMLButtonElement>("[data-testid='todo-plugin-disconnect']");
  const status = document.querySelector<HTMLElement>("[data-testid='todo-plugin-status']");
  const mount = document.querySelector<HTMLElement>("[data-testid='todo-plugin-mount']");
  if (!form || !loadButton || !disconnectButton || !status || !mount) {
    throw new Error("Quick Log is missing the Todo plugin host controls.");
  }

  let root: ReactDomClient.Root | null = null;
  let worker: ServiceWorker | null = null;
  let sharedCredentials: SharedPatCredentialProvider | null = null;

  const disconnect = async (): Promise<void> => {
    root?.unmount();
    root = null;
    mount.replaceChildren();
    if (worker) await postPrivatePluginWorkerMessage(worker, { type: "todo-plugin-credential-cleared" });
    await sharedCredentials?.disconnect();
    worker = null;
    sharedCredentials = null;
    form.hidden = false;
    disconnectButton.hidden = true;
    status.textContent = "Disconnected. The worker credential and immutable private cache were cleared.";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    loadButton.disabled = true;
    status.textContent = "Checking the hub-shared PAT against the fixed plugin and Todo data repositories…";
    try {
      sharedCredentials = new SharedPatCredentialProvider({
        appId: TODO_PLUGIN_APP_ID,
        requestToken: async () => "",
        repositoryHint: `${TODO_STATE_REPOSITORY.owner}/${TODO_STATE_REPOSITORY.name}`
      });
      if (!await sharedCredentials.useShared()) {
        throw new Error("No hub-shared PAT is available on this origin. Set it up in Personal Hub, or connect Quick Log and choose shared access.");
      }
      const absoluteBase = new URL(config.baseUrl, window.location.origin);
      const apiBaseUrl = config.fake ? new URL("__todo-state-api__", absoluteBase).toString() : undefined;
      await verifyTodoPluginArtifactAccess(sharedCredentials, apiBaseUrl);
      const capabilities = await createTodoRepositoryCapabilities(sharedCredentials, apiBaseUrl);
      const plugin = definePrivatePlugin({
        id: "todo-list",
        owner: "page-apps",
        repository: "todo-list-plugin",
        artifactPrefix: "dist",
        commitSha: config.commitSha,
        entryPath: "mf-manifest.json"
      });
      worker = await ensureServiceWorkerControl({
        scriptUrl: new URL("plugin-worker.js", absoluteBase),
        scope: config.baseUrl
      });
      await postPrivatePluginWorkerCredential(worker, sharedCredentials, {
        type: "todo-plugin-credential-ready",
        fixture: config.fake
      });
      initialiseFederationHost();
      registerRemotes([{ name: "todo_list", entry: new URL(privatePluginEntryUrl(plugin, config.baseUrl), window.location.origin).toString() }], { force: true });
      const remote = await loadRemote<RemoteModule>("todo_list/App");
      if (!remote?.default) throw new Error("The private remote did not expose todo_list/App.");
      root = ReactDomClient.createRoot(mount);
      root.render(React.createElement(remote.default, {
        capabilities,
        modeLabel: "Private Todo plugin · repository synced"
      }));
      form.hidden = true;
      disconnectButton.hidden = false;
      status.textContent = `Loaded private plugin ${config.commitSha.slice(0, 7)}. Tasks sync with page-apps/todo-list-data using blob-SHA revisions.`;
    } catch (error) {
      if (worker) {
        await postPrivatePluginWorkerMessage(worker, { type: "todo-plugin-credential-cleared" }).catch(() => undefined);
        worker = null;
      }
      await sharedCredentials?.disconnect().catch(() => undefined);
      sharedCredentials = null;
      status.textContent = error instanceof Error ? error.message : "The private Todo plugin could not be loaded.";
    } finally {
      loadButton.disabled = false;
    }
  });

  disconnectButton.addEventListener("click", () => void disconnect());
}
