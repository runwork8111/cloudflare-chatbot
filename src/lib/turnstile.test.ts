import { describe, expect, it } from "vitest";
import { verifyTurnstileToken } from "./turnstile";

describe("verifyTurnstileToken", () => {
  it("returns true when Cloudflare reports success", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
    await expect(verifyTurnstileToken("secret", "token", undefined, fetchImpl)).resolves.toBe(true);
  });

  it("returns false when Cloudflare reports failure", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
        status: 200,
      });
    await expect(verifyTurnstileToken("secret", "bad-token", undefined, fetchImpl)).resolves.toBe(
      false
    );
  });

  it("returns false when the siteverify request itself fails", async () => {
    const fetchImpl = async () => new Response("error", { status: 500 });
    await expect(verifyTurnstileToken("secret", "token", undefined, fetchImpl)).resolves.toBe(false);
  });
});
