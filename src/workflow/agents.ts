import { type RoleAgentService, ProfiledAgentService } from "../agents/service.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { type RunBudgetTracker } from "../observability/budget.js";
import { materializeRoleBindings, roleBindingsFromRunState } from "../desktop/role-bindings.js";
import type { AgentTeamConfig } from "../config/schema.js";
import type { WorkflowRoleBindings, RunnerEnv } from "./types.js";

function isRunState(value: RunState | WorkflowRoleBindings): value is RunState {
  return typeof value === "object" && value !== null && "id" in value && "profileOverrides" in value;
}

export class AgentFactory {
  constructor(
    private readonly env: RunnerEnv,
  ) {}

  createRoleAgentService(
    store: RunStateStore,
    profileOverrides: Record<string, string>,
    signal: AbortSignal | undefined,
    budget: RunBudgetTracker,
    bindingsSource?: RunState | WorkflowRoleBindings,
  ): RoleAgentService {
    if (this.env.dependencies.createAgentService) {
      return this.env.dependencies.createAgentService(store, profileOverrides, signal);
    }
    return this.profiledAgent(
      this.configWithRuntimeProfiles(bindingsSource),
      store,
      profileOverrides,
      signal,
      budget,
    );
  }

  profiledAgent(
    config: AgentTeamConfig,
    store: RunStateStore,
    profileOverrides: Record<string, string>,
    signal: AbortSignal | undefined,
    budget: RunBudgetTracker,
  ): ProfiledAgentService {
    const live = this.env.loaded.config.workflow?.sessions === "off" ? undefined : this.env.dependencies.live;
    return new ProfiledAgentService(
      config,
      this.env.loaded.root,
      store,
      profileOverrides,
      signal,
      budget,
      undefined,
      undefined,
      live,
    );
  }

  configWithRuntimeProfiles(
    bindingsSource?: RunState | WorkflowRoleBindings,
  ): AgentTeamConfig {
    const bindings = this.roleBindingsFromSource(bindingsSource);
    if (Object.keys(bindings).length === 0) {
      return this.env.loaded.config;
    }
    return materializeRoleBindings(this.env.loaded.config, bindings).config;
  }

  roleBindingsFromSource(
    bindingsSource?: RunState | WorkflowRoleBindings,
  ): WorkflowRoleBindings {
    if (!bindingsSource) return {};
    if (isRunState(bindingsSource)) {
      return roleBindingsFromRunState(bindingsSource);
    }
    return bindingsSource;
  }
}
