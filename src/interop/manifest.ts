import type { AgentTeamConfig } from "../config/schema.js";
import { AdapterRegistry } from "../adapters/registry.js";

export interface InteropManifest {
  schemaVersion: 1;
  adapters: Array<{
    name: string;
    contractVersion: 1;
    transport: "local-process";
    reasoning: string[];
    permissions: string[];
    externalTools: string[];
    structuredOutput: boolean;
    usage: string[];
  }>;
  protocols: {
    mcp: {
      specification: "2026-07-28";
      mode: "profile-controlled";
      defaultPolicy: "deny";
      executionOwner: "agent-cli";
    };
    a2a: {
      specification: "1.0";
      mode: "disabled";
      requires: readonly ["authenticated-gateway", "https", "authorization"];
    };
  };
  configuredProfiles: Array<{
    name: string;
    adapter: string;
    permission: string;
    externalTools: "deny" | "inherit";
  }>;
}

export function buildInteropManifest(
  config: AgentTeamConfig,
  registry = new AdapterRegistry(),
): InteropManifest {
  return {
    schemaVersion: 1,
    adapters: registry.list().map((adapter) => ({
      name: adapter.name,
      contractVersion: adapter.contract.version,
      transport: adapter.contract.transport,
      reasoning: [...adapter.supportedReasoning],
      permissions: [...adapter.contract.permissions],
      externalTools: [...adapter.contract.externalTools],
      structuredOutput: adapter.contract.structuredOutput,
      usage: [...adapter.contract.usage],
    })),
    protocols: {
      mcp: {
        specification: "2026-07-28",
        mode: "profile-controlled",
        defaultPolicy: "deny",
        executionOwner: "agent-cli",
      },
      a2a: {
        specification: "1.0",
        mode: "disabled",
        requires: ["authenticated-gateway", "https", "authorization"],
      },
    },
    configuredProfiles: Object.entries(config.profiles)
      .map(([name, profile]) => ({
        name,
        adapter: profile.adapter,
        permission: profile.permission,
        externalTools: profile.externalTools,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}
