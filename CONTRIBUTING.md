# Contributing

Thanks for helping. flowctl is an early preview, so open an issue (the Bug or Proposal form) before a large change.

## Set up

```bash
nvm use && bun install && bunx playwright install chromium
bun run check     # after every change: lint, format, typecheck, architecture gate, unit tests
bun run verify    # before you push: check plus the browser and accuracy tiers (about 10 minutes)
```

Node is the runtime and Bun only the package manager; never run tests with `bun test` or `bun --bun` (ADR 0018).
`bun run prepare` installs the git hooks: `check` on commit, the message format on commit, `verify` on push.

## Rules

- Read [AGENTS.md](AGENTS.md) first: the invariants there are never broken. The one most often at risk is that a
  verdict comes only from deterministic assertions, never from a model (ADR 0004).
- Test first. Browser behaviour is tested against `packages/fixture-app`, never with Playwright mocks. A new kind
  of check comes with a seeded bug in the fixture app that proves it catches the defect.
- Commits follow Conventional Commits. Everything committed is in English; other languages appear only as product
  data (UI labels of the apps under test, fixture pages, test strings).
- A design decision gets an ADR in `docs/adr/` (see its README for the format). An accepted ADR is not rewritten;
  a new one supersedes it.
- Pull requests use the template in `.github/`. CI (`Verify`) and the `Security` scan must pass before merge.

By contributing you agree that your contribution is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).

## Releasing (maintainers)

Releases are GitHub Releases with npm tarballs (ADR 0031). Bump `version` in `packages/core`, `packages/cli` and
`packages/mcp` to the same value in a pull request; after it merges, tag that commit on `main` and push the tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The `Release` workflow packs the three packages, installs them into an empty project, runs both bins and publishes
the release. To try the packing locally: `bun run build && node scripts/pack-release.mjs --version <version> --out /tmp/release`.
