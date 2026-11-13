import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ensureDirInside,
  FlowError,
  NAME_PATTERN,
  PROVENANCE_STATES,
  RunError,
  StepError,
  writeFileNoFollow,
} from '../src/foundation/index.js';

/**
 * The `foundation` layer is the lowest in core: shared names, typed errors and symlink-safe fs,
 * with no dependency on any other core folder (task T1.0). It is re-exported at the old paths so
 * existing imports keep working; those re-exports are covered by the suites that already use them.
 */
describe('foundation layer', () => {
  it('exposes the shared name pattern', () => {
    expect(NAME_PATTERN.test('work-schedules')).toBe(true);
    expect(NAME_PATTERN.test('Bad Name')).toBe(false);
  });

  it('carries the typed error classes with their fields', () => {
    expect(new ConfigError('x')).toBeInstanceOf(Error);
    expect(new FlowError('x')).toBeInstanceOf(Error);
    const run = new RunError('app_unreachable', 'start the app');
    expect(run.kind).toBe('app_unreachable');
    expect(run.hint).toBe('start the app');
    const step = new StepError('not_found', 'no button');
    expect(step.kind).toBe('not_found');
  });

  it('exposes the symlink-safe fs helpers', () => {
    expect(typeof ensureDirInside).toBe('function');
    expect(typeof writeFileNoFollow).toBe('function');
  });

  it('names the four provenance states, strongest first', () => {
    expect([...PROVENANCE_STATES]).toEqual([
      'verified',
      'hand-written',
      'unverified',
      'unclassified',
    ]);
  });
});
