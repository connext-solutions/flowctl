import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceMode } from '../src/argv.js';

/** `flowctl replay --trace` (ADR 0030): a safe trace unless the person running asks for a full one. */
describe('traceMode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the default to core when the flag is absent, and accepts safe quietly', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(traceMode(undefined)).toBeUndefined();
    expect(traceMode('safe')).toBe('safe');
    expect(err).not.toHaveBeenCalled();
  });

  it('passes full through and warns that the trace must not be shared', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(traceMode('full')).toBe('full');
    expect(String(err.mock.calls[0]?.[0])).toContain('do not attach');
  });

  it('refuses any other value', () => {
    expect(() => traceMode('all')).toThrow(/safe or full/);
  });
});
