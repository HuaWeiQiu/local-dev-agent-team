#!/usr/bin/env node
/**
 * Deterministic quality gate backed by the ub-mode tool chain
 * (crapper / dryer / mutator — https://github.com/unclebob/ub-mode).
 *
 * Why a wrapper instead of a bare command: `quality.commands` is spawned
 * without a shell (see AGENTS.md — no shell invocation), so a gate that needs
 * `$UB` or `~` expansion has to be a program. This one resolves the tool chain,
 * runs one gate, and passes the tool's exit code through unchanged, which is
 * exactly what the orchestrator records in `finalQuality` and what the
 * evolution scorer reads.
 *
 * Exit codes (crapper's own contract):
 *   0  clean
 *   2  worst score above the threshold — treated as a failing gate
 *   1  tool, argument or project error
 *   3  this wrapper could not find the ub-mode tool chain
 *
 * Usage:
 *   node scripts/ub-quality-gate.mjs [--tool crapper|dryer|mutator]
 *                                    [--threshold 10] [--all] [--ub PATH]
 *                                    [-- <extra tool args>]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/ub-quality-gate.mjs [--tool crapper|dryer|mutator] [--threshold N] [--all] [--ub PATH] [-- extra args]`;
const TOOLS = ["crapper", "dryer", "mutator"];

export function defaultOptions(env = process.env) {
  return {
    tool: "crapper",
    threshold: "10",
    changed: true,
    ub: env.UB_BIN?.trim() || "",
    extra: [],
  };
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv, env = process.env) {
  const options = defaultOptions(env);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.extra = argv.slice(index + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--all") {
      options.changed = false;
      continue;
    }
    if (arg === "--tool" || arg === "--threshold" || arg === "--ub") {
      options[arg.slice(2)] = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${arg}'\n${USAGE}`);
  }
  if (!TOOLS.includes(options.tool)) {
    throw new Error(`--tool must be crapper, dryer or mutator (got '${options.tool}')`);
  }
  return options;
}

export function resolveUb(explicit, env = process.env) {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".kimi-code", "tools", "ub", "ub"),
    path.join(home, ".agents", "tools", "ub", "ub"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? (env.UB_BIN?.trim() || undefined);
}

export function toolArgs(options) {
  const args = [options.tool];
  if (options.tool === "crapper") {
    if (options.changed) args.push("--changed");
    args.push("--threshold", options.threshold);
  } else if (options.tool === "dryer") {
    args.push("--threshold", options.threshold);
  }
  return [...args, ...options.extra];
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const ub = resolveUb(options.ub);
  if (!ub) {
    process.stderr.write(
      "ub-mode tool chain not found. Install it (https://github.com/unclebob/ub-mode) " +
        "and pass --ub PATH or set UB_BIN.\n",
    );
    return 3;
  }

  const result = spawnSync(ub, toolArgs(options), { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`failed to run ${ub}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main());
}
