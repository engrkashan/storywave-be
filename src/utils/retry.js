import { createLogger } from './logger.js';

const logger = createLogger('RetryUtil');

/**
 * Executes a function with exponential backoff and jitter.
 * Retries on 429, 500, 502, 503, 504, ECONNRESET, and network timeouts.
 */
export async function withExponentialBackoff(fn, taskName = 'Task', maxRetries = 6, baseDelayMs = 2000) {
  let attempt = 0;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      
      const isRetryable = isRetryableError(error);
      
      if (!isRetryable || attempt > maxRetries) {
        logger.error(`❌ [${taskName}] Failed after ${attempt} attempts: ${error.message}`);
        throw error;
      }

      // Exponential backoff with Full Jitter
      const tempDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitteredDelay = Math.floor(Math.random() * tempDelay);
      
      logger.warn(`⚠️ [${taskName}] Attempt ${attempt} failed (${error.message}). Retrying in ${jitteredDelay}ms...`);
      await new Promise(res => setTimeout(res, jitteredDelay));
    }
  }
}

function isRetryableError(error) {
  const msg = (error.message || '').toLowerCase();
  
  // HTTP status codes
  if (msg.includes('429') || msg.includes('too many requests')) return true;
  if (msg.includes('500') || msg.includes('internal server error')) return true;
  if (msg.includes('502') || msg.includes('bad gateway')) return true;
  if (msg.includes('503') || msg.includes('service unavailable')) return true;
  if (msg.includes('504') || msg.includes('gateway timeout')) return true;
  
  // Network errors
  if (msg.includes('econnreset') || msg.includes('socket hang up')) return true;
  if (msg.includes('timeout') || msg.includes('econnrefused')) return true;
  if (msg.includes('fetch failed')) return true;

  return false;
}
