export interface PendingRunEvent {
  id: string;
  schemaVersion: 1;
  runId: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}

export interface RunEvent extends PendingRunEvent {
  sequence: number;
  traceId: string;
  spanId: string;
}

export interface RunEventSink {
  append(event: PendingRunEvent): RunEvent;
}
