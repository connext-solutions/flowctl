import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { TrustError } from '@flowctl/core';

/**
 * The controlling terminal of the owner, opened directly as `/dev/tty`, never stdin or stdout, so a pipe or
 * an agent's redirected stdio cannot answer a trust prompt (ADR 0025 section 3).
 */
export interface Tty {
  write(text: string): void;
  /** One line typed by the owner; `echo: false` hides it (passphrases). */
  ask(prompt: string, o?: { echo?: boolean }): string;
  close(): void;
}

/**
 * Opens `/dev/tty`.
 *
 * @throws {TrustError} `tty_required` when stdin or stdout is not a terminal or there is no `/dev/tty`: every
 *   trust mutation is interactive and refuses without one.
 */
export function openTty(): Tty {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new TrustError(
      'tty_required',
      'flowctl trust changes the trust store only in an interactive terminal. Run it yourself, not through a script or an agent.',
    );
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    throw new TrustError(
      'tty_required',
      'Cannot open /dev/tty; run flowctl trust in an interactive terminal.',
    );
  }
  const write = (text: string): void => {
    writeSync(fd, text);
  };
  return {
    write,
    ask(prompt, o = {}) {
      write(prompt);
      if (o.echo === false) setEcho(false);
      try {
        return readLine(fd);
      } finally {
        if (o.echo === false) {
          setEcho(true);
          write('\n');
        }
      }
    },
    close: () => closeSync(fd),
  };
}

/**
 * Asks the owner to type back a nonce shown only on `/dev/tty` (ADR 0025 section 3).
 *
 * @throws {TrustError} `confirmation_mismatch` when the typed text differs.
 */
export function confirmNonce(tty: Tty, what: string): void {
  const nonce = randomBytes(3).toString('hex');
  const typed = tty.ask(`To ${what}, type ${nonce}: `);
  if (typed.trim() !== nonce)
    throw new TrustError(
      'confirmation_mismatch',
      'The confirmation did not match; nothing was changed.',
    );
}

function readLine(fd: number): string {
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, 1, null);
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'EAGAIN') continue;
      throw e;
    }
    if (n === 0 || buf[0] === 0x0a) break;
    if (buf[0] !== 0x0d) bytes.push(buf[0] ?? 0);
    if (bytes.length > 4096) break;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Turns terminal echo on or off for a hidden answer; a missing `stty` leaves echo as it is. */
function setEcho(on: boolean): void {
  spawnSync('/bin/stty', [on ? 'echo' : '-echo'], {
    stdio: ['inherit', 'ignore', 'ignore'],
  });
}
