'use strict';

const crypto = require('crypto');

const id = () => crypto.randomUUID();

async function getOrNull(sub, key) {
  try {
    return await sub.get(key);
  } catch (err) {
    if (err && err.code === 'LEVEL_NOT_FOUND') return null;
    throw err;
  }
}

async function listByPrefix(sub, prefix) {
  const out = [];
  for await (const value of sub.values({ gte: `${prefix}:`, lt: `${prefix}:\xff` })) {
    out.push(value);
  }
  return out;
}

async function clearPrefix(sub, prefix) {
  const keys = [];
  for await (const key of sub.keys({ gte: `${prefix}:`, lt: `${prefix}:\xff` })) {
    keys.push(key);
  }
  await Promise.all(keys.map((k) => sub.del(k)));
}

/**
 * Build a store over any abstract-level database (classic-level in production,
 * memory-level in tests). All values are JSON encoded.
 *
 * Key layout:
 *   quizzes:      <quizId>
 *   questions:    <quizId>:<questionId>
 *   participants: <quizId>:<participantId>
 *   sessions:     <sessionId>
 *   runs:         <sessionId>:<runId>
 */
function createStore(db) {
  const quizzes = db.sublevel('quizzes', { valueEncoding: 'json' });
  const questions = db.sublevel('questions', { valueEncoding: 'json' });
  const participants = db.sublevel('participants', { valueEncoding: 'json' });
  const sessions = db.sublevel('sessions', { valueEncoding: 'json' });
  const runs = db.sublevel('runs', { valueEncoding: 'json' });

  return {
    db,

    // ---- Quizzes ----
    async createQuiz({ title, description, questionsPerParticipant }) {
      const quiz = {
        id: id(),
        title: String(title || '').trim() || 'Untitled quiz',
        description: String(description || '').trim(),
        questionsPerParticipant: Math.max(1, Number(questionsPerParticipant) || 1),
        questionIds: [],
        createdAt: new Date().toISOString(),
      };
      await quizzes.put(quiz.id, quiz);
      return quiz;
    },

    getQuiz(quizId) {
      return getOrNull(quizzes, quizId);
    },

    async listQuizzes() {
      const out = [];
      for await (const value of quizzes.values()) out.push(value);
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async updateQuiz(quiz) {
      await quizzes.put(quiz.id, quiz);
      return quiz;
    },

    // ---- Questions (replaces the quiz's question pool) ----
    async setQuestions(quizId, parsedQuestions) {
      const quiz = await getOrNull(quizzes, quizId);
      if (!quiz) throw new Error(`Quiz ${quizId} not found.`);

      await clearPrefix(questions, quizId);

      const questionIds = [];
      for (const q of parsedQuestions) {
        const record = {
          id: id(),
          quizId,
          text: q.text,
          options: q.options,
          correct: q.correct,
        };
        await questions.put(`${quizId}:${record.id}`, record);
        questionIds.push(record.id);
      }

      quiz.questionIds = questionIds;
      await quizzes.put(quiz.id, quiz);
      return questionIds.length;
    },

    listQuestions(quizId) {
      return listByPrefix(questions, quizId);
    },

    getQuestion(quizId, questionId) {
      return getOrNull(questions, `${quizId}:${questionId}`);
    },

    // ---- Participants (replaces the quiz's participant list) ----
    async setParticipants(quizId, parsedParticipants) {
      const quiz = await getOrNull(quizzes, quizId);
      if (!quiz) throw new Error(`Quiz ${quizId} not found.`);

      await clearPrefix(participants, quizId);

      const created = [];
      for (const p of parsedParticipants) {
        const record = {
          id: id(),
          quizId,
          email: p.email,
          name: p.name || '',
          graphUserId: null,
        };
        await participants.put(`${quizId}:${record.id}`, record);
        created.push(record);
      }
      return created;
    },

    listParticipants(quizId) {
      return listByPrefix(participants, quizId);
    },

    getParticipant(quizId, participantId) {
      return getOrNull(participants, `${quizId}:${participantId}`);
    },

    async updateParticipant(participant) {
      await participants.put(`${participant.quizId}:${participant.id}`, participant);
      return participant;
    },

    // ---- Sessions ----
    async createSession(quizId) {
      const session = {
        id: id(),
        quizId,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      await sessions.put(session.id, session);
      return session;
    },

    getSession(sessionId) {
      return getOrNull(sessions, sessionId);
    },

    async listSessions(quizId) {
      const out = [];
      for await (const value of sessions.values()) {
        if (!quizId || value.quizId === quizId) out.push(value);
      }
      return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    async updateSession(session) {
      await sessions.put(session.id, session);
      return session;
    },

    // ---- Runs (one per participant per session) ----
    async createRun(run) {
      const record = { id: id(), ...run };
      await runs.put(`${record.sessionId}:${record.id}`, record);
      return record;
    },

    listRuns(sessionId) {
      return listByPrefix(runs, sessionId);
    },

    getRun(sessionId, runId) {
      return getOrNull(runs, `${sessionId}:${runId}`);
    },

    async updateRun(run) {
      await runs.put(`${run.sessionId}:${run.id}`, run);
      return run;
    },
  };
}

module.exports = { createStore };
