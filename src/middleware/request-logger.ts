import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { logger } from "../lib/logger";

// Runs on every request; tenant is only known after tenantAuth (if this
// route has it), so it's read lazily at log time rather than passed in.
export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;

  let tenantId: string | undefined;
  try {
    tenantId = c.get("tenant")?.id;
  } catch {
    tenantId = undefined;
  }

  logger.info("request", {
    route: c.req.path,
    method: c.req.method,
    status: c.res.status,
    durationMs,
    tenantId,
  });
};
