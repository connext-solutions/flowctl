/**
 * Accepted env-input paths of T0.13, as of main 9168c2f. One entry per file and construct (see
 * `env-reads.mjs`), with how many there are; no line numbers. Adding or raising an entry needs the owner:
 * a new `env:` input path is a red-tier change (ADR 0024 section 7, issue #41). Since T1.14 every flow `{ env }` input
 * is also checked against the trust store allowlist at run time; this gate stays as a tripwire for new paths
 * that would bypass that check. A stale entry fails the gate.
 */
export const ENV_BASELINE = [
  { file: 'packages/core/src/flow/schema.ts', construct: 'schema key env', count: 1, why: 'input source `{ env: NAME }`' },
  { file: 'packages/core/src/flow/templates.ts', construct: 'process.env', count: 1, why: 'default value of the `env` parameter of resolveInputs; the `src.env` input read there is not detected' },
  { file: 'packages/core/src/run/hooks.ts', construct: 'process.env', count: 1, why: 'the parent environment is handed to buildHookEnv, which reads only the names ADR 0021 Amendment 2026-11-02 s.9-10 allow (locales, TZ, TERM, consented and pinned names)' },
  { file: 'packages/core/src/run/prepare.ts', construct: "'env' in", count: 1, why: 'picks `{ env }` inputs as secret' },
  { file: 'packages/core/src/system1/client.ts', construct: 'process.env', count: 1, why: 'System 1 API key lookup default' },
  { file: 'packages/core/src/trust/anchor-io.ts', construct: 'process.env', count: 1, why: 'passes only DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR, when set, to /usr/bin/secret-tool so the Linux Secret Service anchor can answer (ADR 0025 Amendment 2026-11-02 section 7); no value reaches a flow, a model or a log. Added 2026-11-07 for T1.0 (anchor), under the owner go-ahead of 2026-11-07' },
  { file: 'packages/core/src/trust/consent/entry.ts', construct: 'schema key env', count: 1, why: 'hook consent entry stores the env NAMES the owner allowed (ADR 0021 Amendment 2026-11-02 s.9 allowlist, checked by checkHookEnv); no value is read. Added 2026-11-03 for T1.0 C4, approved by the owner on 2026-11-03' },
];
