import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GrokAdapter } from "./grok.js";
import { KimiAdapter } from "./kimi.js";
import type { AgentAdapter } from "./types.js";
import { assertAdapterContract } from "./conformance.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(
    adapters: AgentAdapter[] = [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new GrokAdapter(),
      new KimiAdapter(),
    ],
  ) {
    for (const adapter of adapters) {
      assertAdapterContract(adapter);
      if (this.adapters.has(adapter.name)) {
        throw new Error(`Duplicate agent adapter '${adapter.name}'`);
      }
      this.adapters.set(adapter.name, adapter);
    }
  }

  get(name: string): AgentAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Unknown agent adapter '${name}'`);
    }
    return adapter;
  }

  names(): string[] {
    return [...this.adapters.keys()].sort();
  }

  list(): AgentAdapter[] {
    return this.names().map((name) => this.adapters.get(name)!);
  }
}
