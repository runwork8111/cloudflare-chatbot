import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing";

describe("estimateCostUsd", () => {
  it("computes cost from known per-model pricing", () => {
    // gpt-4o-mini: $0.15/1M input, $0.60/1M output
    const cost = estimateCostUsd("gpt-4o-mini", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it("falls back to gpt-4o-mini pricing for an unknown model", () => {
    const known = estimateCostUsd("gpt-4o-mini", 500_000, 500_000);
    const unknown = estimateCostUsd("some-future-model", 500_000, 500_000);
    expect(unknown).toBe(known);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd("gpt-4o", 0, 0)).toBe(0);
  });
});
