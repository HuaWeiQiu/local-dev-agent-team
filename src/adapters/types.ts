import type { AgentProfile, Reasoning } from "../config/schema.js";
import type { ProcessResult } from "../process/run.js";

export interface AgentInvocationRequest {
  cwd: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  outputFile?: string;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  outputFile?: string;
}

export interface AgentRunResult {
  text: string;
  structured?: unknown;
  process: ProcessResult;
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

export interface AgentAdapter {
  readonly name: string;
  readonly supportedReasoning: readonly Reasoning[];
  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation;
  parseResult(invocation: AgentInvocation, process: ProcessResult): Promise<AgentRunResult>;
  doctor(options: AdapterDoctorOptions): Promise<DoctorCheck[]>;
}
