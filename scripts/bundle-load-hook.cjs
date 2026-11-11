/**
 * Preload for `check-bundle-plugins.mjs` (`node --require`, also put in `NODE_OPTIONS` so child
 * processes inherit it). Records every module resolution and load, in this thread, as JSON lines on a
 * channel the parent owns.
 *
 * @remarks Uses the synchronous `module.registerHooks`, which sees `import`, `import()`, `require`,
 * `createRequire(...)()`, `Module._load`, `data:` modules and `vm` code that reaches the default loader.
 * Events: `edge` (importer URL to resolved URL; `import.meta.resolve` alone also produces one, which the
 * parent reports as a load: over-detection), `load` (the URL actually loaded, after any hook rewrote it),
 * `hooks` (code under test registered its own module hooks) and `done` (written by the driver once every
 * import settled). `node:` builtins are not recorded. The exported `register` and `registerHooks` are
 * replaced so a call is recorded and fails the check; the call still goes through.
 *
 * Channel: the main process of a run writes to the inherited extra stdio descriptor 3, a pipe the parent
 * reads; a descendant process (its `FLOWCTL_TRACE_SEEN` is set) writes to the parent's FIFO, whose path is
 * in `FLOWCTL_TRACE_FIFO` and which is opened non-blocking write-only and verified to be a FIFO. Every
 * traced process keeps a write end of that FIFO open for its whole life, so the parent reads until no
 * writer is left: an orphan that outlives its parent is waited for, up to the timeout, then fails the run.
 * There is no log file to truncate or replace. Code under test can only append forged lines (the parent
 * parses them defensively) or close descriptors, which stops the `done` marker or the drain guarantee.
 *
 * Workers: `worker_threads.Worker` is replaced by a subclass that always adds this preload to the
 * worker's `execArgv` and, when `env` is an object, injects `FLOWCTL_TRACE_FIFO` and `FLOWCTL_TRACE_SEEN`,
 * so a Worker with `execArgv: []` and `env: {}` is still traced, and so are nested Workers. A worker in a
 * traced descendant opens its own FIFO descriptor (a worker closes it when it exits; a main thread keeps it, so exit handlers can still load modules), because fd 3 there may be an
 * IPC socket or a pipe the child made. This only raises the bar: `Object.getPrototypeOf(Worker)` and a
 * fresh `require('worker_threads')` give the original class. Not observed: a Worker built that way, a
 * child with `FLOWCTL_TRACE_SEEN` deleted and its own fd 3, a deferred load scheduled with an unref'd
 * timer or Worker after `done`, code that closes the held descriptor, and a descendant that opens the FIFO
 * read-only and drains its own lines (fd 3 lines cannot be erased, FIFO lines can).
 */
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, writeSync } = require('node:fs');
const workerThreads = require('node:worker_threads');

const { isMainThread } = workerThreads;
const KEY = Symbol.for('flowctl.bundle-load-hook');
if (globalThis[KEY] === undefined) {
  const openFifo = () => {
    const path = process.env.FLOWCTL_TRACE_FIFO;
    if (path === undefined) throw new Error('bundle-load-hook: no trace channel');
    const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFIFO()) throw new Error('bundle-load-hook: trace channel is not a FIFO');
    return fd;
  };
  const openChannel = () => {
    if (process.env.FLOWCTL_TRACE_SEEN === '1' && process.env.FLOWCTL_TRACE_FIFO !== undefined) {
      const own = openFifo();
      if (!isMainThread)
        process.on('exit', () => {
          try {
            closeSync(own);
          } catch {}
        });
      return own;
    }
    try {
      const st = fstatSync(3);
      if (st.isFIFO() || st.isSocket()) {
        if (isMainThread && process.env.FLOWCTL_TRACE_FIFO !== undefined) openFifo();
        return 3;
      }
    } catch {
      return openFifo();
    }
    return openFifo();
  };
  const fd = openChannel();
  if (isMainThread) process.env.FLOWCTL_TRACE_SEEN = '1';

  const pause = new Int32Array(new SharedArrayBuffer(4));
  const write = (event) => {
    const buf = Buffer.from(`${JSON.stringify(event)}\n`);
    let off = 0;
    while (off < buf.length) {
      try {
        off += writeSync(fd, buf, off);
      } catch (e) {
        if (e?.code !== 'EAGAIN') throw e;
        Atomics.wait(pause, 0, 0, 5);
      }
    }
  };
  /** Data URLs can be huge; a line longer than PIPE_BUF could interleave with another writer. */
  const short = (url) =>
    typeof url === 'string' && url.startsWith('data:') && url.length > 200
      ? `data:#${createHash('sha1').update(url).digest('hex')}#${url.slice(5, 60)}`
      : url;
  const builtin = (url) => typeof url === 'string' && url.startsWith('node:');

  const realRegisterHooks = Module.registerHooks;
  const realRegister = Module.register;
  realRegisterHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!builtin(result.url)) write({ t: 'edge', from: short(context.parentURL ?? null), to: short(result.url) });
      return result;
    },
    load(url, context, nextLoad) {
      if (!builtin(url)) write({ t: 'load', url: short(url) });
      return nextLoad(url, context);
    },
  });
  const guard = (api, real) =>
    function guarded(...args) {
      write({ t: 'hooks', api, from: new Error().stack?.split('\n')[2]?.trim() ?? null });
      return real.apply(this, args);
    };
  Module.registerHooks = guard('registerHooks', realRegisterHooks);
  Module.register = guard('register', realRegister);

  const RealWorker = workerThreads.Worker;
  workerThreads.Worker = class TracedWorker extends RealWorker {
    constructor(file, options = {}) {
      const fifo = process.env.FLOWCTL_TRACE_FIFO;
      const env =
        fifo !== undefined && options.env !== null && typeof options.env === 'object'
          ? { ...options.env, FLOWCTL_TRACE_FIFO: fifo, FLOWCTL_TRACE_SEEN: '1' }
          : options.env;
      super(file, { ...options, ...(env === undefined ? {} : { env }), execArgv: [...(options.execArgv ?? process.execArgv), '--require', __filename] });
    }
  };
  Object.defineProperty(globalThis, KEY, { value: { done: () => write({ t: 'done' }) } });
}
