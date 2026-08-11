export type UiRuntimeStatus =
  | "demo" | "disconnected" | "connecting" | "unauthorised-for-repository" | "loading"
  | "ready" | "dirty" | "offline" | "syncing" | "committed" | "building" | "published"
  | "conflicted" | "rate-limited" | "token-expired" | "failed";

export interface StatusViewState {
  readonly status: UiRuntimeStatus;
  readonly message?: string;
  readonly commitUrl?: string;
}

export interface StatusMountOptions {
  readonly state: StatusViewState;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly onConnect?: () => void | Promise<void>;
}

const LABELS: Readonly<Record<UiRuntimeStatus, string>> = {
  demo: "Demo mode", disconnected: "Disconnected", connecting: "Connecting…",
  "unauthorised-for-repository": "Repository access required", loading: "Loading…", ready: "Ready",
  dirty: "Unsaved changes", offline: "Offline", syncing: "Committing…", committed: "Committed",
  building: "Building…", published: "Published", conflicted: "Conflict needs attention",
  "rate-limited": "Rate limited", "token-expired": "Credential expired", failed: "Something went wrong",
};

export function statusLabel(status: UiRuntimeStatus): string {
  return LABELS[status];
}

/** Mounts a small accessible status region using textContent only. */
export function mountRepoAppStatus(container: HTMLElement, options: StatusMountOptions): () => void {
  const document = container.ownerDocument;
  const region = document.createElement("section");
  region.dataset.repoAppStatus = options.state.status;
  region.setAttribute("aria-live", "polite");

  const label = document.createElement("strong");
  label.textContent = statusLabel(options.state.status);
  const repository = document.createElement("span");
  repository.textContent = ` ${options.repository.owner}/${options.repository.name}`;
  region.append(label, repository);

  if (options.state.message) {
    const message = document.createElement("p");
    message.textContent = options.state.message;
    region.append(message);
  }
  if (options.state.commitUrl) {
    const link = document.createElement("a");
    link.href = options.state.commitUrl;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = "View commit";
    region.append(link);
  }
  if ((options.state.status === "demo" || options.state.status === "disconnected" || options.state.status === "token-expired") && options.onConnect) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Connect GitHub";
    button.addEventListener("click", options.onConnect);
    region.append(button);
  }

  container.replaceChildren(region);
  return () => {
    if (region.parentNode === container) region.remove();
  };
}
