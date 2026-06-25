import { createLogger } from "./logger.js";

const logger = createLogger("SSE");
const clients = new Set();

/**
 * Middleware to establish an SSE connection
 */
export const sseMiddleware = (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  // Send initial ping
  res.write("data: connected\n\n");

  const client = { id: Date.now(), res };
  clients.add(client);

  logger.info(`SSE Client connected. Total clients: ${clients.size}`);

  req.on("close", () => {
    clients.delete(client);
    logger.info(`SSE Client disconnected. Total clients: ${clients.size}`);
  });
};

/**
 * Broadcast an event to all connected clients
 * @param {string} eventName 
 * @param {object} payload 
 */
export const broadcastSSE = (eventName, payload) => {
  const dataString = JSON.stringify(payload);
  const message = `event: ${eventName}\ndata: ${dataString}\n\n`;
  for (const client of clients) {
    client.res.write(message);
  }
};
