'use strict';

require('dotenv').config();

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  graph: {
    tenantId: process.env.GRAPH_TENANT_ID || '',
    clientId: process.env.GRAPH_CLIENT_ID || '',
    clientSecret: process.env.GRAPH_CLIENT_SECRET || '',
    username: process.env.GRAPH_USERNAME || '',
    password: process.env.GRAPH_PASSWORD || '',
    scopes: ['https://graph.microsoft.com/.default'],
  },
  web: {
    port: num(process.env.PORT, 3000),
    host: process.env.HOST || '127.0.0.1',
  },
  db: {
    path: process.env.DB_PATH || './data',
  },
  engine: {
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 5000),
    questionTimeoutMs: num(process.env.QUESTION_TIMEOUT_MS, 300000),
    // Max concurrent Graph calls when sending questions / polling replies.
    concurrency: num(process.env.ENGINE_CONCURRENCY, 5),
  },
};

/**
 * Throws if required Graph credentials are missing. Called lazily at startup so
 * that unit tests (which never touch real Graph) can require modules freely.
 */
function assertGraphConfigured() {
  const missing = ['tenantId', 'clientId', 'username', 'password'].filter(
    (k) => !config.graph[k]
  );
  if (missing.length) {
    throw new Error(
      `Missing Graph configuration: ${missing
        .map((k) => `GRAPH_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`)
        .join(', ')}. Copy .env.example to .env and fill it in.`
    );
  }
}

module.exports = { config, assertGraphConfigured };
