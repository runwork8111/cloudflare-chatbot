import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const DEFAULT_LIMIT = 30;
const WINDOW_SECONDS = 60;

// Runs after tenantAuth (needs c.get("tenant")). One Durable Object per
// tenant enforces a fixed-window cap on /v1/* traffic — the main defense
// against a leaked/scraped widget API key being hammered, ahead of
// Turnstile (Day 10) which stops abuse at the browser instead.
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tenant = c.get("tenant");
  const id = c.env.RATE_LIMITER.idFromName(tenant.id);
  const stub = c.env.RATE_LIMITER.get(id);

  const result = await stub.check({ limit: DEFAULT_LIMIT, windowSeconds: WINDOW_SECONDS });

  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "Rate limit exceeded, please slow down" }, 429);
  }

  c.header("X-RateLimit-Remaining", String(result.remaining));
  await next();
};
