export interface DependencyProbes {
  postgres(signal: AbortSignal): Promise<void>;
  sqs?(signal: AbortSignal): Promise<{ sqs_dlq_messages: number }>;
  backlog(signal: AbortSignal): Promise<Record<string, number>>;
}

export interface OperationalObservation {
  event: 'service_started' | 'service_stopping' | 'dependency_probe';
  dependency?: 'postgres' | 'sqs';
  outcome?: 'failure' | 'stopping';
  cause?: 'timeout' | 'unavailable';
  durationSeconds?: number;
}

export interface OperationalMetrics {
  observe(observation: OperationalObservation): void;
  snapshot(source: 'postgres' | 'sqs', values: Record<string, number> | undefined): void;
  render(): string;
}
