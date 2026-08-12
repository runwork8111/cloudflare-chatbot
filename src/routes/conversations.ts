import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

const createConversationSchema = z.object({
  external_user_ref: z.string().max(255).optional(),
});

// Creates a conversation scoped to the authenticated tenant. This is the
// shape the Day 4 chat-completion endpoint will build on.
app.post("/", zValidator("json", createConversationSchema), async (c) => {
  const tenant = c.get("tenant");
  const { external_user_ref } = c.req.valid("json");
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO conversations (id, tenant_id, external_user_ref) VALUES (?1, ?2, ?3)`
  )
    .bind(id, tenant.id, external_user_ref ?? null)
    .run();

  return c.json({ id, tenant_id: tenant.id, status: "open" }, 201);
});

export default app;
