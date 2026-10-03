/**
 * Deterministic repository index. The orchestrator builds it from file paths
 * and walks it for a goal. Models receive the walked chain; they do not invent it.
 */

export interface RepoTreeNode {
  id: string;
  parentId: string | null;
  path: string;
  name: string;
  kind: "directory" | "file";
}

export interface RepoTree {
  nodes: RepoTreeNode[];
}

export interface RepoTrace {
  matched: boolean;
  nodes: RepoTreeNode[];
}

export interface ExperienceCiteSource {
  id: string;
  summary: string;
  conditions: string[];
  tags: string[];
  updatedAt: string;
}

const ROOT_ID = "root";
const LEAF_LIMIT = 8;
const NODE_LIMIT = 24;
const MAP_LIMIT = 16;
const STOP_SEGMENTS = new Set([
  "test",
  "tests",
  "docs",
  "spec",
  "e2e",
  "dist",
  "build",
  "index",
  "main",
  "core",
  "utils",
  "util",
  "types",
  "type",
  "data",
  "file",
  "src",
  "web",
  "app",
]);

export function buildRepoTree(relativePaths: string[]): RepoTree {
  const directories = new Set<string>();
  const files = new Set<string>();
  for (const raw of relativePaths) {
    const file = normalizePath(raw);
    if (!file) continue;
    files.add(file);
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }

  const used = new Set<string>([ROOT_ID]);
  const idByPath = new Map<string, string>([["", ROOT_ID]]);
  const nodes: RepoTreeNode[] = [
    { id: ROOT_ID, parentId: null, path: "", name: "root", kind: "directory" },
  ];
  const orderedDirs = [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
  for (const directory of orderedDirs) {
    const id = uniqueId(directory, used);
    idByPath.set(directory, id);
    nodes.push({
      id,
      parentId: idByPath.get(parentPath(directory)) ?? ROOT_ID,
      path: directory,
      name: baseName(directory),
      kind: "directory",
    });
  }
  for (const file of [...files].sort()) {
    nodes.push({
      id: uniqueId(file, used),
      parentId: idByPath.get(parentPath(file)) ?? ROOT_ID,
      path: file,
      name: baseName(file),
      kind: "file",
    });
  }
  return { nodes };
}

/** Walk the tree for a goal. A hit keeps the leaf and its ancestors. No hit returns the top directories. */
export function traceRepo(tree: RepoTree, query: string): RepoTrace {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const scored = tree.nodes
    .filter((node) => node.id !== ROOT_ID)
    .map((node) => ({ node, score: scoreNode(node, tokens, query.toLowerCase()) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.node.path.length - right.node.path.length || left.node.path.localeCompare(right.node.path),
    );

  if (scored.length > 0) {
    let leaves = scored.slice(0, LEAF_LIMIT).map((item) => item.node);
    let chain = withAncestors(leaves, byId);
    while (chain.length > NODE_LIMIT && leaves.length > 1) {
      leaves = leaves.slice(0, -1);
      chain = withAncestors(leaves, byId);
    }
    return { matched: true, nodes: orderRootFirst(chain) };
  }

  const map = tree.nodes
    .filter((node) => node.kind === "directory" && node.path && node.path.split("/").length <= 2)
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAP_LIMIT);
  return { matched: false, nodes: orderRootFirst(withAncestors(map, byId)) };
}

export function repoIndex(trace: RepoTrace | undefined):
  | {
      matched: boolean;
      note: string;
      nodes: Array<{ id: string; path: string; kind: RepoTreeNode["kind"] }>;
    }
  | undefined {
  if (!trace) return undefined;
  const nodes = trace.nodes
    .filter((node) => node.path)
    .map((node) => ({ id: node.id, path: node.path, kind: node.kind }));
  if (nodes.length === 0) return undefined;
  return {
    matched: trace.matched,
    note: trace.matched
      ? "These paths are the part of the repository the goal names. Prefer them when choosing element paths."
      : "The goal did not name a repository path. These are the top directories. Stay inside this tree when choosing element paths.",
    nodes,
  };
}

export function selectExperiences<T extends ExperienceCiteSource>(
  entries: T[],
  trace: RepoTrace | undefined,
  limit: number,
): Array<{ entry: T; citations: Array<{ nodeId: string; path: string }> }> {
  if (!trace?.matched || limit <= 0) return [];
  const ranked = entries
    .map((entry) => ({ entry, citations: citationsFor(entry, trace.nodes) }))
    .filter((item) => item.citations.length > 0)
    .sort(
      (left, right) =>
        right.citations.length - left.citations.length
        || right.entry.updatedAt.localeCompare(left.entry.updatedAt),
    );
  return ranked.slice(0, limit);
}

/** Deepest directory that is a prefix of every element path. Root is never assigned. */
export function deepestDirectory(tree: RepoTree, elementPaths: string[]): string | undefined {
  const targets = elementPaths.map(concretePrefix).filter((path) => path.length > 0);
  if (targets.length === 0) return undefined;
  let best: RepoTreeNode | undefined;
  for (const node of tree.nodes) {
    if (node.kind !== "directory" || !node.path) continue;
    const prefix = `${node.path}/`;
    const covers = targets.every((target) => target === node.path || target.startsWith(prefix));
    if (!covers) continue;
    if (!best || node.path.length > best.path.length) best = node;
  }
  return best?.id;
}

function citationsFor(
  entry: ExperienceCiteSource,
  nodes: RepoTreeNode[],
): Array<{ nodeId: string; path: string }> {
  const haystack = [entry.summary, ...entry.conditions, ...entry.tags].join("\n").toLowerCase();
  const tags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
  const citations: Array<{ nodeId: string; path: string }> = [];
  for (const node of nodes) {
    if (!node.path) continue;
    const path = node.path.toLowerCase();
    const pathHit = path.length >= 6 && haystack.includes(path);
    const tokenHit = mentionTokens(node).some((token) => tags.has(token) || haystack.includes(token));
    if (pathHit || tokenHit) citations.push({ nodeId: node.id, path: node.path });
  }
  return citations;
}

function mentionTokens(node: RepoTreeNode): string[] {
  const stem = node.name.replace(/\.[A-Za-z0-9]+$/, "");
  const tokens: string[] = [];
  for (const raw of [node.name, stem]) {
    const token = raw.toLowerCase();
    if (token.length < 4 || STOP_SEGMENTS.has(token) || tokens.includes(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

function scoreNode(node: RepoTreeNode, tokens: string[], query: string): number {
  if (query.includes(node.path.toLowerCase()) && node.path.length >= 3) return 8;
  const segments = node.path.toLowerCase().split("/");
  let score = 0;
  for (const token of tokens) {
    if (segments.some((segment) => segment === token || segment.replace(/\.[a-z0-9]+$/, "") === token)) {
      score += 3;
    } else if (segments.some((segment) => segment.length >= 3 && (segment.includes(token) || token.includes(segment)))) {
      score += 1;
    }
  }
  return score;
}

function withAncestors(nodes: RepoTreeNode[], byId: Map<string, RepoTreeNode>): RepoTreeNode[] {
  const keep = new Set<string>();
  for (const node of nodes) {
    let current: RepoTreeNode | undefined = node;
    while (current) {
      keep.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return [...byId.values()].filter((node) => keep.has(node.id));
}

function orderRootFirst(nodes: RepoTreeNode[]): RepoTreeNode[] {
  return [...nodes].sort(
    (left, right) =>
      left.path.split("/").filter(Boolean).length - right.path.split("/").filter(Boolean).length
      || left.path.localeCompare(right.path),
  );
}

function uniqueId(filePath: string, used: Set<string>): string {
  const base = filePath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node";
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base.slice(0, 44)}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function parentPath(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

function concretePrefix(pattern: string): string {
  const wildcard = pattern.search(/[*!?{[(]/);
  return (wildcard === -1 ? pattern : pattern.slice(0, wildcard)).replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.?\//, "");
}
