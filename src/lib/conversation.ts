import type { Env, Tenant } from "../types";
import type { ChatMessage } from "./openai";

// Returns stored turns for a conversation, or null if it doesn't exist (or
// belongs to a different tenant — same response either way, to avoid leaking
// which conversation IDs exist).
export async function loadConversationHistory(
  env: Env,
  tenantId: string,
  conversationId: string
): Promise<ChatMessage[] | null> {
  const conversation = await env.DB.prepare(
    `SELECT id FROM conversations WHERE id = ?1 AND tenant_id = ?2`
  )
    .bind(conversationId, tenantId)
    .first();

  if (!conversation) return null;

  const history = await env.DB.prepare(
    `SELECT role, content FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC`
  )
    .bind(conversationId)
    .all<ChatMessage>();

  return history.results;
}

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
}

export async function persistTurn(
  env: Env,
  tenant: Pick<Tenant, "id" | "model">,
  conversationId: string,
  userMessage: string,
  assistantMessage: string,
  usage: TurnUsage
): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, tokens_input) VALUES (?1, ?2, 'user', ?3, ?4)`
    ).bind(userMessageId, conversationId, userMessage, usage.promptTokens),
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, tokens_output) VALUES (?1, ?2, 'assistant', ?3, ?4)`
    ).bind(assistantMessageId, conversationId, assistantMessage, usage.completionTokens),
    env.DB.prepare(`UPDATE conversations SET updated_at = unixepoch() WHERE id = ?1`).bind(
      conversationId
    ),
    env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, conversation_id, event_type, model, tokens_input, tokens_output)
       VALUES (?1, ?2, ?3, 'chat_completion', ?4, ?5, ?6)`
    ).bind(
      crypto.randomUUID(),
      tenant.id,
      conversationId,
      tenant.model,
      usage.promptTokens,
      usage.completionTokens
    ),
  ]);

  return { userMessageId, assistantMessageId };
}
