export interface ConflictViewOptions<T> {
  readonly local: T;
  readonly remote?: T;
  readonly format?: (value: T) => string;
  readonly onReload: () => void | Promise<void>;
  readonly onSaveCopy: () => void | Promise<void>;
}

export function renderConflict<T>(container: HTMLElement, options: ConflictViewOptions<T>): () => void {
  const document = container.ownerDocument;
  const section = document.createElement("section");
  section.dataset.repoAppConflict = "";
  section.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  heading.textContent = "Remote changes detected";
  const help = document.createElement("p");
  help.textContent = "Your changes were not overwritten. Compare the versions and choose how to continue.";
  section.append(heading, help);

  const format = options.format ?? ((value: T) => JSON.stringify(value, null, 2));
  section.append(version(document, "Your version", format(options.local)));
  if (options.remote !== undefined) section.append(version(document, "Repository version", format(options.remote)));

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload repository version";
  reload.addEventListener("click", options.onReload);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Save my version as a copy";
  copy.addEventListener("click", options.onSaveCopy);
  section.append(reload, copy);
  container.replaceChildren(section);
  return () => section.remove();
}

function version(document: Document, title: string, content: string): HTMLElement {
  const article = document.createElement("article");
  const heading = document.createElement("h3");
  heading.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = content;
  article.append(heading, pre);
  return article;
}
