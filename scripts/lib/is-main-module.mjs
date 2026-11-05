/**
 * One answer to one question: is this module the process entry point?
 *
 * Compared by real path — never by URL string, never by the tail of a filename.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, and `/var` to `/private/var`.
 * So `node /tmp/gate.mjs` puts one path in `argv[1]` while `import.meta.url`
 * carries the other, and string equality answers "not the entry point": the
 * entry block is skipped, the process exits 0, and a check that ran nothing
 * reports success. That is not a hypothetical here. Five scripts in this
 * repository answered the question with `import.meta.url === pathToFileURL(
 * path.resolve(process.argv[1])).href`, and all five were silently inert when
 * run from a temporary directory — found the day the sixth was written, in the
 * one place that had asked the filesystem instead.
 *
 * 比较两个路径是否相同，先 realpath。字符串相等不是路径相等。
 *
 * The suffix form (`argv[1].endsWith("some-script.mjs")`) is immune to the
 * symlink but answers a different question — "does this path end with that
 * name" — so a copy of the file under another directory is the entry point too.
 * Correct by accident is still a form of wrong.
 *
 * A path that does not exist is not this module: it is resolved lexically and
 * compared, which cannot match, and it must not throw. `realpathSync` throws
 * ENOENT, and an exception in an entry guard would replace "did nothing" with
 * "crashed" — the same class of failure, louder.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The path with symlinks resolved when something is there, and resolved lexically
 * when nothing is. Both halves are needed: the first is the whole point, the
 * second keeps a missing file from becoming an exception.
 * @param {string} target
 */
function realpath(target) {
  const resolved = path.resolve(target);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

/**
 * Whether `moduleUrl` names the file the process was started with.
 * @param {string} moduleUrl `import.meta.url` of the module asking
 * @param {string | undefined} entry `process.argv[1]`, which is undefined in a REPL
 */
export function isMainModule(moduleUrl, entry) {
  if (!entry) return false;
  return realpath(entry) === realpath(fileURLToPath(moduleUrl));
}
