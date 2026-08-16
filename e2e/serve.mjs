import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = workspaceRoot;
const distRoot = resolve(appRoot, "dist");
const todoPluginDist = resolve(appRoot, "../todo-list-plugin/dist");
const todoFixturePath = resolve(appRoot, "../todo-list-plugin/demo/tasks.json");
const astroBin = resolve(appRoot, "node_modules/astro/bin/astro.mjs");
const port = 4324;
const projectBase = "/quick-log";
const initialTodoState = await readFile(todoFixturePath, "utf8");
let todoStateContent = initialTodoState;
let todoStateVersion = 1;
let todoStateSha = `fixture-task-sha-${todoStateVersion}`;

function json(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

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
    const todoApiPrefix = `${projectBase}/__todo-state-api__`;
    if (pathname.startsWith(`${todoApiPrefix}/`)) {
      if (!String(request.headers.authorization ?? "").startsWith("Bearer ")) {
        json(response, 401, { message: "Authentication required" });
        return;
      }
      const apiPath = pathname.slice(todoApiPrefix.length);
      if (request.method === "GET" && [
        "/repos/page-apps/todo-list-plugin",
        "/repos/page-apps/todo-list-data",
      ].includes(apiPath)) {
        json(response, 200, {
          full_name: apiPath.slice("/repos/".length),
          default_branch: "main",
          permissions: { pull: true, push: apiPath.endsWith("todo-list-data") },
        });
        return;
      }
      if (apiPath === "/repos/page-apps/todo-list-data/contents/data/tasks.json") {
        if (request.method === "GET") {
          json(response, 200, {
            type: "file",
            path: "data/tasks.json",
            sha: todoStateSha,
            content: Buffer.from(todoStateContent, "utf8").toString("base64"),
            size: Buffer.byteLength(todoStateContent),
            html_url: "https://github.com/page-apps/todo-list-data/blob/main/data/tasks.json",
          });
          return;
        }
        if (request.method === "PUT") {
          const body = JSON.parse(await requestBody(request));
          if (body.sha !== todoStateSha) {
            json(response, 409, { message: "data/tasks.json changed since it was loaded" });
            return;
          }
          todoStateContent = Buffer.from(String(body.content), "base64").toString("utf8");
          todoStateVersion += 1;
          todoStateSha = `fixture-task-sha-${todoStateVersion}`;
          const commitSha = todoStateVersion.toString(16).padStart(40, "0");
          json(response, 200, {
            content: { path: "data/tasks.json", sha: todoStateSha },
            commit: {
              sha: commitSha,
              html_url: `https://github.com/page-apps/todo-list-data/commit/${commitSha}`,
            },
          });
          return;
        }
      }
      json(response, 404, { message: "Fixture API route not found" });
      return;
    }
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
