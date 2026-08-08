import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, type LoadedConfig } from "../config/load.js";
import { workspaceSchema, type AgentTeamWorkspace } from "./schema.js";

const workspaceNames = ["agent-team.workspace.yaml", "agent-team.workspace.yml"];

export interface LoadedWorkspaceProject {
  id: string;
  loaded: LoadedConfig;
}

export interface LoadedWorkspace {
  workspace: AgentTeamWorkspace;
  path: string;
  root: string;
  projects: LoadedWorkspaceProject[];
}

export async function findWorkspace(startDirectory: string): Promise<string | undefined> {
  let current = path.resolve(startDirectory);
  while (true) {
    for (const name of workspaceNames) {
      const candidate = path.join(current, name);
      if (await exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function loadWorkspace(
  startDirectory = process.cwd(),
  explicitPath?: string,
): Promise<LoadedWorkspace> {
  const workspacePath = explicitPath
    ? path.resolve(startDirectory, explicitPath)
    : await findWorkspace(startDirectory);
  if (!workspacePath) {
    throw new Error("No agent-team.workspace.yaml found");
  }

  const result = workspaceSchema.safeParse(parseYaml(await readFile(workspacePath, "utf8")));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "workspace"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid workspace at ${workspacePath}:\n${details}`);
  }

  const root = path.dirname(workspacePath);
  const projects = await Promise.all(
    result.data.projects.map(async (project) => ({
      id: project.id,
      loaded: await loadConfig(root, project.config),
    })),
  );
  const roots = new Map<string, string>();
  for (const project of projects) {
    const canonicalRoot = await realpath(project.loaded.root).catch(() =>
      path.resolve(project.loaded.root),
    );
    const existing = roots.get(canonicalRoot);
    if (existing) {
      throw new Error(
        `Workspace projects '${existing}' and '${project.id}' resolve to the same repository root`,
      );
    }
    roots.set(canonicalRoot, project.id);
  }

  return {
    workspace: result.data,
    path: workspacePath,
    root,
    projects,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
