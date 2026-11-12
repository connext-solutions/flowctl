import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { findSecret } from './find-secret.js';

/** One place a secret was found: a file (`trace.zip:trace.network` for a zip entry) or a named text, and its forms. */
export interface Leak {
  where: string;
  forms: string[];
}

/**
 * The entries of a zip archive in memory, by name: stored and deflated entries, read from the central directory, so
 * sizes written in data descriptors (as Playwright's trace writer does) are known.
 *
 * @throws {Error} for a file without an end-of-central-directory record or an entry in another method.
 */
export function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const out = new Map<string, Buffer>();
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8)
      throw new Error(`zip entry ${name}: method ${method}`);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

/** Every file under `dir` (recursively), with each `.zip` unpacked into its entries, as raw bytes by name. */
export function runFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(dir, path);
      const bytes = readFileSync(path);
      out.set(rel, bytes);
      if (name.endsWith('.zip'))
        for (const [entry, data] of unzip(bytes))
          out.set(`${rel}:${entry}`, data);
    }
  };
  walk(dir);
  return out;
}

/** Whether a line of a trace's `trace.trace` is a console event (with the source location of the message). */
export const isConsoleEvent = (line: string): boolean =>
  line.includes('"type":"console"');

/**
 * Every file under `dir` as {@link runFiles} lists it, with each `trace.trace` split into lines and its console
 * events left out: Playwright records them with their source URL, which holds a secret the app put in a query
 * (the `it.fails` case of `replay.browser.test.ts`, ADR 0030 "Not covered").
 */
export function runOutputs(dir: string): [string, Uint8Array | string][] {
  return [...runFiles(dir)].flatMap(
    ([name, data]): [string, Uint8Array | string][] =>
      name.endsWith(':trace.trace')
        ? data
            .toString('utf8')
            .split('\n')
            .filter((l) => !isConsoleEvent(l))
            .map((l, i) => [`${name} line ${i}`, l])
        : [[name, data]],
  );
}

/** The leaks of `secret` in named byte strings or texts; empty when none holds any form of it. */
export function leaksIn(
  items: Iterable<[string, Uint8Array | string]>,
  secret: string,
): Leak[] {
  return [...items]
    .map(([where, data]) => ({ where, forms: findSecret(data, secret) }))
    .filter((l) => l.forms.length > 0);
}

/** A decoded PNG: its size and the RGB of a pixel. */
export interface Png {
  width: number;
  height: number;
  rgb(x: number, y: number): [number, number, number];
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG, the kind Chromium's screenshots are.
 *
 * @throws {Error} for any other kind of PNG.
 */
export function decodePng(png: Buffer): Png {
  const idat: Buffer[] = [];
  let [width, height, bpp] = [0, 0, 0];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)];
      const [depth, color, interlace] = [data[8], data[9], data[12]];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
        throw new Error(`unsupported PNG (${depth}/${color}/${interlace})`);
      bpp = color === 6 ? 4 : 3;
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= bpp ? (px[y * stride + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (px[(y - 1) * stride + i - bpp] ?? 0) : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
      px[y * stride + i] = (x + pred) & 0xff;
    }
  }
  return {
    width,
    height,
    rgb: (x, y) => {
      const o = (Math.floor(y) * width + Math.floor(x)) * bpp;
      return [px[o] ?? 0, px[o + 1] ?? 0, px[o + 2] ?? 0];
    },
  };
}
