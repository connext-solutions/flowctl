import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

describe('main --help', () => {
  it('prints usage on stdout and exits 0', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      expect(await main(['--help'])).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('Usage:');
    } finally {
      write.mockRestore();
    }
  });

  it('accepts -h as the first argument', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      expect(await main(['-h'])).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('Usage:');
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    ['replay', 'x', '--help'],
    ['replay', 'x', '-h'],
    ['replay', '--tag', '-h'],
    ['replay', '--config', '/nonexistent/flowctl.yaml', '--', '-h'],
  ])('only reads help as the first argument: %j exits 2', async (...argv) => {
    const out = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(await main(argv)).toBe(2);
      expect(out).not.toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('keeps exit 2 for a missing command', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(await main([])).toBe(2);
    } finally {
      write.mockRestore();
    }
  });
});
