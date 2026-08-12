import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../types";
import { chatCompletion, streamChatCompletion } from "../lib/openai";
import { loadConversationHistory, persistTurn, trimHistory } from "../lib/conversation";
import { verifyTurnstileToken } from "../lib/turnstile";
import { getGroundedContext } from "../lib/retrieval";
import { logger } from "../lib/logger";
import { isOverMonthlyBudget } from "../lib/usage";

const app = new Hono<AppEnv>();

const createConversationSchema = z.object({
  external_user_ref: z.string().max(255).optional(),
  turnstile_token: z.string().optional(),
});

// Creates a conversation scoped to the authenticated tenant. This is where
// bot verification happens (once per new visitor session, not per message —
// Turnstile tokens are short-lived and single-use, so they belong at the
// start of a conversation, not sprinkled across every /messages call).
app.post("/", zValidator("json", createConversationSchema), async (c) => {
  const tenant = c.get("tenant");
  const { external_user_ref, turnstile_token } = c.req.valid("json");

  if (c.env.TURNSTILE_SECRET_KEY) {
    if (!turnstile_token) {
      return c.json({ error: "Missing turnstile_token" }, 400);
    }
    const verified = await verifyTurnstileToken(
      c.env.TURNSTILE_SECRET_KEY,
      turnstile_token,
      c.req.header("CF-Connecting-IP")
    );
    if (!verified) {
      return c.json({ error: "Bot verification failed" }, 403);
    }
  }

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

  if (await isOverMonthlyBudget(c.env, tenant)) {
    return c.json({ error: "Monthly budget exceeded for this tenant" }, 402);
  }

  let result;
  let sources: string[] = [];
  try {
    const grounded = await getGroundedContext(c.env, tenant, message);
    sources = grounded.sources;
    result = await chatCompletion(c.env, tenant.model, [
      { role: "system", content: grounded.systemPrompt },
      ...trimHistory(history),
      { role: "user", content: message },
    ]);
  } catch (err) {
    // OpenAI error bodies (e.g. content-policy rejections) can echo back
    // fragments of the user's message — logger redacts before it hits
    // Workers Logs.
    logger.error(`OpenAI request failed: ${String(err)}`, { tenantId: tenant.id, conversationId });
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

  return c.json({ id: assistantMessageId, role: "assistant", content: result.content, sources });
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

  if (await isOverMonthlyBudget(c.env, tenant)) {
    return c.json({ error: "Monthly budget exceeded for this tenant" }, 402);
  }

  return streamSSE(c, async (stream) => {
    let fullContent = "";
    let usage = { promptTokens: 0, completionTokens: 0 };
    let sources: string[] = [];

    try {
      const grounded = await getGroundedContext(c.env, tenant, message);
      sources = grounded.sources;
      for await (const event of streamChatCompletion(c.env, tenant.model, [
        { role: "system", content: grounded.systemPrompt },
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
      logger.error(`OpenAI stream failed: ${String(err)}`, { tenantId: tenant.id, conversationId });
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

    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({ id: assistantMessageId, sources }),
    });
  });
});

export default app;
