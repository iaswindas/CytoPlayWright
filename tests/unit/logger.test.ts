import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "../../src/shared/logger";

describe("logger", () => {
  it("creates a logger with default normal level", () => {
    const logger = createLogger();
    expect(logger.level).toBe("normal");
  });

  it("creates a logger with specified level", () => {
    const levels: LogLevel[] = ["quiet", "normal", "verbose"];
    for (const level of levels) {
      const logger = createLogger(level);
      expect(logger.level).toBe(level);
    }
  });

  it("has all expected methods", () => {
    const logger = createLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.verbose).toBe("function");
    expect(typeof logger.progress).toBe("function");
  });

  it("does not throw when logging at any level", () => {
    const levels: LogLevel[] = ["quiet", "normal", "verbose"];
    for (const level of levels) {
      const logger = createLogger(level);
      expect(() => logger.info("test")).not.toThrow();
      expect(() => logger.warn("test")).not.toThrow();
      expect(() => logger.error("test")).not.toThrow();
      expect(() => logger.verbose("test")).not.toThrow();
      expect(() => logger.progress(1, 10, "test")).not.toThrow();
    }
  });
});
