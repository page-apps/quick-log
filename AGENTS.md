# Quick Log agent guide

## Repository boundary

Quick Log is one app in one repository. Its canonical data, schema, source, validation and GitHub Pages deployment belong together here. A deployed Quick Log instance may normally access only the owner/repository identity injected by its trusted build. Do not add a repository picker, accept an arbitrary repository from a URL, or make cross-repository requests.

The build-derived repository identity is public configuration. A credential is not. Tokens must never be committed, printed, placed in a URL, added to analytics, or included in generated assets.

## Canonical and derived paths

- `data/records.json` is the authoritative writable Quick Log collection.
- `schemas/records.schema.json` is its versioned portable JSON Schema.
- `src/lib/schema.ts` is the matching runtime validator used before writes and after reads.
- `demo/records.json` is a bundled, non-sensitive fixture. It is not canonical user data.
- `src/` and `public/` are source inputs.
- `dist/`, `.astro/`, test results and Playwright reports are derived and must not become canonical data.

The v1 collection is `{ "schemaVersion": 1, "records": [...] }`. A record has `id`, `title`, `body`, `tags`, `occurredAt`, `createdAt` and `updatedAt`.

## Safe extension points

Agents may add domain views and components under `src/`, improve the fixture, add tests, and add app-specific validation or generation steps before the Astro build. Keep the UI accessible, keep demo mode visibly labelled, and retain the standard security disclosure on the connection path.

App code must consume `@repo-apps/credentials`, `@repo-apps/repo-client`, `@repo-apps/runtime` and shared UI contracts. Never add direct GitHub REST, GraphQL or Git Data calls here. Do not casually reproduce or change credential storage, token redaction, core request logic, conflict semantics, or the shared runtime state machine inside the app.

Normal writes are explicit, revision-aware updates to `data/records.json`. Never commit per keystroke. A stale SHA must become a visible conflict; silent overwrite is forbidden. The conflict choices are reload remote, save the local entry as a copy, or a clearly explicit overwrite.

Device Flow and same-origin PAT sharing stay behind `@repo-apps/credentials`. App code may present verification instructions, polling state, explicit sharing consent and separate disconnect/remove-shared actions, but it must not implement OAuth endpoints, parse credential envelopes or read raw stored tokens. Shared reuse is never automatic: the user opts in again for this app, which independently verifies the self repository.

Unsaved editor content may be cached in the app-owned IndexedDB draft store. It is temporary recovery state, never canonical data and never a queued promise to commit. Offline mode keeps the draft editable but blocks repository updates and deletes until connectivity returns.

## Adding or changing a collection

1. Add or update its versioned JSON Schema under `schemas/`.
2. Add the equivalent runtime schema and types under `src/lib/`.
3. Add canonical data under `data/` and a safe demo fixture under `demo/`.
4. Validate remote reads and every proposed write with that schema.
5. Add the collection to `scripts/validate-data.ts` and cover valid and invalid examples in tests.
6. If the shape changes, increment its schema version and document an explicit migration. Do not reinterpret old data silently.

## Checks

From the repository root, run:

```sh
pnpm validate:data
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

## Release loop

The browser validates a deliberate edit and commits it through the shared repository client using the last-read blob SHA. The commit triggers this repository's Actions workflow. Actions installs locked dependencies, type-checks, tests, validates app data, builds with the trusted self-repository identity, and deploys the artifact to this repository's GitHub Pages site. In the UI, `Committed`, `Building` and `Published` are distinct states; a successful commit must never be presented as already published.
