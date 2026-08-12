import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";

describe("logger", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("emits a single JSON line with level, message, time, and extra fields", () => {
    logger.info("request", { route: "/health", status: 200 });

    expect(spy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "info", message: "request", route: "/health", status: 200 });
    expect(typeof entry.time).toBe("string");
  });

  it("redacts PII in the message text", () => {
    logger.info("failed for user jane@example.com");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.message).toBe("failed for user [redacted-email]");
  });

  it("routes error() to console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("boom");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
