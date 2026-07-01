'use strict';

const { MemoryLevel } = require('memory-level');
const { createStore } = require('../src/db/store');
const { createEngine } = require('../src/quiz/engine');
const { buildResults } = require('../src/quiz/results');

/** A fake Graph client: records outgoing messages, serves scripted replies. */
function makeFakeGraph() {
  const sent = []; // { chatId, html }
  const inbox = {}; // chatId -> [{ createdDateTime, text }]
  return {
    sent,
    lastHtml: () => sent[sent.length - 1] && sent[sent.length - 1].html,
    enqueue(chatId, text, whenMs) {
      (inbox[chatId] = inbox[chatId] || []).push({
        createdDateTime: new Date(whenMs).toISOString(),
        text,
      });
    },
    async ensureOneOnOneChat(email) {
      return 'chat-' + email;
    },
    async sendMessage(chatId, html) {
      sent.push({ chatId, html });
      return 'm' + sent.length;
    },
    async getMessagesSince(chatId, since) {
      return (inbox[chatId] || [])
        .filter((m) => !since || m.createdDateTime > since)
        .map((m, i) => ({ id: 'in' + i, createdDateTime: m.createdDateTime, fromUserId: 'u', text: m.text }))
        .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
    },
  };
}

const QUESTIONS = [
  { text: 'Q1', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'A' },
  { text: 'Q2', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'B' },
  { text: 'Q3', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'C' },
];

const T0 = Date.parse('2026-07-01T10:00:00.000Z');
const TIMEOUT = 60_000;

async function setup() {
  const store = createStore(new MemoryLevel());
  const graph = makeFakeGraph();
  const engine = createEngine({ store, graphClient: graph, questionTimeoutMs: TIMEOUT });

  // questionsPerParticipant === pool size so the run contains all 3 (shuffled).
  const quiz = await store.createQuiz({
    title: 'Test',
    description: 'A short test quiz.',
    questionsPerParticipant: 3,
  });
  await store.setQuestions(quiz.id, QUESTIONS);
  await store.setParticipants(quiz.id, [{ email: 'alice@example.com', name: 'Alice' }]);

  return { store, graph, engine, quiz };
}

/** Reload the single run for a session. */
async function theRun(store, sessionId) {
  const runs = await store.listRuns(sessionId);
  return runs[0];
}

/** Correct letter for the run's current question. */
async function correctLetterFor(store, quizId, run) {
  const q = await store.getQuestion(quizId, run.questionOrder[run.currentIndex]);
  return q.correct;
}

describe('engine end-to-end (Graph mocked)', () => {
  test('startSession sends a welcome message then question 1 to every participant', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);

    expect(graph.sent).toHaveLength(2);
    expect(graph.sent[0].html).toMatch(/invited to take a quiz/i);
    expect(graph.sent[0].html).toContain('A short test quiz.');
    expect(graph.sent[1].html).toMatch(/Question 1 of 3/);

    const run = await theRun(store, session.id);
    expect(run.status).toBe('awaiting');
    expect(run.chatId).toBe('chat-alice@example.com');
    expect(run.questionOrder).toHaveLength(3);
  });

  test('a correct reply is scored and advances to the next question', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);
    let run = await theRun(store, session.id);

    const letter = await correctLetterFor(store, quiz.id, run);
    graph.enqueue(run.chatId, letter, T0 + 1000);
    await engine.tick(T0 + 2000);

    run = await theRun(store, session.id);
    expect(run.currentIndex).toBe(1);
    expect(run.answers).toHaveLength(1);
    expect(run.answers[0]).toMatchObject({ given: letter, correct: true, status: 'answered' });
    expect(graph.lastHtml()).toMatch(/Question 2 of 3/);
  });

  test('an invalid reply triggers a single re-prompt, then accepts a valid one', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);
    let run = await theRun(store, session.id);

    graph.enqueue(run.chatId, 'no idea', T0 + 1000);
    await engine.tick(T0 + 2000);

    run = await theRun(store, session.id);
    expect(run.reprompted).toBe(true);
    expect(run.answers).toHaveLength(0); // not recorded yet
    expect(graph.lastHtml()).toMatch(/didn't catch that/i);

    // now reply correctly after the re-prompt
    const letter = await correctLetterFor(store, quiz.id, run);
    graph.enqueue(run.chatId, letter, T0 + 3000);
    await engine.tick(T0 + 4000);

    run = await theRun(store, session.id);
    expect(run.currentIndex).toBe(1);
    expect(run.answers[0]).toMatchObject({ correct: true });
  });

  test('no answer times out: re-prompt then skip as unanswered', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);
    let run = await theRun(store, session.id);

    // First timeout -> re-prompt (no reply enqueued)
    await engine.tick(T0 + TIMEOUT + 1000);
    run = await theRun(store, session.id);
    expect(run.reprompted).toBe(true);
    expect(run.answers).toHaveLength(0);

    // Second timeout after the re-prompt -> skip, mark unanswered, advance
    const sentAt = Date.parse(run.currentSentAt);
    await engine.tick(sentAt + TIMEOUT + 1000);
    run = await theRun(store, session.id);
    expect(run.currentIndex).toBe(1);
    expect(run.answers[0]).toMatchObject({ given: null, status: 'unanswered', correct: false });
  });

  test('full run completes the session and scores correctly', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);
    let t = T0;

    // Answer Q1 and Q2 correctly, let Q3 time out (re-prompt then skip).
    for (let i = 0; i < 2; i++) {
      let run = await theRun(store, session.id);
      const letter = await correctLetterFor(store, quiz.id, run);
      graph.enqueue(run.chatId, letter, t + 500);
      t += 1000;
      await engine.tick(t);
    }

    // Q3: two timeouts
    let run = await theRun(store, session.id);
    t = Date.parse(run.currentSentAt) + TIMEOUT + 1000;
    await engine.tick(t); // re-prompt
    run = await theRun(store, session.id);
    t = Date.parse(run.currentSentAt) + TIMEOUT + 1000;
    await engine.tick(t); // skip -> completes run

    const reloaded = await store.getSession(session.id);
    expect(reloaded.status).toBe('completed');
    expect(reloaded.completedAt).toBeTruthy();

    const report = await buildResults(store, session.id);
    const alice = report.participants[0];
    expect(alice.total).toBe(3);
    expect(alice.answered).toBe(2);
    expect(alice.unanswered).toBe(1);
    expect(alice.score).toBe(2);
    expect(alice.status).toBe('completed');
  });

  test('a participant that cannot be reached is marked as an error run', async () => {
    const { store, engine, quiz } = await setup();
    const graphMissing = {
      async ensureOneOnOneChat() {
        throw new Error('Graph POST /chats failed: 404 user not found');
      },
      async sendMessage() {},
      async getMessagesSince() {
        return [];
      },
    };
    const silentLogger = { warn() {}, error() {}, log() {} };
    const eng = createEngine({
      store,
      graphClient: graphMissing,
      questionTimeoutMs: TIMEOUT,
      logger: silentLogger,
    });
    const session = await eng.startSession(quiz.id, T0);

    const run = await theRun(store, session.id);
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/not found/i);

    // session should complete immediately since no runs are active
    await eng.tick(T0 + 1000);
    expect((await store.getSession(session.id)).status).toBe('completed');
  });
});
