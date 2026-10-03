import { readdirSync } from "node:fs";
import path from "node:path";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  "out",
  "build",
]);

/**
 * Bounded path list for the repository index. Contents are never read.
 * Dot entries and dependency/build directories are skipped, and symlinks are not followed.
 */
export function scanRepoPaths(
  root: string,
  options: { maxDepth?: number; maxFiles?: number } = {},
): string[] {
  const maxDepth = options.maxDepth ?? 4;
  const maxFiles = options.maxFiles ?? 250;
  const found: string[] = [];

  const walk = (directory: string, depth: number): void => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || depth === maxDepth) continue;
        walk(absolute, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        found.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };

  walk(root, 0);
  return found;
}
