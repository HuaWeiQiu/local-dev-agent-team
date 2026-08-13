import { minimatch } from "minimatch";

const GLOB_META = /[*!?{[(]/;

/**
 * Whether a repository-relative file is inside a task's owned path.
 *
 * Globs keep minimatch semantics. A pattern without wildcards is an exact
 * file, or a directory tree when it is a prefix followed by `/`.
 */
export function pathMatchesOwnedPath(file: string, pattern: string): boolean {
  if (GLOB_META.test(pattern)) {
    return minimatch(file, pattern, { dot: true });
  }
  const prefix = pattern.replace(/\/+$/, "");
  if (!prefix) {
    return false;
  }
  return file === prefix || file.startsWith(`${prefix}/`);
}
