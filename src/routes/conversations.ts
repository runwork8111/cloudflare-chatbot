import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../types";
import { chatCompletion, type ChatMessage } from "../lib/openai";

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

const sendMessageSchema = z.object({
  message: z.string().min(1).max(8000),
});

app.post("/:id/messages", zValidator("json", sendMessageSchema), async (c) => {
  const tenant = c.get("tenant");
  const conversationId = c.req.param("id");
  const { message } = c.req.valid("json");

  const conversation = await c.env.DB.prepare(
    `SELECT id FROM conversations WHERE id = ?1 AND tenant_id = ?2`
  )
    .bind(conversationId, tenant.id)
    .first();

  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  const history = await c.env.DB.prepare(
    `SELECT role, content FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC`
  )
    .bind(conversationId)
    .all<ChatMessage>();

  const chatMessages: ChatMessage[] = [
    { role: "system", content: tenant.system_prompt },
    ...history.results,
    { role: "user", content: message },
  ];

  let result;
  try {
    result = await chatCompletion(c.env, tenant.model, chatMessages);
  } catch (err) {
    console.error("OpenAI request failed", err);
    return c.json({ error: "Upstream model request failed" }, 502);
  }

  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();

  // prompt_tokens covers the full context (system + history + this message),
  // not just the new user turn — stored on the user row as the closest
  // per-turn attribution until proper usage accounting lands (Week 4).
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, tokens_input) VALUES (?1, ?2, 'user', ?3, ?4)`
    ).bind(userMessageId, conversationId, message, result.promptTokens),
    c.env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, tokens_output) VALUES (?1, ?2, 'assistant', ?3, ?4)`
    ).bind(assistantMessageId, conversationId, result.content, result.completionTokens),
    c.env.DB.prepare(`UPDATE conversations SET updated_at = unixepoch() WHERE id = ?1`).bind(
      conversationId
    ),
    c.env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, conversation_id, event_type, model, tokens_input, tokens_output)
       VALUES (?1, ?2, ?3, 'chat_completion', ?4, ?5, ?6)`
    ).bind(
      crypto.randomUUID(),
      tenant.id,
      conversationId,
      tenant.model,
      result.promptTokens,
      result.completionTokens
    ),
  ]);

  return c.json({ id: assistantMessageId, role: "assistant", content: result.content });
});

export default app;
