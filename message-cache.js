const TTL_MS = 5 * 60 * 1000;

const cache = new Map();

function isProcessed(messageId) {
  return cache.has(messageId);
}

function markProcessed(messageId) {
  cache.set(messageId, Date.now());
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of cache.entries()) {
    if (now - ts > TTL_MS) cache.delete(id);
  }
}, 10 * 60 * 1000).unref();

module.exports = { isProcessed, markProcessed };
