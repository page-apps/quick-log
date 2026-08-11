import type { CredentialProvider } from "@repo-apps/credentials";
import { DeviceFlowCredentialProvider, SharedPatCredentialProvider } from "@repo-apps/credentials";
import { clearDraft, hasDraftContent, loadDraft, saveDraft, type QuickLogDraft } from "./drafts";
import type { QuickLogCollection, QuickLogRecord } from "./schema";
import { createRecordId, normaliseTags, parseCollection, quickLogRecordSchema } from "./schema";
import {
  createPatProvider,
  createQuickLogRepository,
  type LoadedCollection,
  type QuickLogRepository,
  type RepositoryIdentity
} from "./repository";

interface RuntimeConfig extends RepositoryIdentity {
  appId: string;
  dataPath: string;
  version: string;
  commitSha: string;
  deviceClientId: string;
  deviceScope: "public_repo" | "repo";
  fake: boolean;
}

interface ConflictState {
  local: QuickLogCollection;
  remote: LoadedCollection;
  message: string;
  allowCopy: boolean;
}

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Quick Log UI is missing ${selector}`);
  return element;
};

const readJson = <T>(id: string): T => {
  const text = document.getElementById(id)?.textContent;
  if (!text) throw new Error(`Missing ${id}`);
  return JSON.parse(text) as T;
};

const isConflict = (error: unknown): boolean =>
  error instanceof Error && (error.name === "ConflictError" || /conflict|revision|sha/i.test(error.message));

const friendlyError = (error: unknown): string => {
  if (!(error instanceof Error)) return "Something unexpected happened. Try again.";
  const code = "code" in error ? String(error.code) : "";
  if (code === "device-flow-expired") return "The one-time device code expired. Start Device Flow again for a new code.";
  if (code === "device-flow-denied") return "GitHub authorisation was cancelled. Start again when you’re ready.";
  if (code === "network") return "The connection was interrupted. Check your network and retry.";
  if (error.name === "AuthError" || /credential|token|401|authentication/i.test(error.message)) {
    return "GitHub did not accept this token. Check that it is current and copied in full.";
  }
  if (error.name === "PermissionError" || /permission|403|forbidden|access/i.test(error.message)) {
    return "This token cannot access the displayed repository. Select this repository and grant Contents: read and write.";
  }
  if (error.name === "RateLimitError" || /rate.?limit/i.test(error.message)) {
    return "GitHub’s request limit was reached. Wait until the indicated reset time, then retry.";
  }
  return error.message || "Something unexpected happened. Try again.";
};

const toLocalInput = (iso: string): string => {
  const date = new Date(iso);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
};

const fromLocalInput = (value: string): string => new Date(value).toISOString();

const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function startQuickLog(): void {
  const config = readJson<RuntimeConfig>("quick-log-config");
  const fixture = parseCollection(readJson<unknown>("quick-log-fixture"));
  const identity: RepositoryIdentity = { owner: config.owner, name: config.name, branch: config.branch };

  const modeIndicator = $<HTMLElement>("[data-testid='mode-indicator']");
  const modeLabel = $<HTMLElement>("[data-mode-label]");
  const connectButton = $<HTMLButtonElement>("[data-testid='connect-button']");
  const connectDialog = $<HTMLDialogElement>("[data-testid='connect-dialog']");
  const connectForm = $<HTMLFormElement>("[data-connect-form]");
  const connectError = $<HTMLElement>("[data-connect-error]");
  const tokenInput = $<HTMLInputElement>("[data-testid='token-input']");
  const persistenceAck = $<HTMLElement>("[data-persistence-ack]");
  const disconnectDialog = $<HTMLDialogElement>("[data-testid='disconnect-dialog']");
  const deleteDialog = $<HTMLDialogElement>("[data-testid='delete-dialog']");
  const deleteButton = $<HTMLButtonElement>("[data-testid='delete-record-button']");
  const offlineBanner = $<HTMLElement>("[data-testid='offline-banner']");
  const draftRecovery = $<HTMLElement>("[data-testid='draft-recovery']");
  const recordForm = $<HTMLFormElement>("[data-record-form]");
  const recordList = $<HTMLElement>("[data-testid='record-list']");
  const emptyState = $<HTMLElement>("[data-empty-state]");
  const titleInput = $<HTMLInputElement>("[name='title']");
  const bodyInput = $<HTMLTextAreaElement>("[name='body']");
  const tagsInput = $<HTMLInputElement>("[name='tags']");
  const timeInput = $<HTMLInputElement>("[name='occurredAt']");
  const idInput = $<HTMLInputElement>("[name='id']");
  const saveButton = $<HTMLButtonElement>("[data-testid='save-button']");
  const saveLabel = $<HTMLElement>("[data-save-label]");
  const syncStatus = $<HTMLElement>("[data-testid='sync-status']");
  const syncDetail = $<HTMLElement>("[data-sync-detail]");
  const formError = $<HTMLElement>("[data-form-error]");
  const conflictPanel = $<HTMLElement>("[data-testid='conflict-panel']");
  const characterCount = $<HTMLElement>("[data-character-count]");
  const demoNotice = $<HTMLElement>("[data-demo-notice]");

  let collection = structuredClone(fixture);
  let selectedId = collection.records[0]?.id ?? null;
  let revision = "";
  let repository: QuickLogRepository | null = null;
  let credentialProvider: CredentialProvider | null = null;
  let connected = false;
  let credentialScope: "app" | "shared" | "device" = "app";
  let conflict: ConflictState | null = null;
  let pollGeneration = 0;
  let recoveredDraft: QuickLogDraft | null = null;
  let draftTimer = 0;
  let restoreAttempted = false;

  const setSync = (label: string, detail: string): void => {
    syncStatus.textContent = label;
    syncDetail.textContent = detail;
  };

  const setRelease = (phase: "idle" | "committed" | "building" | "published" | "failed", result?: {
    commitSha?: string | undefined;
    commitUrl?: string | undefined;
    pagesUrl?: string | undefined;
  }): void => {
    const order = ["committed", "building", "published"] as const;
    const currentIndex = order.indexOf(phase as (typeof order)[number]);
    order.forEach((step, index) => {
      const element = $<HTMLElement>(`[data-release-step='${step}']`);
      element.classList.toggle("active", currentIndex >= index);
      element.classList.toggle("current", step === phase);
      element.classList.toggle("failed", phase === "failed" && step === "building");
    });
    const links = $<HTMLElement>("[data-release-links]");
    const commitLink = $<HTMLAnchorElement>("[data-commit-link]");
    const pagesLink = $<HTMLAnchorElement>("[data-pages-link]");
    if (result?.commitSha) {
      links.hidden = false;
      commitLink.href = result.commitUrl ?? `https://github.com/${config.owner}/${config.name}/commit/${result.commitSha}`;
      commitLink.textContent = `Commit ${result.commitSha.slice(0, 7)}`;
    }
    if (result?.pagesUrl) {
      pagesLink.hidden = false;
      pagesLink.href = result.pagesUrl;
    }
    if (phase === "idle") {
      links.hidden = true;
      pagesLink.hidden = true;
    }
  };

  const setMode = (isConnected: boolean, account?: string): void => {
    connected = isConnected;
    modeIndicator.dataset.mode = isConnected ? "connected" : "demo";
    modeLabel.textContent = isConnected ? (account ? `Connected · @${account}` : "Connected") : "Demo mode";
    connectButton.textContent = isConnected ? "Disconnect" : "Connect GitHub";
    saveLabel.textContent = isConnected ? "Commit entry" : "Preview entry";
    demoNotice.hidden = isConnected;
    deleteButton.textContent = isConnected ? "Delete entry" : "Remove preview";
  };

  const setBusy = (busy: boolean): void => {
    saveButton.disabled = busy;
    connectButton.disabled = busy;
    recordForm.setAttribute("aria-busy", String(busy));
  };

  const clearFormError = (): void => {
    formError.hidden = true;
    formError.textContent = "";
  };

  const showFormError = (message: string): void => {
    formError.textContent = message;
    formError.hidden = false;
  };

  const resetForm = (): void => {
    selectedId = null;
    idInput.value = "";
    titleInput.value = "";
    bodyInput.value = "";
    tagsInput.value = "";
    timeInput.value = toLocalInput(new Date().toISOString());
    characterCount.textContent = "0 / 4,000";
    $<HTMLElement>("[data-editor-heading]").textContent = "New entry";
    $<HTMLElement>("[data-draft-chip]").textContent = "Local draft";
    clearFormError();
    deleteButton.hidden = true;
    void clearDraft();
    renderList();
    titleInput.focus();
  };

  const populateForm = (record: QuickLogRecord): void => {
    selectedId = record.id;
    idInput.value = record.id;
    titleInput.value = record.title;
    bodyInput.value = record.body;
    tagsInput.value = record.tags.join(", ");
    timeInput.value = toLocalInput(record.occurredAt);
    characterCount.textContent = `${record.body.length.toLocaleString()} / 4,000`;
    $<HTMLElement>("[data-editor-heading]").textContent = "Edit entry";
    $<HTMLElement>("[data-draft-chip]").textContent = connected ? "Repository record" : "Demo record";
    clearFormError();
    deleteButton.hidden = false;
    renderList();
  };

  const renderList = (): void => {
    recordList.replaceChildren();
    const records = [...collection.records].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    emptyState.hidden = records.length > 0;
    for (const record of records) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `entry-card${record.id === selectedId ? " selected" : ""}`;
      button.dataset.recordId = record.id;
      button.setAttribute("aria-label", `Edit ${record.title}`);
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = record.title;
      const time = document.createElement("time");
      time.dateTime = record.occurredAt;
      time.textContent = formatDate(record.occurredAt);
      header.append(title, time);
      const body = document.createElement("p");
      body.textContent = record.body;
      const tags = document.createElement("div");
      tags.className = "tag-list";
      for (const value of record.tags) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = value;
        tags.append(tag);
      }
      button.append(header, body, tags);
      button.addEventListener("click", () => populateForm(record));
      recordList.append(button);
    }
  };

  const currentDraft = (): QuickLogDraft => ({
    id: idInput.value,
    title: titleInput.value,
    body: bodyInput.value,
    tags: tagsInput.value,
    occurredAt: timeInput.value,
    savedAt: new Date().toISOString()
  });

  const scheduleDraftSave = (): void => {
    window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      const draft = currentDraft();
      if (hasDraftContent(draft)) {
        void saveDraft(draft).then((saved) => {
          if (saved) $<HTMLElement>("[data-draft-chip]").textContent = "Draft saved locally";
        });
      } else {
        void clearDraft();
      }
    }, 350);
  };

  const updateConnectivity = (): void => {
    const offline = !navigator.onLine;
    offlineBanner.hidden = !offline;
    if (offline) setSync("Offline", "Your editor draft stays on this device; repository writes are paused");
    else if (connected) setSync("Ready", `Online and connected to ${config.owner}/${config.name}`);
    else setSync("Demo data loaded", "Online; no remote writes in demo mode");
  };

  const showConflict = async (local: QuickLogCollection, message: string, allowCopy = true): Promise<void> => {
    if (!repository) return;
    try {
      const remote = await repository.load();
      conflict = { local: structuredClone(local), remote, message, allowCopy };
      $<HTMLElement>("[data-conflict-local]").textContent = JSON.stringify(local, null, 2);
      $<HTMLElement>("[data-conflict-remote]").textContent = JSON.stringify(remote.collection, null, 2);
      $<HTMLButtonElement>("[data-conflict-action='copy']").hidden = !allowCopy;
      conflictPanel.hidden = false;
      conflictPanel.scrollIntoView({ behavior: "smooth", block: "center" });
      conflictPanel.focus({ preventScroll: true });
      setSync("Conflict detected", "No remote data was overwritten");
    } catch (error) {
      showFormError(`A conflict occurred, and the remote version could not be loaded: ${friendlyError(error)}`);
      setSync("Conflict needs attention", "Try reloading the repository data");
    }
  };

  const observePublication = (commitSha: string, commitUrl?: string): void => {
    const generation = ++pollGeneration;
    window.setTimeout(async () => {
      if (!repository || generation !== pollGeneration) return;
      setRelease("building", { commitSha, commitUrl });
      setSync("Building", "GitHub Actions is validating and deploying this commit");
      const check = async (attempt: number): Promise<void> => {
        if (!repository || generation !== pollGeneration) return;
        try {
          const status = await repository.publication(commitSha);
          if (status.phase === "published") {
            setRelease("published", { commitSha, commitUrl, pagesUrl: status.url });
            setSync("Published", "The committed data is live on GitHub Pages");
            return;
          }
          if (status.phase === "failed") {
            setRelease("failed", { commitSha, commitUrl });
            setSync("Build failed", status.detail ?? "Open GitHub Actions for details");
            return;
          }
          if (attempt < 4) window.setTimeout(() => void check(attempt + 1), config.fake ? 800 : 5_000);
          else setSync("Building is taking longer", "The commit is safe. Use the GitHub Actions link for current deployment details");
        } catch {
          if (attempt < 4) window.setTimeout(() => void check(attempt + 1), config.fake ? 800 : 5_000);
          else setSync("Committed; publish status unavailable", "The commit is safe. Open GitHub Actions to follow deployment");
        }
      };
      window.setTimeout(() => void check(0), config.fake ? 500 : 2_000);
    }, config.fake ? 350 : 900);
  };

  const commitCollection = async (next: QuickLogCollection, expectedSha: string, message: string): Promise<void> => {
    if (!repository) throw new Error("Connect GitHub before committing.");
    setBusy(true);
    setSync("Syncing", "Validating and sending one explicit repository update");
    try {
      const result = await repository.save(next, expectedSha, message);
      collection = next;
      revision = result.contentSha;
      void clearDraft();
      conflict = null;
      conflictPanel.hidden = true;
      renderList();
      setRelease("committed", result);
      setSync("Committed", `Commit ${result.commitSha.slice(0, 7)} is saved; publication is still pending`);
      observePublication(result.commitSha, result.commitUrl);
    } finally {
      setBusy(false);
    }
  };

  recordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError();
    const now = new Date().toISOString();
    const existing = collection.records.find((record) => record.id === idInput.value);
    const candidate = {
      id: existing?.id ?? createRecordId(),
      title: titleInput.value,
      body: bodyInput.value,
      tags: normaliseTags(tagsInput.value),
      occurredAt: timeInput.value ? fromLocalInput(timeInput.value) : now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const parsed = quickLogRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      showFormError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    const nextRecords = existing
      ? collection.records.map((record) => record.id === existing.id ? parsed.data : record)
      : [parsed.data, ...collection.records];
    const next = parseCollection({ schemaVersion: 1, records: nextRecords });
    selectedId = parsed.data.id;
    if (!connected) {
      collection = next;
      populateForm(parsed.data);
      setSync("Demo preview updated", "This change lives only in this tab and was not sent to GitHub");
      return;
    }
    if (!navigator.onLine) {
      await saveDraft(currentDraft());
      showFormError("You’re offline. This draft is safe on this device and has not been sent to GitHub.");
      setSync("Offline draft saved", "Reconnect before committing this entry");
      return;
    }
    try {
      await commitCollection(next, revision, `${existing ? "Update" : "Add"} log: ${parsed.data.title}`);
      populateForm(parsed.data);
    } catch (error) {
      if (isConflict(error)) await showConflict(next, `${existing ? "Update" : "Add"} log: ${parsed.data.title}`);
      else {
        showFormError(friendlyError(error));
        setSync("Save failed", "Your editor content is still here; resolve the issue and retry");
      }
    }
  });

  const returnToDemo = (): void => {
    ++pollGeneration;
    credentialProvider = null;
    repository = null;
    revision = "";
    collection = structuredClone(fixture);
    selectedId = collection.records[0]?.id ?? null;
    setMode(false);
    setRelease("idle");
    setSync("Demo data loaded", "Disconnected; no remote writes in demo mode");
    renderList();
    if (collection.records[0]) populateForm(collection.records[0]);
  };

  const finishConnection = async (provider: CredentialProvider, scope: typeof credentialScope): Promise<void> => {
    credentialProvider = provider;
    credentialScope = scope;
    repository = createQuickLogRepository({
      identity,
      dataPath: config.dataPath,
      credentials: provider,
      fake: config.fake,
      fixture
    });
    const access = await repository.verifyAccess();
    const remote = await repository.load();
    collection = remote.collection;
    revision = remote.sha;
    selectedId = collection.records[0]?.id ?? null;
    setMode(true, access.login);
    setRelease("idle");
    setSync("Ready", `Repository data loaded from ${config.owner}/${config.name}`);
    renderList();
    if (collection.records[0]) populateForm(collection.records[0]); else resetForm();
    tokenInput.value = "";
    connectDialog.close();
  };

  const restoreOwnCredential = async (): Promise<void> => {
    if (restoreAttempted || connected || !navigator.onLine) return;
    restoreAttempted = true;
    let foundStoredCredential = false;
    let lastError: unknown;
    setBusy(true);
    try {
      for (const persistence of ["session", "persistent"] as const) {
        const provider = createPatProvider(config.appId, persistence, async () => "");
        try {
          if (!await provider.get()) continue;
          foundStoredCredential = true;
          setSync("Reconnecting", `Verifying the saved connection for ${config.owner}/${config.name}`);
          await finishConnection(provider, "app");
          return;
        } catch (error) {
          lastError = error;
          credentialProvider = null;
          repository = null;
        }
      }
      if (foundStoredCredential) {
        setMode(false);
        setSync("Saved connection needs attention", friendlyError(lastError));
      }
    } finally {
      setBusy(false);
    }
  };

  const sharedCandidate = (): SharedPatCredentialProvider => new SharedPatCredentialProvider({
    appId: config.appId,
    requestToken: async () => "",
    repositoryHint: `${config.owner}/${config.name}`
  });

  const refreshSharedAvailability = async (): Promise<void> => {
    try {
      const candidate = sharedCandidate();
      const available = await candidate.hasShared();
      $<HTMLElement>("[data-shared-credential-card]").hidden = !available;
      $<HTMLButtonElement>("[data-testid='remove-shared-credential']").hidden = !available && credentialScope !== "shared";
      if (available) {
        const hints = await candidate.listRepositoryHints();
        $<HTMLElement>("[data-shared-repository-hints]").textContent = hints.length
          ? `Repository hints: ${hints.join(", ")}`
          : "Repository access will be checked before data is loaded.";
      }
    } catch {
      $<HTMLElement>("[data-shared-credential-card]").hidden = true;
      $<HTMLButtonElement>("[data-testid='remove-shared-credential']").hidden = true;
    }
  };

  connectButton.addEventListener("click", async () => {
    if (!connected) {
      connectError.hidden = true;
      await refreshSharedAvailability();
      connectDialog.showModal();
      tokenInput.focus();
      return;
    }
    await refreshSharedAvailability();
    const disconnectSession = $<HTMLButtonElement>("[data-testid='disconnect-session']");
    disconnectSession.textContent = credentialScope === "shared"
      ? "Disconnect this app for this session"
      : "Disconnect this app";
    disconnectDialog.showModal();
  });

  connectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    connectError.hidden = true;
    const formData = new FormData(connectForm);
    const persistence = formData.get("persistence") === "persistent" ? "persistent" : "session";
    const share = formData.get("shareCredential") === "on";
    if ((persistence === "persistent" || share) && formData.get("acknowledge") !== "on") {
      connectError.textContent = "Acknowledge the browser-storage disclosure before choosing persistent storage.";
      connectError.hidden = false;
      return;
    }
    const token = tokenInput.value.trim();
    if (!token) {
      connectError.textContent = "Enter a fine-grained GitHub token.";
      connectError.hidden = false;
      return;
    }
    const submit = $<HTMLButtonElement>("[data-testid='connect-submit']");
    submit.disabled = true;
    submit.textContent = "Verifying…";
    setSync("Connecting", `Checking access to ${config.owner}/${config.name}`);
    try {
      const provider = share
        ? new SharedPatCredentialProvider({
            appId: config.appId,
            requestToken: async () => token,
            repositoryHint: `${config.owner}/${config.name}`
          })
        : createPatProvider(config.appId, persistence, async () => token);
      await provider.connect();
      await finishConnection(provider, share ? "shared" : "app");
    } catch (error) {
      await credentialProvider?.disconnect();
      credentialProvider = null;
      repository = null;
      connectError.textContent = friendlyError(error);
      connectError.hidden = false;
      setSync("Connection failed", "Review token repository access and permissions");
    } finally {
      submit.disabled = false;
      submit.textContent = "Connect securely";
    }
  });

  $<HTMLButtonElement>("[data-testid='use-shared-credential']").addEventListener("click", async () => {
    connectError.hidden = true;
    const provider = sharedCandidate();
    const credential = await provider.useShared();
    if (!credential) {
      connectError.textContent = "The shared credential is no longer available. Connect with another method.";
      connectError.hidden = false;
      await refreshSharedAvailability();
      return;
    }
    setSync("Connecting", `Verifying the shared credential against ${config.owner}/${config.name}`);
    try {
      await finishConnection(provider, "shared");
    } catch (error) {
      await provider.disconnect();
      connectError.textContent = friendlyError(error);
      connectError.hidden = false;
      setSync("Connection failed", "The shared credential remains stored, but Quick Log did not use it");
    }
  });

  const showAuthPanel = (method: "pat" | "device"): void => {
    const patButton = $<HTMLButtonElement>("[data-testid='auth-method-pat']");
    const deviceButton = $<HTMLButtonElement>("[data-testid='auth-method-device']");
    patButton.setAttribute("aria-selected", String(method === "pat"));
    deviceButton.setAttribute("aria-selected", String(method === "device"));
    connectForm.hidden = method !== "pat";
    $<HTMLElement>("[data-auth-panel='device']").hidden = method !== "device";
  };

  $<HTMLButtonElement>("[data-testid='auth-method-pat']").addEventListener("click", () => showAuthPanel("pat"));
  $<HTMLButtonElement>("[data-testid='auth-method-device']").addEventListener("click", () => showAuthPanel("device"));

  $<HTMLButtonElement>("[data-testid='device-start']").addEventListener("click", async (event) => {
    const startButton = event.currentTarget as HTMLButtonElement;
    const deviceError = $<HTMLElement>("[data-device-error]");
    const deviceStatus = $<HTMLElement>("[data-testid='device-status']");
    deviceError.hidden = true;
    if (!config.fake && !config.deviceClientId) {
      deviceError.textContent = "Device Flow needs a public GitHub OAuth app client ID in PUBLIC_GITHUB_DEVICE_CLIENT_ID.";
      deviceError.hidden = false;
      return;
    }
    let polls = 0;
    const fakeFetch: typeof fetch = async () => {
      polls += 1;
      const body = polls === 1
        ? { device_code: "quick-log-device", user_code: "LUNA-2026", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }
        : polls === 2
          ? { error: "authorization_pending" }
          : { access_token: "quick-log-fake-device-credential", token_type: "bearer", scope: "repo" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const provider = new DeviceFlowCredentialProvider({
      clientId: config.fake ? "quick-log-fake-client" : config.deviceClientId,
      scopes: [config.deviceScope],
      onVerification: (info) => {
        const link = $<HTMLAnchorElement>("[data-testid='device-verification-link']");
        link.href = info.verificationUriComplete ?? info.verificationUri;
        $<HTMLElement>("[data-testid='device-user-code']").textContent = info.userCode;
        $<HTMLElement>("[data-device-code-card]").hidden = false;
        deviceStatus.textContent = "Waiting for approval on GitHub… This code expires automatically.";
      },
      ...(config.fake ? { fetch: fakeFetch, sleep: async () => {} } : {})
    });
    startButton.disabled = true;
    startButton.textContent = "Waiting for GitHub…";
    setSync("Connecting", "Device Flow is waiting for GitHub authorisation");
    try {
      await provider.connect();
      deviceStatus.textContent = "Authorised. Verifying repository access…";
      await finishConnection(provider, "device");
    } catch (error) {
      await provider.disconnect();
      deviceError.textContent = friendlyError(error);
      deviceError.hidden = false;
      deviceStatus.textContent = "Device authorisation did not complete.";
      setSync("Connection failed", "Restart Device Flow or choose a PAT");
    } finally {
      startButton.disabled = false;
      startButton.textContent = "Start Device Flow";
    }
  });

  connectForm.addEventListener("change", () => {
    const data = new FormData(connectForm);
    persistenceAck.hidden = data.get("persistence") !== "persistent" && data.get("shareCredential") !== "on";
  });

  $<HTMLButtonElement>("[data-token-toggle]").addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const reveal = tokenInput.type === "password";
    tokenInput.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Hide" : "Show";
    button.setAttribute("aria-label", reveal ? "Hide token" : "Show token");
  });

  $<HTMLButtonElement>("[data-dialog-cancel]").addEventListener("click", () => connectDialog.close());
  $<HTMLButtonElement>("[data-dialog-cancel-device]").addEventListener("click", () => connectDialog.close());
  $<HTMLButtonElement>("[data-testid='new-record-button']").addEventListener("click", resetForm);
  $<HTMLButtonElement>("[data-reset-button]").addEventListener("click", resetForm);
  recordForm.addEventListener("input", scheduleDraftSave);
  bodyInput.addEventListener("input", () => {
    characterCount.textContent = `${bodyInput.value.length.toLocaleString()} / 4,000`;
  });

  $<HTMLButtonElement>("[data-testid='disconnect-session']").addEventListener("click", async () => {
    await credentialProvider?.disconnect();
    disconnectDialog.close();
    returnToDemo();
  });

  $<HTMLButtonElement>("[data-testid='remove-shared-credential']").addEventListener("click", async () => {
    const shared = credentialScope === "shared" && credentialProvider instanceof SharedPatCredentialProvider
      ? credentialProvider
      : sharedCandidate();
    await shared.disconnect({ shared: true });
    disconnectDialog.close();
    if (credentialScope === "shared") returnToDemo();
    else setSync("Shared credential removed", "This app’s separate connection is unchanged");
  });
  $<HTMLButtonElement>("[data-disconnect-cancel]").addEventListener("click", () => disconnectDialog.close());

  deleteButton.addEventListener("click", () => {
    const record = collection.records.find((item) => item.id === selectedId);
    if (!record) return;
    $<HTMLElement>("[data-delete-detail]").textContent = connected
      ? `“${record.title}” will be removed from ${config.dataPath} in a revision-aware commit. A concurrent remote change will stop the delete.`
      : `“${record.title}” will be removed only from this temporary demo preview. GitHub will not be called.`;
    $<HTMLButtonElement>("[data-testid='confirm-delete']").textContent = connected ? "Delete and commit" : "Remove preview";
    deleteDialog.showModal();
  });
  $<HTMLButtonElement>("[data-delete-cancel]").addEventListener("click", () => deleteDialog.close());
  $<HTMLButtonElement>("[data-testid='confirm-delete']").addEventListener("click", async (event) => {
    const record = collection.records.find((item) => item.id === selectedId);
    if (!record) return;
    const next = parseCollection({ schemaVersion: 1, records: collection.records.filter((item) => item.id !== record.id) });
    if (!connected) {
      collection = next;
      deleteDialog.close();
      selectedId = collection.records[0]?.id ?? null;
      renderList();
      if (collection.records[0]) populateForm(collection.records[0]); else resetForm();
      setSync("Demo preview updated", "The entry was removed only from this tab; GitHub was not called");
      return;
    }
    if (!navigator.onLine) {
      deleteDialog.close();
      showFormError("You’re offline. Deletion was not queued or sent; reconnect and choose delete again.");
      return;
    }
    const confirm = event.currentTarget as HTMLButtonElement;
    confirm.disabled = true;
    confirm.textContent = "Deleting…";
    try {
      await commitCollection(next, revision, `Delete log: ${record.title}`);
      deleteDialog.close();
      selectedId = collection.records[0]?.id ?? null;
      if (collection.records[0]) populateForm(collection.records[0]); else resetForm();
    } catch (error) {
      deleteDialog.close();
      if (isConflict(error)) await showConflict(next, `Delete log: ${record.title}`, false);
      else showFormError(friendlyError(error));
    } finally {
      confirm.disabled = false;
      confirm.textContent = "Delete and commit";
    }
  });

  $<HTMLButtonElement>("[data-draft-restore]").addEventListener("click", () => {
    if (!recoveredDraft) return;
    idInput.value = recoveredDraft.id;
    selectedId = recoveredDraft.id || null;
    titleInput.value = recoveredDraft.title;
    bodyInput.value = recoveredDraft.body;
    tagsInput.value = recoveredDraft.tags;
    timeInput.value = recoveredDraft.occurredAt;
    characterCount.textContent = `${recoveredDraft.body.length.toLocaleString()} / 4,000`;
    draftRecovery.hidden = true;
    $<HTMLElement>("[data-draft-chip]").textContent = "Recovered local draft";
    titleInput.focus();
  });
  $<HTMLButtonElement>("[data-draft-discard]").addEventListener("click", () => {
    recoveredDraft = null;
    draftRecovery.hidden = true;
    void clearDraft();
  });

  window.addEventListener("offline", updateConnectivity);
  window.addEventListener("online", () => {
    updateConnectivity();
    void restoreOwnCredential();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-conflict-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!conflict) return;
      const resolution = conflict;
      const action = button.dataset.conflictAction;
      if (action === "reload") {
        collection = resolution.remote.collection;
        revision = resolution.remote.sha;
        conflict = null;
        conflictPanel.hidden = true;
        selectedId = collection.records[0]?.id ?? null;
        renderList();
        if (collection.records[0]) populateForm(collection.records[0]); else resetForm();
        setSync("Remote version loaded", "Your conflicting local version was not committed");
        return;
      }
      try {
        if (action === "overwrite") {
          await commitCollection(resolution.local, resolution.remote.sha, `${resolution.message} (explicit conflict overwrite)`);
          return;
        }
        if (action === "copy") {
          const localRecord = resolution.local.records.find((record) => record.id === selectedId) ?? resolution.local.records[0];
          if (!localRecord) throw new Error("There is no local record to copy.");
          const now = new Date().toISOString();
          const copy = { ...localRecord, id: createRecordId(), title: `${localRecord.title} (copy)`, createdAt: now, updatedAt: now };
          const merged = parseCollection({ schemaVersion: 1, records: [copy, ...resolution.remote.collection.records] });
          selectedId = copy.id;
          await commitCollection(merged, resolution.remote.sha, `Save conflict copy: ${localRecord.title}`);
          populateForm(copy);
        }
      } catch (error) {
        if (isConflict(error)) await showConflict(resolution.local, resolution.message);
        else showFormError(friendlyError(error));
      }
    });
  });

  setMode(false);
  setRelease("idle");
  renderList();
  if (collection.records[0]) populateForm(collection.records[0]); else resetForm();
  updateConnectivity();
  void restoreOwnCredential();
  void loadDraft().then((draft) => {
    if (!draft || !hasDraftContent(draft)) return;
    recoveredDraft = draft;
    const saved = new Date(draft.savedAt);
    $<HTMLElement>("[data-draft-recovery-time]").textContent = Number.isNaN(saved.getTime())
      ? "Saved locally"
      : `Saved locally ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(saved)}`;
    draftRecovery.hidden = false;
  });
}
