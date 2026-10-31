import type { SessionEvent, SessionEventListener } from "./types.js";

export class SessionEventHub {
  private readonly listeners = new Set<SessionEventListener>();

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty observer must never break the agent turn it observes.
      }
    }
  }
}

/** Resolves once; later settle calls are ignored. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (reason: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get isSettled(): boolean {
    return this.settled;
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(value);
  }

  reject(reason: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(reason);
  }
}
