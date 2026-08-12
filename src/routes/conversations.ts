import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../types";
import { chatCompletion, streamChatCompletion } from "../lib/openai";
import { loadConversationHistory, persistTurn, trimHistory } from "../lib/conversation";

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

  const history = await loadConversationHistory(c.env, tenant.id, conversationId);
  if (!history) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  let result;
  try {
    result = await chatCompletion(c.env, tenant.model, [
      { role: "system", content: tenant.system_prompt },
      ...trimHistory(history),
      { role: "user", content: message },
    ]);
  } catch (err) {
    console.error("OpenAI request failed", err);
    return c.json({ error: "Upstream model request failed" }, 502);
  }

  const { assistantMessageId } = await persistTurn(
    c.env,
    tenant,
    conversationId,
    message,
    result.content,
    { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
  );

  return c.json({ id: assistantMessageId, role: "assistant", content: result.content });
});

// SSE variant: streams the assistant reply token-by-token, then persists
// the full turn once the model finishes. This is what the embeddable widget
// (Day 6) talks to.
app.post("/:id/messages/stream", zValidator("json", sendMessageSchema), async (c) => {
  const tenant = c.get("tenant");
  const conversationId = c.req.param("id");
  const { message } = c.req.valid("json");

  const history = await loadConversationHistory(c.env, tenant.id, conversationId);
  if (!history) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    let fullContent = "";
    let usage = { promptTokens: 0, completionTokens: 0 };

    try {
      for await (const event of streamChatCompletion(c.env, tenant.model, [
        { role: "system", content: tenant.system_prompt },
        ...trimHistory(history),
        { role: "user", content: message },
      ])) {
        if (event.type === "delta") {
          fullContent += event.content;
          await stream.writeSSE({ event: "delta", data: event.content });
        } else {
          usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
        }
      }
    } catch (err) {
      console.error("OpenAI stream failed", err);
      await stream.writeSSE({ event: "error", data: "Upstream model request failed" });
      return;
    }

    const { assistantMessageId } = await persistTurn(
      c.env,
      tenant,
      conversationId,
      message,
      fullContent,
      usage
    );

    await stream.writeSSE({ event: "done", data: JSON.stringify({ id: assistantMessageId }) });
  });
});

export default app;
