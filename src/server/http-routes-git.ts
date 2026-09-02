import path from "node:path";
import { GitActionError, GitProjectService, type BranchListScope } from "../git/project.js";
import {
  cancelGithubConnect,
  getGithubConnectSession,
  githubHostFromRemoteUrl,
  startGithubConnect,
} from "../github/auth.js";
import {
  branchCreateRequestSchema,
  branchSyncRequestSchema,
  gitCommitRequestSchema,
  gitConnectRequestSchema,
} from "./contracts.js";
import {
  HttpError,
  type ProjectApiRoute,
  readJson,
  sendJson,
} from "./http-common.js";

export const gitRoutes: ProjectApiRoute[] = [
  {
    method: "GET",
    pattern: "/git/status",
    handler: async (context, _request, response) => {
      const service = gitService(context);
      sendJson(response, 200, await service.status());
    },
  },
  {
    method: "GET",
    pattern: "/branches",
    handler: async (context, _request, response, url) => {
      const scope = url.searchParams.get("scope") ?? "all";
      if (!["local", "remote", "all"].includes(scope)) {
        throw new HttpError(400, "scope must be one of local, remote, all", "INVALID_REQUEST");
      }
      const service = gitService(context);
      sendJson(response, 200, {
        branches: await service.branches(scope as BranchListScope),
      });
    },
  },
  {
    method: "POST",
    pattern: "/git/init",
    handler: async (context, _request, response) => {
      try {
        sendJson(response, 200, await gitService(context).initializeRepository());
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/git/initial-commit",
    handler: async (context, _request, response) => {
      try {
        sendJson(response, 200, { commit: await gitService(context).createInitialCommit() });
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/git/diff",
    handler: async (context, _request, response, url) => {
      try {
        const filePath = url.searchParams.get("path")?.trim() || undefined;
        sendJson(response, 200, await gitService(context).worktreeDiff(20_000, filePath));
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/git/changes",
    handler: async (context, _request, response) => {
      try {
        sendJson(response, 200, await gitService(context).changes());
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "GET",
    pattern: "/git/connect",
    handler: async (context, _request, response) => {
      sendJson(response, 200, getGithubConnectSession(context.loaded.root));
    },
  },
  {
    method: "POST",
    pattern: "/git/connect",
    handler: async (context, request, response) => {
      const parsed = gitConnectRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw invalidBranchRequest(parsed.error.issues.map((issue) => issue.message));
      }
      const status = await gitService(context).status();
      if (!status.ghInstalled && parsed.data.action !== "cancel") {
        throw new HttpError(
          400,
          "未安装 GitHub CLI。请先安装 gh：https://cli.github.com/",
          "GH-MISSING",
        );
      }
      const host = status.githubAccount?.host ?? githubHostFromRemoteUrl(status.remoteUrl);
      if (parsed.data.action === "cancel") {
        sendJson(response, 200, cancelGithubConnect(context.loaded.root));
        return;
      }
      sendJson(
        response,
        200,
        startGithubConnect({
          root: context.loaded.root,
          host,
          action: parsed.data.action === "refresh" ? "refresh" : "login",
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: "/git/commit",
    handler: async (context, request, response) => {
      const parsed = gitCommitRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw invalidBranchRequest(parsed.error.issues.map((issue) => issue.message));
      }
      try {
        sendJson(response, 200, await gitService(context).commitPaths(parsed.data));
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/git/push",
    handler: async (context, _request, response) => {
      try {
        sendJson(response, 200, await gitService(context).pushCurrentBranch());
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/git/stash",
    handler: async (context, _request, response) => {
      try {
        sendJson(response, 200, await gitService(context).stashWorktree());
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/branches",
    handler: async (context, request, response) => {
      const parsed = branchCreateRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw invalidBranchRequest(parsed.error.issues.map((issue) => issue.message));
      }
      try {
        sendJson(response, 200, { branch: await gitService(context).create(parsed.data) });
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/branches/cleanup-temporary",
    handler: async (context, _request, response) => {
      try {
        sendJson(response, 200, await gitService(context).deleteTemporaryBranches());
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
  {
    method: "POST",
    pattern: "/branches/sync",
    handler: async (context, request, response) => {
      const parsed = branchSyncRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw invalidBranchRequest(parsed.error.issues.map((issue) => issue.message));
      }
      try {
        sendJson(response, 200, await gitService(context).sync(parsed.data));
      } catch (error) {
        throw gitHttpError(error);
      }
    },
  },
];

function gitService(context: {
  loaded: {
    root: string;
    config: {
      project: { stateDirectory: string; defaultBranch: string };
      github: { remote: string; allowedOwners?: string[] };
    };
  };
}): GitProjectService {
  return new GitProjectService({
    root: context.loaded.root,
    worktreesRoot: path.resolve(
      context.loaded.root,
      context.loaded.config.project.stateDirectory,
      "worktrees",
    ),
    remote: context.loaded.config.github.remote,
    configDefaultBranch: context.loaded.config.project.defaultBranch,
    allowedOwners: context.loaded.config.github.allowedOwners ?? [],
  });
}

function invalidBranchRequest(messages: string[]): HttpError {
  return new HttpError(400, messages.join("; "), "INVALID_REQUEST");
}

function gitHttpError(error: unknown): HttpError {
  if (error instanceof GitActionError) {
    const status =
      error.code === "branch-exists" || error.code === "non-fast-forward" || error.code === "behind-remote"
        ? 409
        : 400;
    return new HttpError(status, error.message, error.code.toUpperCase());
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HttpError(500, message, "GIT_ACTION_FAILED");
}
