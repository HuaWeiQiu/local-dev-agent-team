#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { createDefaultConfig } from "./config/defaults.js";
import { loadConfig } from "./config/load.js";
import { resolveProfile } from "./profiles/resolve.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { invokeAgent } from "./adapters/invoke.js";
import { runDoctor } from "./doctor.js";

const program = new Command();
program
  .name("agent-team")
  .description("Local-first orchestration for software-development agents")
  .version("0.1.0");

program
  .command("init")
  .description("Create an agent-team.yaml in a project")
  .argument("[directory]", "project directory", ".")
  .option("--force", "replace an existing configuration", false)
  .action(async (directory: string, options: { force: boolean }) => {
    const root = path.resolve(directory);
    const target = path.join(root, "agent-team.yaml");
    if (!options.force) {
      try {
        await readFile(target, "utf8");
        throw new Error(`${target} already exists; use --force to replace it`);
      } catch (error) {
        if (error instanceof Error && !error.message.includes("ENOENT")) {
          throw error;
        }
      }
    }
    const config = createDefaultConfig(path.basename(root));
    await writeFile(target, stringifyYaml(config), "utf8");
    process.stdout.write(`Created ${target}\n`);
  });

program
  .command("validate")
  .description("Validate project configuration")
  .option("-c, --config <path>", "configuration path")
  .action(async (options: { config?: string }) => {
    const loaded = await loadConfig(process.cwd(), options.config);
    process.stdout.write(`Valid: ${loaded.path}\n`);
  });

program
  .command("profiles")
  .description("List configured profiles and role defaults")
  .option("-c, --config <path>", "configuration path")
  .option("--json", "emit JSON", false)
  .action(async (options: { config?: string; json: boolean }) => {
    const loaded = await loadConfig(process.cwd(), options.config);
    const output = Object.entries(loaded.config.roles).map(([role, policy]) => ({
      role,
      defaultProfile: policy.defaultProfile,
      allowedProfiles: policy.allowedProfiles,
      fallbackProfiles: policy.fallbackProfiles,
    }));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    for (const item of output) {
      process.stdout.write(
        `${item.role.padEnd(14)} ${item.defaultProfile} [${item.allowedProfiles.join(", ")}]\n`,
      );
    }
  });

program
  .command("doctor")
  .description("Check configured agent CLIs, authentication, and capabilities")
  .option("-c, --config <path>", "configuration path")
  .option("--profile <name>", "check one profile")
  .option("--probe-models", "perform real model calls", false)
  .option("--json", "emit JSON", false)
  .action(
    async (options: {
      config?: string;
      profile?: string;
      probeModels: boolean;
      json: boolean;
    }) => {
      const loaded = await loadConfig(process.cwd(), options.config);
      const checks = await runDoctor(loaded, {
        probeModel: options.probeModels,
        ...(options.profile ? { profileName: options.profile } : {}),
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
      } else {
        for (const check of checks) {
          process.stdout.write(
            `${check.status.toUpperCase().padEnd(5)} ${check.profile}/${check.check}: ${check.detail}\n`,
          );
        }
      }
      if (checks.some((check) => check.status === "fail")) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("invoke")
  .description("Invoke one configured role for adapter verification")
  .requiredOption("--role <name>", "role to invoke")
  .requiredOption("--prompt <text>", "task prompt")
  .option("--profile <name>", "allowed profile override")
  .option("--schema <path>", "JSON Schema for structured output")
  .option("-c, --config <path>", "configuration path")
  .action(
    async (options: {
      role: string;
      prompt: string;
      profile?: string;
      schema?: string;
      config?: string;
    }) => {
      const loaded = await loadConfig(process.cwd(), options.config);
      const resolved = resolveProfile(loaded.config, options.role, options.profile);
      const outputSchema = options.schema
        ? (JSON.parse(await readFile(path.resolve(options.schema), "utf8")) as Record<string, unknown>)
        : undefined;
      const artifactDirectory = path.join(
        loaded.root,
        loaded.config.project.stateDirectory,
        "invocations",
        `${Date.now()}-${options.role}`,
      );
      const result = await invokeAgent(
        {
          adapterName: resolved.profile.adapter,
          profile: resolved.profile,
          cwd: loaded.root,
          prompt: options.prompt,
          artifactDirectory,
          ...(outputSchema ? { outputSchema } : {}),
        },
        new AdapterRegistry(),
      );
      process.stdout.write(`${result.text}\n`);
    },
  );

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
