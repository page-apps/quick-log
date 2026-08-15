import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = workspaceRoot;
const distRoot = resolve(appRoot, "dist");
const todoPluginDist = resolve(appRoot, "../todo-list-plugin/dist");
const astroBin = resolve(appRoot, "node_modules/astro/bin/astro.mjs");
const port = 4324;
const projectBase = "/quick-log";

const build = spawnSync(process.execPath, [astroBin, "build"], {
  cwd: appRoot,
  env: process.env,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const pathname = decodeURIComponent(requestUrl.pathname);
    const withoutBase = pathname === projectBase || pathname === `${projectBase}/`
      ? "/"
      : pathname.startsWith(`${projectBase}/`)
        ? pathname.slice(projectBase.length)
        : pathname;
    const relativePath = withoutBase === "/"
      ? "index.html"
      : withoutBase.replace(/^\/+/, "");
    if (relativePath.startsWith("__todo-plugin-fixture__/")) {
      const fixtureRelative = relativePath.slice("__todo-plugin-fixture__/".length);
      const fixturePath = resolve(todoPluginDist, fixtureRelative);
      if (fixturePath !== todoPluginDist && !fixturePath.startsWith(`${todoPluginDist}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const content = await readFile(fixturePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[extname(fixturePath)] ?? "application/octet-stream",
      });
      response.end(content);
      return;
    }
    const filePath = resolve(distRoot, relativePath);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const fileStat = await stat(filePath);
    const resolvedFile = fileStat.isDirectory() ? resolve(filePath, "index.html") : filePath;
    const content = await readFile(resolvedFile);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(resolvedFile)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.info(`Quick Log E2E artifact available at http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
