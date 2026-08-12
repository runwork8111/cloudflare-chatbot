import type { Env, Tenant } from "../types";

export interface UsageSummary {
  requestCount: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
}

export interface DailyUsage extends UsageSummary {
  date: string;
}

export async function getTenantUsageSummary(
  env: Env,
  tenantId: string,
  sinceUnixSeconds: number
): Promise<UsageSummary> {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS requestCount,
       COALESCE(SUM(tokens_input), 0) AS tokensInput,
       COALESCE(SUM(tokens_output), 0) AS tokensOutput,
       COALESCE(SUM(cost_usd), 0) AS costUsd
     FROM usage_events
     WHERE tenant_id = ?1 AND created_at >= ?2`
  )
    .bind(tenantId, sinceUnixSeconds)
    .first<UsageSummary>();

  return row ?? { requestCount: 0, tokensInput: 0, tokensOutput: 0, costUsd: 0 };
}

export async function getTenantUsageByDay(
  env: Env,
  tenantId: string,
  sinceUnixSeconds: number
): Promise<DailyUsage[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       date(created_at, 'unixepoch') AS date,
       COUNT(*) AS requestCount,
       COALESCE(SUM(tokens_input), 0) AS tokensInput,
       COALESCE(SUM(tokens_output), 0) AS tokensOutput,
       COALESCE(SUM(cost_usd), 0) AS costUsd
     FROM usage_events
     WHERE tenant_id = ?1 AND created_at >= ?2
     GROUP BY date
     ORDER BY date DESC`
  )
    .bind(tenantId, sinceUnixSeconds)
    .all<DailyUsage>();

  return results;
}

export function startOfCurrentMonthUnixSeconds(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

// Enforced against the calendar month to date, not a rolling 30 days —
// simpler to reason about for both the tenant and whoever's reading the
// dashboard ("this month's spend"), and resets predictably.
export async function isOverMonthlyBudget(
  env: Env,
  tenant: Pick<Tenant, "id" | "monthly_budget_usd">
): Promise<boolean> {
  if (tenant.monthly_budget_usd == null) return false;

  const summary = await getTenantUsageSummary(env, tenant.id, startOfCurrentMonthUnixSeconds());
  return summary.costUsd >= tenant.monthly_budget_usd;
}
