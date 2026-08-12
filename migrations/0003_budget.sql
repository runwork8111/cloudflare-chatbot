-- NULL = unlimited (default: new tenants aren't capped until an operator
-- sets one). Enforced against the current calendar month's usage_events.
ALTER TABLE tenants ADD COLUMN monthly_budget_usd REAL;
