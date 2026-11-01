/**
 * Which half of the system may do what.
 *
 * A run today is both Router and Worker: it decides whether work may start and
 * who gets it, and it also executes tasks. The article that ADR 0020 follows says
 * that split is a structural question, not a prompt question — a single session
 * that both coordinates and executes ends up doing the work itself whenever the
 * work looks small, and no prompt reliably prevents it.
 *
 * This module writes the split down as data, so "the Router must not execute" is
 * something a reviewer can read and a test can assert, rather than a convention
 * that lives in a code review.
 */

export type Layer = "router" | "worker";

/**
 * What one layer is allowed to do.
 *
 * | capability | meaning |
 * | --- | --- |
 * | `admit` | decide whether a Trigger may start work at all (the gate) |
 * | `dispatch` | bind authorized work to an executor (Ticket → Assignment) |
 * | `speak` | write to a channel the outside world reads (a comment, a message) |
 * | `plan` | turn a goal into a task graph |
 * | `execute` | run one task in a worktree |
 * | `quality` | run the deterministic gates a task must pass |
 * | `publish` | hand the integrated result to GitHub |
 */
export type Capability =
  | "admit"
  | "dispatch"
  | "speak"
  | "plan"
  | "execute"
  | "quality"
  | "publish";

/**
 * The surface each layer holds. Read a row as "everything this layer does".
 *
 * The Router coordinates and talks; it never touches a worktree. The Worker
 * executes and reports; it never decides that work is allowed, and it never
 * speaks to a person — what it has to say goes back as a Report.
 */
const SURFACES: Record<Layer, ReadonlySet<Capability>> = {
  router: new Set<Capability>(["admit", "dispatch", "speak"]),
  worker: new Set<Capability>(["plan", "execute", "quality", "publish"]),
};

export class LayerError extends Error {
  constructor(
    readonly layer: Layer,
    readonly capability: Capability,
  ) {
    super(`The ${layer} layer must not ${capability}`);
    this.name = "LayerError";
  }
}

export function can(layer: Layer, capability: Capability): boolean {
  return SURFACES[layer].has(capability);
}

/** Everything this layer may do, in a stable order for tests and docs. */
export function surfaceOf(layer: Layer): Capability[] {
  const order: Capability[] = ["admit", "dispatch", "speak", "plan", "execute", "quality", "publish"];
  return order.filter((capability) => SURFACES[layer].has(capability));
}

/**
 * Refuse a capability the layer does not hold. Call this at the seam where a
 * layer reaches for something, so a wrong wiring fails loudly at that line
 * instead of quietly working until someone reads the code.
 */
export function assertCapability(layer: Layer, capability: Capability): void {
  if (can(layer, capability)) return;
  throw new LayerError(layer, capability);
}

/** The two layers never overlap: a capability belongs to exactly one of them. */
export function sharedCapabilities(): Capability[] {
  const order: Capability[] = ["admit", "dispatch", "speak", "plan", "execute", "quality", "publish"];
  return order.filter((capability) => can("router", capability) && can("worker", capability));
}
