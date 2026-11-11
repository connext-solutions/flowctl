import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { login } from '../src/login.js';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { fixtureConfig } from './helpers.js';

let fixture: Fixture;
beforeAll(async () => {
  fixture = await startFixture();
});
afterAll(async () => {
  await fixture.close();
});

describe('login', () => {
  it('saves the session after the user finishes logging in', async () => {
    const cfg = fixtureConfig(fixture.url);
    const path = await login(cfg, {
      profile: 'manager',
      headless: true,
      waitForUser: async (page) => {
        await page.getByRole('link', { name: 'Quản lý' }).click();
        await page.waitForURL(`${fixture.url}/`);
      },
    });
    expect(path).toBe(`${cfg.flowsPath}/.auth/local/manager.json`);
    const state: { cookies: { name: string; value: string }[] } = JSON.parse(
      readFileSync(path, 'utf8'),
    );
    expect(state.cookies).toContainEqual(
      expect.objectContaining({ name: 'role', value: 'manager' }),
    );
  });

  it('still saves the session when the user closes the window to finish', async () => {
    const cfg = fixtureConfig(fixture.url);
    const path = await login(cfg, {
      profile: 'employee',
      headless: true,
      waitForUser: async (page) => {
        await page.getByRole('link', { name: 'Nhân viên' }).click();
        await page.waitForURL(`${fixture.url}/`);
        await page.close();
      },
    });
    const state: { cookies: { name: string; value: string }[] } = JSON.parse(
      readFileSync(path, 'utf8'),
    );
    expect(state.cookies).toContainEqual(
      expect.objectContaining({ name: 'role', value: 'employee' }),
    );
  });

  it('refuses to save when the window closes while still on the login page', async () => {
    const cfg = fixtureConfig(fixture.url);
    await expect(
      login(cfg, {
        profile: 'employee',
        headless: true,
        waitForUser: async (page) => {
          await page.close();
        },
      }),
    ).rejects.toThrow(/still on the login page/);
    expect(existsSync(`${cfg.flowsPath}/.auth/local/employee.json`)).toBe(
      false,
    );
  });

  it('rejects an unknown profile before opening a browser', async () => {
    const cfg = fixtureConfig(fixture.url);
    await expect(
      login(cfg, { profile: 'boss', waitForUser: async () => {} }),
    ).rejects.toThrow(ConfigError);
  });

  it('writes the session private and gitignored (#16)', async () => {
    const cfg = fixtureConfig(fixture.url);
    const path = await login(cfg, {
      profile: 'manager',
      headless: true,
      waitForUser: asManager,
    });
    const auth = join(cfg.flowsPath, '.auth');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(auth).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(auth, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('never writes the session through a symlink (#46)', async () => {
    const cfg = fixtureConfig(fixture.url);
    const tracked = join(
      mkdtempSync(join(tmpdir(), 'flowctl-')),
      'fixture.json',
    );
    writeFileSync(tracked, 'ORIGINAL');
    mkdirSync(join(cfg.flowsPath, '.auth', 'local'), { recursive: true });
    symlinkSync(tracked, join(cfg.flowsPath, '.auth', 'local', 'manager.json'));
    await login(cfg, {
      profile: 'manager',
      headless: true,
      waitForUser: asManager,
    });
    expect(readFileSync(tracked, 'utf8')).toBe('ORIGINAL');
  });

  it('rejects a prototype key as a profile (#17)', async () => {
    const cfg = fixtureConfig(fixture.url);
    await expect(
      login(cfg, { profile: 'constructor', waitForUser: async () => {} }),
    ).rejects.toThrow(ConfigError);
  });
});

async function asManager(
  page: Parameters<Parameters<typeof login>[1]['waitForUser']>[0],
): Promise<void> {
  await page.getByRole('link', { name: 'Quản lý' }).click();
  await page.waitForURL(`${fixture.url}/`);
}

describe('login keeps only the env origin (#50)', () => {
  it('drops cookies and storage of other origins, and says which', async () => {
    const cfg = fixtureConfig(fixture.url);
    const warnings: string[] = [];
    const path = await login(cfg, {
      profile: 'manager',
      headless: true,
      warn: (m) => warnings.push(m),
      waitForUser: async (page) => {
        await page.context().addCookies([
          {
            name: 'idp',
            value: 'idp-secret',
            url: 'https://sso.idp.example',
          },
        ]);
        await asManager(page);
      },
    });
    const saved = readFileSync(path, 'utf8');
    expect(saved).toContain('"role"');
    expect(saved).not.toContain('idp-secret');
    expect(warnings.join(' ')).toContain('sso.idp.example');
    expect(warnings.join(' ')).not.toContain('idp-secret');
  });

  it('refuses to save when the window was left on another origin', async () => {
    const cfg = fixtureConfig(fixture.url);
    await expect(
      login(cfg, {
        profile: 'manager',
        headless: true,
        waitForUser: async (page) => {
          await page.route('https://sso.idp.example/**', (r) =>
            r.fulfill({ body: '<p>IdP</p>', contentType: 'text/html' }),
          );
          await page.goto('https://sso.idp.example/login');
        },
      }),
    ).rejects.toThrow(/still on the login page/);
  });
});
