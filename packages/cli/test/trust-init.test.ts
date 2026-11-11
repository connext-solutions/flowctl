import { describe, expect, it } from 'vitest';
import { TrustError } from '@flowctl/core';
import { askInitAnswers, type EnvCandidate } from '../src/trust-init.js';
import type { Tty } from '../src/trust-tty.js';

/**
 * The `trust init` interview (ADR 0025 section 3, "First use"), driven through a scripted terminal: the owner's
 * typed answers are what the store gets, never a value read from the config.
 */
function scripted(answers: string[]): Tty & { shown: string } {
  const queue = [...answers];
  const tty = {
    shown: '',
    write(t: string) {
      tty.shown += t;
    },
    ask(prompt: string) {
      tty.shown += prompt;
      const a = queue.shift();
      if (a === undefined) throw new Error(`no scripted answer for: ${prompt}`);
      return a;
    },
    close() {},
  };
  return tty;
}

const CANDIDATES: EnvCandidate[] = [
  { name: 'local', origin: 'https://erp.example.com' },
  { name: 'stg', origin: 'https://stg.example.com' },
];

describe('trust init interview', () => {
  it('records the class the owner types, even for an env the repo calls local', () => {
    const tty = scripted([
      'production',
      'shared',
      'https://erp.example.com',
      '',
      'stg',
      'vi',
      'vi-VN',
    ]);
    expect(askInitAnswers(tty, CANDIDATES)).toEqual({
      envs: {
        local: { origin: 'https://erp.example.com', class: 'production' },
        stg: { origin: 'https://stg.example.com', class: 'shared' },
      },
      productionOrigins: ['https://erp.example.com'],
      defaultEnv: 'stg',
      language: 'vi',
      locale: 'vi-VN',
    });
  });

  it('has no default class: Enter leaves the env out', () => {
    const tty = scripted(['', 'local', '', 'stg', 'en', 'en-US']);
    const a = askInitAnswers(tty, CANDIDATES);
    expect(Object.keys(a.envs)).toEqual(['stg']);
  });

  it('re-asks a wrong class and refuses an origin that was not listed or has a non-production env', () => {
    const tty = scripted([
      'prod',
      'local',
      'shared',
      'https://other.example.com',
      'https://stg.example.com',
      '',
      'local',
      'vi',
      'vi-VN',
    ]);
    const a = askInitAnswers(tty, CANDIDATES);
    expect(a.envs['local']?.class).toBe('local');
    expect(a.productionOrigins).toEqual([]);
    expect(tty.shown).toContain('is not one of the listed origins');
    expect(tty.shown).toContain('cannot be production');
  });

  it('refuses when only production envs were classed, so there is no default env', () => {
    const tty = scripted(['production', '', '']);
    expect(() => askInitAnswers(tty, CANDIDATES)).toThrow(TrustError);
  });
});
