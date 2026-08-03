import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(adapters: AgentAdapter[] = [new CodexAdapter(), new ClaudeAdapter()]) {
    for (const adapter of adapters) {
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
}
