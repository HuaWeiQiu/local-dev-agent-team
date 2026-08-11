import type {
  AgentProfile,
  ExternalToolsPolicy,
  Permission,
  Reasoning,
} from "../config/schema.js";
import type { ProcessResult } from "../process/run.js";

export interface AgentInvocationRequest {
  cwd: string;
  prompt: string;
  promptFile?: string;
  outputSchema?: Record<string, unknown>;
  outputFile?: string;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  promptFile?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputFile?: string;
}

export interface AgentRunResult {
  text: string;
  structured?: unknown;
  process: ProcessResult;
  usage?: AgentUsage;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reportedCostUsd?: number;
}

export type ChildAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "shutdown"
  | "unknown";

export interface ChildAgentState {
  threadId: string;
  path?: string;
  status: ChildAgentStatus;
  model?: string;
  reasoning?: string;
}

export interface AgentActivitySnapshot {
  type: "child-agents";
  agents: ChildAgentState[];
}

export interface AgentActivityParser {
  push(chunk: string): AgentActivitySnapshot[];
  finish(): AgentActivitySnapshot[];
}

export interface DoctorCheck {
  profile: string;
  adapter: string;
  check: "executable" | "authentication" | "model" | "capability";
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface AdapterDoctorOptions {
  cwd: string;
  profileName: string;
  profile: AgentProfile;
  probeModel: boolean;
}

export interface AgentAdapterContract {
  version: 1;
  transport: "local-process";
  permissions: readonly Permission[];
  externalTools: readonly ExternalToolsPolicy[];
  structuredOutput: boolean;
  usage: readonly (keyof AgentUsage)[];
}

export interface AgentAdapter {
  readonly name: string;
  readonly contract: AgentAdapterContract;
  readonly supportedReasoning: readonly Reasoning[];
  readonly promptTransport?: "stdin" | "file";
  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation;
  createActivityParser?(): AgentActivityParser;
  parseResult(invocation: AgentInvocation, process: ProcessResult): Promise<AgentRunResult>;
  doctor(options: AdapterDoctorOptions): Promise<DoctorCheck[]>;
}
