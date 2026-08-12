import { applyD1Migrations, env } from "cloudflare:test";

// TEST_MIGRATIONS is injected via vitest.config.ts (readD1Migrations over
// migrations/); this runs once before the suite so every test starts against
// the real schema instead of an empty D1 instance.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
