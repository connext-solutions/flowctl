---
type: ADR
id: "0031"
title: "Releases are GitHub Releases with npm tarballs; no npm registry"
status: accepted
date: 2026-11-11
---

## Context

ADR 0029 planned to publish `@flowctl/core`, `@flowctl/cli` and `@flowctl/mcp` to npm under an `@flowctl`
organisation, and until then to have the private overlay depend on a git tag. The owner decided on 2026-11-11 not
to create an npm organisation and to distribute through GitHub instead.

GitHub offers two channels. GitHub Packages has an npm registry, but it serves only the scope of the repository
owner (`@connext-solutions/...`), so the packages would need another name, and installing from it needs a token
even for a public package. A Bun or npm git dependency cannot install one package out of a monorepo subfolder.

## Decision

1. **A release is a GitHub Release of `connext-solutions/flowctl`** whose assets are the `npm pack` tarballs of
   core, cli and mcp (`flowctl-core-<v>.tgz`, ...). A maintainer pushes a tag `v<version>` on `main`; the
   `Release` workflow builds, packs, installs the tarballs into an empty project, runs both bins, and publishes.
   Versions below 1.0.0 and versions with a pre-release part are marked pre-release.
2. **Names stay `@flowctl/*`.** No registry owns the scope, so nothing has to match it.
3. **Install by URL.** A consumer depends on the asset URL, for example
   `"@flowctl/cli": "https://github.com/connext-solutions/flowctl/releases/download/v0.1.0/flowctl-cli-0.1.0.tgz"`.
   The tarball's own dependency on `@flowctl/core` is rewritten at pack time to the core tarball of the same
   release (`scripts/release-manifest.mjs`), so one URL pulls a consistent set. Public assets need no token.
4. **All released packages share one version**, the one in their `package.json`, which must equal the tag.
   fixture-app is never released.

## Options considered

- **npm under `@flowctl`** (ADR 0029): the shortest install line and semver ranges, but needs an organisation the
  owner does not want to run now. Still possible later: the tarballs are what `npm publish` would upload.
- **GitHub Packages npm registry:** a familiar `bun add`, but a forced rename to `@connext-solutions/...` and a
  token for every install, which shuts out users without a GitHub token.
- **Git dependency on a tag:** no release step, but package managers cannot take one workspace package out of a
  monorepo, and every install would need the build toolchain.
- **Release tarballs** (chosen): no account, no token, no rename; costs semver ranges (a URL pins one version).

## Consequences

- **Easier:** releasing is pushing a tag; anyone can install without an account; the overlay pins an exact
  release by URL.
- **Harder:** no `^` ranges or `npm outdated`; upgrading means editing URLs (all three at once). A lockfile records
  the tarball's integrity, so a replaced asset is detected.
- ADR 0029 decision 2 ("by version (npm), or by git tag until the first npm release") is read as "by release URL".
- **Revisit when:** outside users ask for registry installs, or ranges become necessary; publishing the same
  tarballs to npm then needs only the organisation and a publish step.
