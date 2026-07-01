'use strict';

const { ClassicLevel } = require('classic-level');

const { config, assertGraphConfigured } = require('./config');
const { createStore } = require('./db/store');
const { createTokenProvider } = require('./auth/graphAuth');
const { createGraphClient } = require('./graph/graphClient');
const { createEngine } = require('./quiz/engine');
const { createApp } = require('./web/server');

function main() {
  assertGraphConfigured();

  const db = new ClassicLevel(config.db.path);
  const store = createStore(db);

  const tokenProvider = createTokenProvider(config.graph);
  const graphClient = createGraphClient({ tokenProvider });

  const engine = createEngine({
    store,
    graphClient,
    questionTimeoutMs: config.engine.questionTimeoutMs,
  });

  const app = createApp({ store, engine });

  const server = app.listen(config.web.port, config.web.host, () => {
    console.log(`TeamsQuizBot admin UI: http://${config.web.host}:${config.web.port}`);
  });

  // Poll Teams for replies and advance running sessions.
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
      await engine.tick();
    } catch (err) {
      console.error(`Engine tick error: ${err.message}`);
    } finally {
      ticking = false;
    }
  }, config.engine.pollIntervalMs);

  const shutdown = () => {
    clearInterval(timer);
    server.close();
    db.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
