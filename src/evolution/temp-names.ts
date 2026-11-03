/**
 * The shapes of the temporary files written next to something before it is replaced.
 *
 * They live here because the **writer and the cleaner have to agree**, and they were six
 * literals in two files: two generators and two regular expressions kept in step by hand.
 * When they drift the failure is silent and slow — a crashed write leaves a temp file the
 * cleaner no longer recognises, and the disk grows debris nobody can attribute.
 *
 * Two families, deliberately different:
 *   - prompt temps are hidden (leading dot) so they never look like a prompt file, and the
 *     recovery rewrite adds `.recovery` so a cleaner can tell the two apart if it wants to;
 *   - sibling temps keep the full name of the file they replace (object store, journal) and
 *     are matched by basename.
 */
import { randomBytes } from "node:crypto";
import { escapeRegExp } from "./application-shared.js";

/** The hidden temp file an atomic prompt replace writes: `.<name>.<pid>.<hex>[.recovery].tmp`. */
export function promptTempName(basename: string, options: { recovery?: boolean } = {}): string {
  const suffix = options.recovery === true ? ".recovery" : "";
  return `.${basename}.${process.pid}.${randomBytes(8).toString("hex")}${suffix}.tmp`;
}

/** Exactly the names `promptTempName` produces, and nothing else. */
export function promptTempPattern(
  basename: string,
  options: { allowRecovery?: boolean } = {},
): RegExp {
  const suffix = options.allowRecovery === true ? "(?:\\.recovery)?" : "";
  return new RegExp(`^\\.${escapeRegExp(basename)}\\.[0-9]+\\.[a-f0-9]{16}${suffix}\\.tmp$`);
}

/** The temp file next to `absolutePath`, keeping its whole name: `<path>.<pid>.<hex>.tmp`. */
export function siblingTempName(absolutePath: string): string {
  return `${absolutePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
}

/** Exactly the names `siblingTempName` produces for `basename`, and nothing else. */
export function siblingTempPattern(basename: string): RegExp {
  return new RegExp(`^${escapeRegExp(basename)}\\.[0-9]+\\.[a-f0-9]{16}\\.tmp$`);
}
