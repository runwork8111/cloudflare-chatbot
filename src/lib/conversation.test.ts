import { describe, expect, it } from "vitest";
import { trimHistory } from "./conversation";
import type { ChatMessage } from "./openai";

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("trimHistory", () => {
  it("returns everything when well under budget", () => {
    const history = [msg("user", "hi"), msg("assistant", "hello")];
    expect(trimHistory(history, 1000)).toEqual(history);
  });

  it("returns an empty array for empty history", () => {
    expect(trimHistory([], 1000)).toEqual([]);
  });

  it("drops the oldest turns first once over budget", () => {
    // ~25 chars each; a 10-token (~40 char) budget should keep roughly the
    // last one or two, never the first.
    const history = [
      msg("user", "aaaaaaaaaaaaaaaaaaaaaaaaa"),
      msg("assistant", "bbbbbbbbbbbbbbbbbbbbbbbbb"),
      msg("user", "ccccccccccccccccccccccccc"),
    ];

    const trimmed = trimHistory(history, 10);

    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed[trimmed.length - 1]).toEqual(history[history.length - 1]);
    expect(trimmed).not.toContainEqual(history[0]);
  });

  it("always keeps at least the most recent message, even if it alone exceeds budget", () => {
    const hugeMessage = msg("user", "x".repeat(10_000));
    const trimmed = trimHistory([msg("assistant", "earlier"), hugeMessage], 1);

    expect(trimmed).toEqual([hugeMessage]);
  });

  it("preserves chronological order in the trimmed result", () => {
    const history = [
      msg("user", "one"),
      msg("assistant", "two"),
      msg("user", "three"),
      msg("assistant", "four"),
    ];

    const trimmed = trimHistory(history, 1000);
    expect(trimmed.map((m) => m.content)).toEqual(["one", "two", "three", "four"]);
  });
});
