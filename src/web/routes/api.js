'use strict';

const express = require('express');
const multer = require('multer');

const { parseQuestions } = require('../../quiz/questionParser');
const { parseParticipants } = require('../../quiz/participantParser');
const { buildResults, summarize, resultsToCsv } = require('../../quiz/results');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/** Wrap an async route so rejected promises hit the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Build the /api router. `store` and `engine` are injected so the whole HTTP
 * layer can be exercised without a real Graph connection.
 */
function createApiRouter({ store, engine }) {
  const router = express.Router();

  // ---- Quizzes ----
  router.post(
    '/quizzes',
    wrap(async (req, res) => {
      const { title, description, questionsPerParticipant } = req.body || {};
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'Quiz title is required.' });
      }
      if (!description || !String(description).trim()) {
        return res.status(400).json({ error: 'Quiz description is required.' });
      }
      const quiz = await store.createQuiz({ title, description, questionsPerParticipant });
      res.status(201).json(quiz);
    })
  );

  router.get(
    '/quizzes',
    wrap(async (req, res) => {
      res.json(await store.listQuizzes());
    })
  );

  router.get(
    '/quizzes/:id',
    wrap(async (req, res) => {
      const quiz = await store.getQuiz(req.params.id);
      if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
      const participants = await store.listParticipants(quiz.id);
      const sessions = await store.listSessions(quiz.id);
      res.json({ ...quiz, questionCount: quiz.questionIds.length, participantCount: participants.length, sessions });
    })
  );

  // ---- Questions upload (CSV) ----
  router.post(
    '/quizzes/:id/questions',
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file").' });
      const questions = parseQuestions(req.file.buffer);
      const count = await store.setQuestions(req.params.id, questions);
      res.json({ count });
    })
  );

  router.get(
    '/quizzes/:id/questions',
    wrap(async (req, res) => {
      res.json(await store.listQuestions(req.params.id));
    })
  );

  // ---- Participants upload (CSV) ----
  router.post(
    '/quizzes/:id/participants',
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file").' });
      const parsed = parseParticipants(req.file.buffer);
      const created = await store.setParticipants(req.params.id, parsed);
      res.json({ count: created.length, participants: created });
    })
  );

  router.get(
    '/quizzes/:id/participants',
    wrap(async (req, res) => {
      res.json(await store.listParticipants(req.params.id));
    })
  );

  // ---- Sessions ----
  router.post(
    '/quizzes/:id/sessions',
    wrap(async (req, res) => {
      const session = await engine.startSession(req.params.id);
      res.status(201).json(session);
    })
  );

  router.post(
    '/sessions/:id/abandon',
    wrap(async (req, res) => {
      const session = await engine.abandonSession(req.params.id);
      res.json(session);
    })
  );

  router.get(
    '/sessions/:id',
    wrap(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found.' });
      const runs = await store.listRuns(session.id);
      const progress = runs.map((r) => ({
        name: r.participantName,
        email: r.participantEmail,
        status: r.status,
        answered: r.answers.length,
        total: r.questionOrder.length,
        error: r.error || null,
      }));
      res.json({ session, progress });
    })
  );

  router.get(
    '/sessions/:id/results',
    wrap(async (req, res) => {
      // A finished session serves its frozen snapshot; a running one is computed live.
      const report = (await store.getSnapshot(req.params.id)) || (await buildResults(store, req.params.id));
      report.summary = summarize(report);
      res.json(report);
    })
  );

  router.get(
    '/sessions/:id/results.csv',
    wrap(async (req, res) => {
      const report = (await store.getSnapshot(req.params.id)) || (await buildResults(store, req.params.id));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="results-${req.params.id}.csv"`);
      res.send(resultsToCsv(report));
    })
  );

  return router;
}

module.exports = { createApiRouter };
