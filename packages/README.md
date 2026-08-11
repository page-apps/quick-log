# Vendored Repo Apps packages

These packages are a source snapshot of the framework modules needed by Quick Log. They are kept in this repository so a clean standalone checkout can install, test and deploy without a sibling `repo-apps` directory or an unpublished package registry.

The upstream development copies currently live in `../repo-apps/packages/` in the local multi-repository workspace. Treat updates here as an explicit framework sync: compare source, tests and package metadata together, then run the full Quick Log quality gate. Do not edit credential storage, repository request logic or conflict semantics as part of an ordinary app feature.
