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

const CHARS_PER_TOKEN_ESTIMATE = 4;
export const DEFAULT_MAX_CONTEXT_TOKENS = 6000;

// Keeps the most recent turns that fit under a rough token budget (no
// tokenizer on the Workers runtime, so ~4 chars/token is used as a
// cautious estimate). Always keeps at least the single most recent
// message, even if it alone exceeds the budget, so a long turn never
// results in empty context.
export function trimHistory(
  history: ChatMessage[],
  maxTokens: number = DEFAULT_MAX_CONTEXT_TOKENS
): ChatMessage[] {
  const charBudget = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
  const kept: ChatMessage[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const cost = history[i].content.length;
    if (used + cost > charBudget && kept.length > 0) break;
    kept.unshift(history[i]);
    used += cost;
  }

  return kept;
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
