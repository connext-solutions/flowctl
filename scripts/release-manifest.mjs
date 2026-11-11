/**
 * The manifest a release tarball ships (ADR 0031): the workspace manifest with `private`, `scripts` and
 * `devDependencies` removed and every `workspace:` dependency pointed at the tarball of the same release.
 *
 * @example releaseManifest(cliPkg, '0.2.0', 'https://github.com/o/r/releases/download')
 *   // dependencies['@flowctl/core'] === 'https://github.com/o/r/releases/download/v0.2.0/flowctl-core-0.2.0.tgz'
 */

/** Packages that are released, by directory under `packages/`; fixture-app stays unpublished. */
export const RELEASED = ['core', 'cli', 'mcp'];

/** Base of the release asset URLs of the public repository. */
export const DOWNLOAD_BASE = 'https://github.com/connext-solutions/flowctl/releases/download';

/** `@flowctl/core` → `flowctl-core`: the file name `npm pack` gives a scoped package. */
export const tarballStem = (name) => name.replace(/^@/, '').replace('/', '-');

/** File name of a package's tarball for a version. */
export const tarballName = (name, version) => `${tarballStem(name)}-${version}.tgz`;

/** Release asset URL of a package's tarball. */
export const tarballUrl = (name, version, base = DOWNLOAD_BASE) => `${base}/v${version}/${tarballName(name, version)}`;

/** A semantic version without build metadata, optionally with a pre-release part. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param pkg the parsed workspace `package.json`.
 * @param version the release version; it must equal `pkg.version`.
 * @throws {Error} when the version is malformed or differs from the manifest, or a `workspace:` dependency is not
 *   a released package.
 */
export function releaseManifest(pkg, version, base = DOWNLOAD_BASE) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  if (pkg.version !== version) throw new Error(`${pkg.name} is at ${pkg.version}, not ${version}`);
  const { private: _private, scripts: _scripts, devDependencies: _dev, ...rest } = pkg;
  const deps = Object.fromEntries(
    Object.entries(rest.dependencies ?? {}).map(([dep, spec]) => {
      if (!String(spec).startsWith('workspace:')) return [dep, spec];
      if (!RELEASED.some((dir) => dep === `@flowctl/${dir}`)) throw new Error(`${pkg.name} depends on unreleased ${dep}`);
      return [dep, tarballUrl(dep, version, base)];
    }),
  );
  return { ...rest, ...(rest.dependencies ? { dependencies: deps } : {}) };
}
