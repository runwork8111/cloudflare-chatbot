import { describe, expect, it } from "vitest";
import { chatCompletion, streamChatCompletion } from "./openai";
import type { Env } from "../types";

const fakeEnv = { OPENAI_API_KEY: "test-key" } as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: unknown[], status = 200): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe("chatCompletion", () => {
  it("returns content and token usage on success", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        choices: [{ message: { content: "Hello there" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });

    const result = await chatCompletion(fakeEnv, "gpt-4o-mini", [], fetchImpl);

    expect(result).toEqual({
      content: "Hello there",
      promptTokens: 12,
      completionTokens: 3,
    });
  });

  it("throws with the response body when OpenAI returns an error status", async () => {
    const fetchImpl = async () => new Response("rate limited", { status: 429 });

    await expect(chatCompletion(fakeEnv, "gpt-4o-mini", [], fetchImpl)).rejects.toThrow(/429/);
  });
});

describe("streamChatCompletion", () => {
  it("yields text deltas in order, then a final usage event", async () => {
    const fetchImpl = async () =>
      sseResponse([
        { choices: [{ delta: { role: "assistant" } }] },
        { choices: [{ delta: { content: "Hi" } }] },
        { choices: [{ delta: { content: " there" } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
      ]);

    const events = [];
    for await (const event of streamChatCompletion(fakeEnv, "gpt-4o-mini", [], fetchImpl)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "delta", content: "Hi" },
      { type: "delta", content: " there" },
      { type: "usage", promptTokens: 8, completionTokens: 2 },
    ]);
  });

  it("throws when the upstream request fails", async () => {
    const fetchImpl = async () => new Response("bad request", { status: 400 });

    const drain = async () => {
      for await (const _ of streamChatCompletion(fakeEnv, "gpt-4o-mini", [], fetchImpl)) {
        // draining the generator to trigger the throw
      }
    };

    await expect(drain()).rejects.toThrow(/400/);
  });
});
