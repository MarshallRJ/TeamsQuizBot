'use strict';

const path = require('path');
const express = require('express');

const { createApiRouter } = require('./routes/api');

/**
 * Build the Express app. Dependencies are injected so tests can mount the app
 * with an in-memory store and a fake engine.
 */
function createApp({ store, engine, graphClient }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', createApiRouter({ store, engine, graphClient }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // JSON error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 400;
    res.status(status).json({ error: err.message || 'Unexpected error.' });
  });

  return app;
}

module.exports = { createApp };
