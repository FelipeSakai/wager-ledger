export interface FinancialRuntime {
  newId(): string;
  now(): Date;
  monotonicMilliseconds(): number;
  sha256(value: string): string;
  random(): number;
  sleep(milliseconds: number): Promise<void>;
}
