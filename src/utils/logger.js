import { AsyncLocalStorage } from "async_hooks";

/**
 * Shared storage for workflow context (e.g., title)
 */
export const loggingStorage = new AsyncLocalStorage();

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: "\x1b[0m",
  timestamp: "\x1b[90m", // Gray
  tag: "\x1b[35m",       // Magenta
  ctx: "\x1b[33m",       // Yellow
  info: "\x1b[36m",      // Cyan
  warn: "\x1b[33m",      // Yellow
  error: "\x1b[31m",     // Red
  success: "\x1b[32m",   // Green
};

/**
 * Formats the timestamp for logs
 */
const getTimestamp = () => {
  return new Date().toISOString().replace("T", " ").split(".")[0];
};

/**
 * Creates a logger for a specific component/tag
 * @param {string} tag - The component name (e.g., "ImageService")
 */
export const createLogger = (tag) => {
  const log = (level, color, msg, ...args) => {
    const context = loggingStorage.getStore() || {};
    const { title } = context;
    
    // Get first 3 words of the title if it exists
    const shortTitle = title ? title.split(/\s+/).slice(0, 3).join(" ") : "";
    
    const timeStr = `${colors.timestamp}[${getTimestamp()}]${colors.reset}`;
    const tagStr = `${colors.tag}[${tag}${shortTitle ? ` | ${shortTitle}` : ""}]${colors.reset}`;
    
    const prefix = `${timeStr} ${tagStr} ${color}${msg}${colors.reset}`;
    
    // Use console.error for actual errors, console.log for others
    if (level === "ERROR") {
      console.error(prefix, ...args);
    } else {
      console.log(prefix, ...args);
    }
  };

  return {
    info: (msg, ...args) => log("INFO", colors.info, msg, ...args),
    warn: (msg, ...args) => log("WARN", colors.warn, `⚠️ ${msg}`, ...args),
    error: (msg, ...args) => log("ERROR", colors.error, `❌ ${msg}`, ...args),
    success: (msg, ...args) => log("SUCCESS", colors.success, `✅ ${msg}`, ...args),
  };
};
