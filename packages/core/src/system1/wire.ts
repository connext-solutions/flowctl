import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { rootCertificates } from 'node:tls';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * The largest System 1 answer read, in bytes, counted after decompression. A real answer is a few KB (one choice
 * per question); a larger one is a misconfigured or hostile backend, and is not read to the end (#57, ADR 0022
 * contract 5).
 *
 * @internal
 */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/**
 * Whether `address`, as a connected socket reports it, is this machine: `127.0.0.0/8`, `::1` or
 * `::ffff:127.0.0.0/104`. `0.0.0.0` and names are not (ADR 0022 contract 7).
 *
 * @internal
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const a = address.toLowerCase();
  return a === '::1' || /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** What one POST got back: the status, the raw `content-type`, and the body (`undefined` when over the cap). */
export interface WireAnswer {
  status: number;
  contentType: string;
  text: string | undefined;
}

/** Thrown for a plain-http socket that did not connect to this machine. */
export class NotLoopback extends Error {}

/** Thrown when an answer started but its body could not be read to the end. */
export class BodyStopped extends Error {}

const noop = (): void => undefined;

/**
 * Only the public roots bundled with Node: an explicit `ca` replaces the default store, so `NODE_EXTRA_CA_CERTS`
 * (and any CA a process adds) is not used, and `rejectUnauthorized: true` overrides `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * (ADR 0024 section 6). The trust store has no entry that allows either for a host yet, so neither is honoured.
 */
const BUNDLED_CA = [...rootCertificates];

/**
 * A TCP socket to the URL's host, resolved only after the socket connected to a loopback address; any other remote
 * address is destroyed before a byte is written, so DNS rebinding cannot turn `localhost` into a public host.
 */
function loopbackSocket(url: URL, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port === '' ? 80 : url.port),
      signal,
    });
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.off('error', reject);
      if (isLoopbackAddress(sock.remoteAddress)) resolve(sock);
      else {
        sock.destroy();
        reject(
          new NotLoopback('plain http reached a host that is not this machine'),
        );
      }
    });
  });
}

/** The decoded body stream, or `undefined` for an encoding flowctl does not read. */
function decoded(res: IncomingMessage): Readable | undefined {
  const enc = (res.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (enc === 'identity') return res;
  const inflate =
    enc === 'gzip' || enc === 'x-gzip'
      ? createGunzip()
      : enc === 'deflate'
        ? createInflate()
        : enc === 'br'
          ? createBrotliDecompress()
          : undefined;
  return inflate === undefined ? undefined : pipeline(res, inflate, noop);
}

/**
 * The body as text, reading at most {@link MAX_ANSWER_BYTES} decoded bytes; `undefined` when larger (the read
 * stops there, so a compression bomb is never inflated in full). A UTF-8 BOM is dropped.
 *
 * @throws {Error} when the body stops before its end, or uses an unknown content encoding.
 */
async function readCapped(res: IncomingMessage): Promise<string | undefined> {
  const body = decoded(res);
  if (body === undefined) {
    res.destroy();
    throw new Error('the answer uses an unknown content encoding');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      res.destroy();
      body.destroy();
      return undefined;
    }
    chunks.push(buf);
  }
  if (!res.complete) throw new Error('the connection closed mid-answer');
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * One `POST` of `body` to `url`, with no proxy, no redirect and no TLS setting taken from the environment.
 *
 * @remarks `node:http`/`node:https` with a fresh agent: `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are never read.
 *   A 3xx answer is returned as it is (the caller refuses it); nothing is sent to its `location`. Plain `http:`
 *   goes only over a socket {@link isLoopbackAddress} accepted. The body of a non-2xx answer is not read.
 * @throws {NotLoopback} for plain http that connected elsewhere; {@link BodyStopped} when the answer started and its
 *   body could not be read to the end; any other error from the network or TLS before an answer.
 */
export async function postOnce(
  url: URL,
  headers: Record<string, string>,
  payload: string,
  signal: AbortSignal,
): Promise<WireAnswer> {
  const options = {
    method: 'POST',
    headers: {
      ...headers,
      'content-length': String(Buffer.byteLength(payload)),
    },
    signal,
  };
  const req =
    url.protocol === 'https:'
      ? httpsRequest(url, {
          ...options,
          agent: false,
          ca: BUNDLED_CA,
          rejectUnauthorized: true,
        })
      : await loopbackSocket(url, signal).then((sock) =>
          httpRequest(url, { ...options, createConnection: () => sock }),
        );
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', reject);
    req.end(payload);
  });
  const contentType = String(res.headers['content-type'] ?? '');
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    res.destroy();
    return { status, contentType, text: '' };
  }
  try {
    return { status, contentType, text: await readCapped(res) };
  } catch (e) {
    throw new BodyStopped(e instanceof Error ? e.message : String(e));
  }
}
