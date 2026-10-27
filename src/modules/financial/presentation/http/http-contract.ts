export interface FinancialHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
}
export interface FinancialHttpResponse {
  status(value: number): FinancialHttpResponse;
  json(value: unknown): void;
  setHeader(name: string, value: string): void;
}
