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
type DirectoryEntries = Array<{
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

function entriesOf(directory: string): DirectoryEntries | undefined {
  try {
    return readdirSync(directory, { withFileTypes: true }) as unknown as DirectoryEntries;
  } catch {
    return undefined;
  }
}

const byName = (left: { name: string }, right: { name: string }): number =>
  left.name.localeCompare(right.name);

export function scanRepoPaths(
  root: string,
  options: { maxDepth?: number; maxFiles?: number } = {},
): string[] {
  const limits = { maxDepth: options.maxDepth ?? 4, maxFiles: options.maxFiles ?? 250 };
  const found: string[] = [];
  walkRepo({ root, limits, found }, root, 0);
  return found;
}

interface ScanState {
  root: string;
  limits: { maxDepth: number; maxFiles: number };
  found: string[];
}

function walkRepo(state: ScanState, directory: string, depth: number): void {
  if (depth > state.limits.maxDepth || state.found.length >= state.limits.maxFiles) return;
  const entries = entriesOf(directory);
  if (!entries) return;
  for (const entry of [...entries].sort(byName)) {
    if (state.found.length >= state.limits.maxFiles) return;
    visitEntry(state, directory, depth, entry);
  }
}

function visitEntry(
  state: ScanState,
  directory: string,
  depth: number,
  entry: DirectoryEntries[number],
): void {
  if (entry.name.startsWith(".") || entry.isSymbolicLink()) return;
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) {
    if (SKIP_DIRECTORIES.has(entry.name) || depth === state.limits.maxDepth) return;
    walkRepo(state, absolute, depth + 1);
    return;
  }
  if (!entry.isFile()) return;
  state.found.push(path.relative(state.root, absolute).split(path.sep).join("/"));
}
