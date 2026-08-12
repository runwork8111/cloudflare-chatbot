import type { RateLimiter } from "./durable-objects/rate-limiter";

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  OPENAI_API_KEY: string;
  ADMIN_SECRET: string;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  // Empty/unset in local dev and CI (no real Cloudflare-issued widget to
  // verify against) — verification is skipped in that case. Set as a real
  // secret in staging/production once a Turnstile widget exists.
  TURNSTILE_SECRET_KEY?: string;
  // Restricts /admin/* CORS to this origin (the deployed admin dashboard's
  // URL) once known. Falls back to "*" when unset, which is what local dev
  // and this environment (no deployed Pages URL yet) use.
  ADMIN_ALLOWED_ORIGIN?: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: string;
  model: string;
  system_prompt: string;
}

export interface Variables {
  tenant: Tenant;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
