# Quick Log App

Quick Log is the first standalone child application managed by Personal Hub.

It owns its canonical collection in `data/records.json`, schema, source, tests and GitHub Pages workflows. The framework modules it needs are vendored as workspace packages under `packages/`, so a clean checkout does not depend on the sibling `../repo-apps` directory or an unpublished package registry. See `packages/README.md` before synchronising framework code.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

Copy `.env.example` to `.env` only when you want the deterministic local adapter. The app otherwise uses demo mode until a GitHub credential is connected. Do not add tokens to source, environment files or generated output.

## GitHub Pages

Enable **Settings → Pages → Source → GitHub Actions**, then push `main`. The deployment validates the workspace packages, application types, Astro template, canonical data, unit tests, browser flows and production base paths before uploading `dist/`.

A fine-grained PAT with repository **Contents: read and write** is the narrowest connection option. For a private repository, live workflow/deployment tracking also needs **Actions: read** and **Deployments: read**; saving still works without those optional permissions.

Device Flow is hidden unless the public OAuth App client ID is configured as the repository variable `REPO_APPS_GITHUB_CLIENT_ID`. Its OAuth repository scope defaults to `public_repo`; set `REPO_APPS_GITHUB_DEVICE_SCOPE` to `repo` only when the app repository is private and you accept the broader OAuth access.

## Experimental private Todo plugin

Quick Log also hosts the trusted first-party `page-apps/todo-list-plugin` remote as a Service Worker + Module Federation example. The plugin uses a separate session-only token with **Contents: read** for that private repository; Quick Log does not silently reuse its self-repository credential. The token is sent only to the root-scoped worker, while the remote receives an in-memory, revision-aware task capability.

The checked-in plugin revision is immutable and can be overridden only by trusted build configuration through `PUBLIC_TODO_PLUGIN_SHA`. Repository identity and artifact paths are fixed in source. Disconnecting unmounts the plugin, clears the worker credential and removes its SHA-scoped private caches.

The complete federation browser test uses the actual sibling `../todo-list-plugin/dist` when that private checkout is available. It runs at the GitHub Pages project shape `/quick-log/` and verifies the dynamic chunk, CSS, SVG and anonymous post-disconnect failure. Public CI checkouts without the sibling remote skip that one cross-repository canary while retaining worker, build and ordinary browser coverage.
