/** Standard API response wrapper */
export interface ApiResponse<T> {
  data: T;
  meta?: {
    adapter?: string;
    responseTimeMs?: number;
    cached?: boolean;
  };
}

/** Standard API error response */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Health check response */
export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  adapters: Record<
    string,
    { healthy: boolean; responseTimeMs?: number }
  >;
  timestamp: string;
}
