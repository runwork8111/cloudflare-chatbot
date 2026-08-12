import { redactPii } from "./pii";

// Structured JSON logs — Workers Logs (enabled via observability.enabled in
// wrangler.jsonc) captures console output and makes it queryable/filterable
// by field once JSON, instead of grepping free-text strings. No external
// sink wired up (Analytics Engine / alerting need a real Cloudflare account
// to provision — see README "Observability"); this is what's usable today
// via `wrangler tail` and the dashboard's Logs view.
export interface LogFields {
  route?: string;
  tenantId?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

function log(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  const entry: Record<string, unknown> = {
    level,
    message: redactPii(message),
    time: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
