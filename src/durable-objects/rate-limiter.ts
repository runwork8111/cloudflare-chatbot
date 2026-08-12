import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

interface CheckRequest {
  limit: number;
  windowSeconds: number;
}

interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// One instance per rate-limit key (tenant id, or tenant+IP). DO storage is
// single-threaded per instance, so the read-increment-write below is
// atomic without any extra locking — the property that makes this correct
// where a KV-based counter (eventually consistent, no compare-and-swap)
// would let concurrent requests race past the limit.
export class RateLimiter extends DurableObject<Env> {
  async check({ limit, windowSeconds }: CheckRequest): Promise<CheckResult> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<{ count: number; windowStart: number }>("state");

    let { count, windowStart } = stored ?? { count: 0, windowStart: now };
    if (now - windowStart >= windowSeconds * 1000) {
      count = 0;
      windowStart = now;
    }

    const resetAt = windowStart + windowSeconds * 1000;
    if (count >= limit) {
      return { allowed: false, remaining: 0, resetAt };
    }

    count += 1;
    await this.ctx.storage.put("state", { count, windowStart });
    return { allowed: true, remaining: limit - count, resetAt };
  }
}
