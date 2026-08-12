import { describe, expect, it } from "vitest";
import { redactPii } from "./pii";

describe("redactPii", () => {
  it("redacts email addresses", () => {
    expect(redactPii("contact me at jane.doe@example.com please")).toBe(
      "contact me at [redacted-email] please"
    );
  });

  it("redacts phone numbers", () => {
    expect(redactPii("call 555-123-4567 for support")).toBe("call [redacted-phone] for support");
  });

  it("redacts card-like digit sequences", () => {
    expect(redactPii("card 4111 1111 1111 1111 expired")).toBe(
      "card [redacted-number] expired"
    );
  });

  it("leaves ordinary text untouched", () => {
    const text = "Our return policy allows returns within 30 days.";
    expect(redactPii(text)).toBe(text);
  });
});
