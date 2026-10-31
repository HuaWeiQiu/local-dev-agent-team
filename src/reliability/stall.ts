export const DEFAULT_STALL_SECONDS = 600;
export const DEFAULT_MAX_STALL_RECOVERIES = 2;

export interface StallWatchdogOptions {
  stallMs: number;
  onStall(idleMs: number): void;
  /** While paused (a question awaits the operator, a tool is running) silence is expected. */
  isPaused?(): boolean;
}

/**
 * Fires once when no activity has been seen for `stallMs`. After firing it
 * stays quiet until `touch()` or `rearm()`, so a recovery turn gets a fresh
 * window instead of being interrupted again immediately.
 */
export class StallWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private lastActivity = Date.now();
  private stopped = true;

  constructor(private readonly options: StallWatchdogOptions) {}

  start(): void {
    this.stopped = false;
    this.touch();
  }

  touch(): void {
    if (this.stopped) return;
    this.lastActivity = Date.now();
    this.schedule(this.options.stallMs);
  }

  rearm(): void {
    this.touch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), delayMs);
    this.timer.unref?.();
  }

  private check(): void {
    if (this.stopped) return;
    const idleMs = Date.now() - this.lastActivity;
    if (idleMs < this.options.stallMs) {
      this.schedule(this.options.stallMs - idleMs);
      return;
    }
    if (this.options.isPaused?.()) {
      this.schedule(this.options.stallMs);
      return;
    }
    this.timer = undefined;
    this.options.onStall(idleMs);
  }
}
