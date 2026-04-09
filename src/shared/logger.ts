export type LogLevel = "quiet" | "normal" | "verbose";

export interface Logger {
  level: LogLevel;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  verbose(message: string): void;
  progress(current: number, total: number, label: string): void;
}

export function createLogger(level: LogLevel = "normal"): Logger {
  const shouldLog = (requiredLevel: LogLevel): boolean => {
    if (level === "quiet") return requiredLevel === "quiet";
    if (level === "normal") return requiredLevel !== "verbose";
    return true;
  };

  return {
    level,
    info(message: string): void {
      if (shouldLog("normal")) {
        console.log(`[cypw] ${message}`);
      }
    },
    warn(message: string): void {
      if (shouldLog("normal")) {
        console.warn(`[cypw] ⚠ ${message}`);
      }
    },
    error(message: string): void {
      console.error(`[cypw] ✖ ${message}`);
    },
    verbose(message: string): void {
      if (shouldLog("verbose")) {
        console.log(`[cypw] · ${message}`);
      }
    },
    progress(current: number, total: number, label: string): void {
      if (shouldLog("normal")) {
        const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
        console.log(`[cypw] [${current}/${total}] ${percentage}% ${label}`);
      }
    }
  };
}
