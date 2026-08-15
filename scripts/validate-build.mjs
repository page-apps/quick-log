import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distRoot = resolve(process.cwd(), "dist");
const html = await readFile(resolve(distRoot, "index.html"), "utf8");
const worker = await readFile(resolve(distRoot, "plugin-worker.js"), "utf8");
const [owner = "local", repository = "quick-log"] = (process.env.GITHUB_REPOSITORY ?? "local/quick-log").split("/");
const projectBase = process.env.GITHUB_ACTIONS === "true" && repository !== `${owner}.github.io`
  ? `/${repository}`
  : "";
const expectedFavicon = `${projectBase}/favicon.svg`;

if (!html.includes(`href="${expectedFavicon}"`)) {
  throw new Error(`The built favicon URL must be ${expectedFavicon}.`);
}

const assetUrls = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map((match) => match[1]);
for (const assetUrl of new Set(assetUrls)) {
  if (!assetUrl?.startsWith(`${projectBase}/`)) {
    throw new Error(`Built asset URL escapes the configured Pages base: ${assetUrl ?? "unknown"}`);
  }
  const relativePath = assetUrl.slice(projectBase.length).replace(/^\/+/, "");
  await access(resolve(distRoot, relativePath || "index.html"));
}

if (/github_pat_[A-Za-z0-9_]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,}/i.test(html)) {
  throw new Error("The Pages artifact appears to contain a credential.");
}

if (!html.includes('id="todo-plugin-config"') || !/[a-f0-9]{40}/.test(html)) {
  throw new Error("The private plugin host must embed a trusted immutable plugin revision.");
}
if (!worker.includes("page-apps") || !worker.includes("todo-list-plugin") || !worker.includes("VIRTUAL_PREFIX")) {
  throw new Error("The private plugin worker must retain its fixed repository and base-scoped virtual path.");
}
if (/github_pat_[A-Za-z0-9_]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,}/i.test(worker)) {
  throw new Error("The private plugin worker appears to contain a credential.");
}

console.info(`dist/index.html: ${assetUrls.length} local asset reference(s) valid for ${projectBase || "/"}; private plugin worker validated`);
