import { env as rawEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isOverMonthlyBudget, startOfCurrentMonthUnixSeconds } from "./usage";
import type { Env } from "../types";

// See test/rag-pipeline.test.ts for why this cast is needed.
const env = rawEnv as unknown as Env;

let tenantId: string;

beforeEach(async () => {
  tenantId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tenants (id, slug, name, model, system_prompt) VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(tenantId, `usage-${tenantId}`, "Usage Lib Co", "gpt-4o-mini", "")
    .run();
});

describe("isOverMonthlyBudget", () => {
  it("is never over budget when monthly_budget_usd is null (unlimited)", async () => {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, event_type, model, cost_usd) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 999)`
    )
      .bind(crypto.randomUUID(), tenantId)
      .run();

    const over = await isOverMonthlyBudget(env, { id: tenantId, monthly_budget_usd: null });
    expect(over).toBe(false);
  });

  it("is false when spend is under the cap", async () => {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, event_type, model, cost_usd) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 1)`
    )
      .bind(crypto.randomUUID(), tenantId)
      .run();

    const over = await isOverMonthlyBudget(env, { id: tenantId, monthly_budget_usd: 10 });
    expect(over).toBe(false);
  });

  it("is true once spend reaches the cap", async () => {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, event_type, model, cost_usd) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 10)`
    )
      .bind(crypto.randomUUID(), tenantId)
      .run();

    const over = await isOverMonthlyBudget(env, { id: tenantId, monthly_budget_usd: 10 });
    expect(over).toBe(true);
  });

  it("ignores usage from before the start of the current month", async () => {
    const lastMonth = startOfCurrentMonthUnixSeconds() - 86400;
    await env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, event_type, model, cost_usd, created_at) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 999, ?3)`
    )
      .bind(crypto.randomUUID(), tenantId, lastMonth)
      .run();

    const over = await isOverMonthlyBudget(env, { id: tenantId, monthly_budget_usd: 10 });
    expect(over).toBe(false);
  });
});
