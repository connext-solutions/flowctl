import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Names of run directories; pruning never touches anything else in `.runs`. */
const RUN_ID = /^r_[0-9a-z]+$/;

/**
 * Removes the oldest run directories of `runsDir` beyond the newest `retention`, by modification time.
 *
 * @remarks Only real directories named like a run id ({@link RUN_ID}) are pruned; links, files and other folders a
 *   user keeps in `.runs` are left alone.
 */
export function pruneRuns(runsDir: string, retention: number): void {
  readdirSync(runsDir)
    .filter((name) => RUN_ID.test(name))
    .map((name) => ({
      path: join(runsDir, name),
      st: lstatSync(join(runsDir, name)),
    }))
    .filter((d) => d.st.isDirectory())
    .map((d) => ({ path: d.path, mtime: d.st.mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(retention)
    .forEach((d) => rmSync(d.path, { recursive: true, force: true }));
}
