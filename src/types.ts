import type { RateLimiter } from "./durable-objects/rate-limiter";

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  OPENAI_API_KEY: string;
  ADMIN_SECRET: string;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
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
