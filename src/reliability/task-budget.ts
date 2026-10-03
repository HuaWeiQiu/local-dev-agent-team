import type {
  RoleAgentService,
  RoleInvocationOptions,
  RoleResponse,
  TextRoleInvocationOptions,
  TextRoleResponse,
} from "../agents/service.js";

export interface TaskBudgetLimits {
  maxAgentInvocations?: number | undefined;
  maxMinutes?: number | undefined;
}

export class TaskBudgetExceededError extends Error {
  override readonly name = "TaskBudgetExceededError";
  readonly code = "TASK_BUDGET_EXCEEDED";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Stops one runaway task without ending the run: the limit is checked before
 * every invocation, so a task over budget blocks itself and siblings continue.
 */
export class TaskBudgetAgent implements RoleAgentService {
  private invocations: number;
  private readonly startedAt: number;

  constructor(
    private readonly inner: RoleAgentService,
    private readonly taskId: string,
    private readonly limits: TaskBudgetLimits,
    initialInvocations = 0,
    private readonly onInvocation?: (count: number) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.invocations = initialInvocations;
    this.startedAt = now();
  }

  get count(): number {
    return this.invocations;
  }

  async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    this.charge();
    return this.inner.runStructured(options);
  }

  async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
    this.charge();
    return this.inner.runText(options);
  }

  private charge(): void {
    const { maxAgentInvocations, maxMinutes } = this.limits;
    if (maxAgentInvocations !== undefined && this.invocations >= maxAgentInvocations) {
      throw new TaskBudgetExceededError(
        `Task ${this.taskId} used its budget of ${maxAgentInvocations} agent invocation(s)`,
      );
    }
    if (maxMinutes !== undefined && this.now() - this.startedAt >= maxMinutes * 60_000) {
      throw new TaskBudgetExceededError(
        `Task ${this.taskId} exceeded its time budget of ${maxMinutes} minute(s)`,
      );
    }
    this.invocations += 1;
    this.onInvocation?.(this.invocations);
  }
}
