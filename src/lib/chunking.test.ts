import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking";

describe("chunkText", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("packs short paragraphs into a single chunk", () => {
    const chunks = chunkText("First paragraph.\n\nSecond paragraph.", 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("First paragraph.");
    expect(chunks[0]).toContain("Second paragraph.");
  });

  it("splits into multiple chunks once the budget is exceeded", () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph ${i}: `.padEnd(150, "x"));
    const text = paragraphs.join("\n\n");

    const chunks = chunkText(text, 300, 20);

    expect(chunks.length).toBeGreaterThan(1);
    // every paragraph shows up somewhere across the chunks
    for (let i = 0; i < 5; i++) {
      expect(chunks.some((c) => c.includes(`Paragraph ${i}:`))).toBe(true);
    }
  });

  it("carries a small overlap into the next chunk", () => {
    const paragraphs = Array.from({ length: 4 }, (_, i) => `Paragraph ${i}: `.padEnd(150, "x"));
    const chunks = chunkText(paragraphs.join("\n\n"), 300, 50);

    expect(chunks.length).toBeGreaterThan(1);
    // the tail of chunk N should reappear at the head of chunk N+1
    const tailOfFirst = chunks[0].slice(-30);
    expect(chunks[1]).toContain(tailOfFirst.trim().slice(0, 20));
  });

  it("hard-splits a single paragraph longer than maxChars", () => {
    const hugeParagraph = "x".repeat(5000);
    const chunks = chunkText(hugeParagraph, 1000, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  it("never produces an empty chunk", () => {
    const chunks = chunkText("a\n\n\n\nb\n\n   \n\nc", 5);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });
});
