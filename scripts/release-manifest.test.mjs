import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { releaseManifest, tarballName, tarballUrl } from './release-manifest.mjs';

const BASE = 'https://example.test/dl';
const cli = {
  name: '@flowctl/cli',
  version: '0.2.0',
  private: true,
  scripts: { build: 'tsc' },
  dependencies: { '@flowctl/core': 'workspace:*', zod: '^4.0.0' },
  devDependencies: { '@flowctl/fixture-app': 'workspace:*' },
};

describe('releaseManifest', () => {
  it('points workspace dependencies at the tarball of the same release', () => {
    const m = releaseManifest(cli, '0.2.0', BASE);
    assert.deepEqual(m.dependencies, {
      '@flowctl/core': 'https://example.test/dl/v0.2.0/flowctl-core-0.2.0.tgz',
      zod: '^4.0.0',
    });
  });
  it('drops private, scripts and devDependencies', () => {
    const m = releaseManifest(cli, '0.2.0', BASE);
    assert.equal('private' in m, false);
    assert.equal('scripts' in m, false);
    assert.equal('devDependencies' in m, false);
  });
  it('refuses a version that differs from the manifest or is malformed', () => {
    assert.throws(() => releaseManifest(cli, '0.3.0', BASE), /is at 0.2.0/);
    assert.throws(() => releaseManifest({ ...cli, version: 'v0.2.0' }, 'v0.2.0', BASE), /not a release version/);
  });
  it('refuses a workspace dependency on an unreleased package', () => {
    const bad = { ...cli, dependencies: { '@flowctl/fixture-app': 'workspace:*' } };
    assert.throws(() => releaseManifest(bad, '0.2.0', BASE), /unreleased @flowctl\/fixture-app/);
  });
  it('names tarballs the way npm pack does', () => {
    assert.equal(tarballName('@flowctl/mcp', '1.0.0-rc.1'), 'flowctl-mcp-1.0.0-rc.1.tgz');
    assert.equal(tarballUrl('@flowctl/mcp', '1.0.0', BASE), 'https://example.test/dl/v1.0.0/flowctl-mcp-1.0.0.tgz');
  });
});
