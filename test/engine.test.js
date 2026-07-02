'use strict';

const { MemoryLevel } = require('memory-level');
const { createStore } = require('../src/db/store');
const { createEngine } = require('../src/quiz/engine');
const { buildResults } = require('../src/quiz/results');

/**
 * A fake Graph client that models real Teams behaviour: every message carries a
 * server-assigned createdDateTime from a clock that is INDEPENDENT of the
 * engine's local `now` (here it lives in 2030, while tests drive `now` in 2026).
 * This is what a single-clock fake hid: the engine must not use its local clock
 * to decide which replies are new.
 */
function makeFakeGraph() {
  const sent = []; // { chatId, html }
  const chats = {}; // chatId -> [{ id, createdDateTime, text, bot }]
  let seq = 0;
  const SERVER_BASE = Date.parse('2030-01-01T00:00:00.000Z');
  const nextTs = () => new Date(SERVER_BASE + ++seq * 1000).toISOString();
  const log = (chatId) => (chats[chatId] = chats[chatId] || []);
  const addParticipantMsg = (chatId, text) =>
    log(chatId).push({ id: 'p' + seq, createdDateTime: nextTs(), text, bot: false });

  return {
    sent,
    lastHtml: () => sent[sent.length - 1] && sent[sent.length - 1].html,
    countSentTo: (chatId) => sent.filter((m) => m.chatId === chatId).length,
    // A participant reply arriving "now" on the server clock. (Extra args ignored
    // for back-compat with older call sites that passed a local timestamp.)
    enqueue(chatId, text) {
      addParticipantMsg(chatId, text);
    },
    // A message already present in the chat before the quiz starts, e.g. a reply
    // left over from a previous session in the same persistent 1:1 chat.
    seed(chatId, text) {
      addParticipantMsg(chatId, text);
    },
    async ensureOneOnOneChat(email) {
      return 'chat-' + email;
    },
    async sendMessage(chatId, html) {
      const createdDateTime = nextTs();
      const id = 'm' + seq;
      log(chatId).push({ id, createdDateTime, html, bot: true });
      sent.push({ chatId, html });
      return { id, createdDateTime };
    },
    async getMessagesSince(chatId, since) {
      return log(chatId)
        .filter((m) => !m.bot && (!since || m.createdDateTime > since))
        .map((m) => ({ id: m.id, createdDateTime: m.createdDateTime, fromUserId: 'u', text: m.text }))
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

/** Build a session with several participants. */
async function setupMulti(emails) {
  const store = createStore(new MemoryLevel());
  const graph = makeFakeGraph();
  const engine = createEngine({ store, graphClient: graph, questionTimeoutMs: TIMEOUT });
  const quiz = await store.createQuiz({
    title: 'Test',
    description: 'A short test quiz.',
    questionsPerParticipant: 3,
  });
  await store.setQuestions(quiz.id, QUESTIONS);
  await store.setParticipants(
    quiz.id,
    emails.map((e) => ({ email: e, name: e }))
  );
  return { store, graph, engine, quiz };
}

/** Reload the single run for a session. */
async function theRun(store, sessionId) {
  const runs = await store.listRuns(sessionId);
  return runs[0];
}

/** Reload a specific participant's run by email. */
async function runFor(store, sessionId, email) {
  const runs = await store.listRuns(sessionId);
  return runs.find((r) => r.participantEmail === email);
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

  test('only one running session is allowed per quiz', async () => {
    const { engine, quiz } = await setup();
    await engine.startSession(quiz.id, T0);
    await expect(engine.startSession(quiz.id, T0 + 1000)).rejects.toThrow(/already running/i);
  });

  test('an abandoned session can be replaced by a new one, and is no longer ticked', async () => {
    const { store, engine, quiz } = await setup();
    const first = await engine.startSession(quiz.id, T0);

    const abandoned = await engine.abandonSession(first.id, T0 + 500);
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.abandonedAt).toBeTruthy();

    // tick must not resurrect or complete an abandoned session
    await engine.tick(T0 + 10 * TIMEOUT);
    expect((await store.getSession(first.id)).status).toBe('abandoned');

    // a new session can now be started
    const second = await engine.startSession(quiz.id, T0 + 1000);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('running');
  });

  test('abandoning a non-running session throws', async () => {
    const { store, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);
    await engine.abandonSession(session.id, T0 + 500);
    await expect(engine.abandonSession(session.id, T0 + 600)).rejects.toThrow(/cannot be abandoned/i);
  });

  test('a completed session stores a durable snapshot + summary that survives question re-upload', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);
    let t = T0;

    // Answer all 3 correctly so the run completes.
    for (let i = 0; i < 3; i++) {
      const run = await theRun(store, session.id);
      const letter = await correctLetterFor(store, quiz.id, run);
      graph.enqueue(run.chatId, letter, t + 500);
      t += 1000;
      await engine.tick(t);
    }

    const finished = await store.getSession(session.id);
    expect(finished.status).toBe('completed');
    expect(finished.summary).toMatchObject({ participantCount: 1, completed: 1, averagePercent: 100 });

    const snap = await store.getSnapshot(session.id);
    expect(snap).toBeTruthy();
    expect(snap.participants[0].score).toBe(3);
    expect(snap.participants[0].breakdown[0].questionText).toBeTruthy();

    // Re-upload (replace) the quiz's questions — old question records are deleted.
    await store.setQuestions(quiz.id, [
      { text: 'brand new', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'A' },
    ]);

    // Snapshot still resolves the original question text (durability).
    const stillThere = await store.getSnapshot(session.id);
    expect(stillThere.participants[0].breakdown[0].questionText).not.toBe('(unknown)');
    expect(stillThere.participants[0].score).toBe(3);
  });

  test('abandoning a session also freezes a snapshot with partial results', async () => {
    const { store, graph, engine, quiz } = await setup();
    const session = await engine.startSession(quiz.id, T0);

    // Answer only the first question, then abandon.
    let run = await theRun(store, session.id);
    graph.enqueue(run.chatId, await correctLetterFor(store, quiz.id, run), T0 + 500);
    await engine.tick(T0 + 1000);

    await engine.abandonSession(session.id, T0 + 2000);
    const snap = await store.getSnapshot(session.id);
    expect(snap).toBeTruthy();
    expect(snap.session.status).toBe('abandoned');
    expect(snap.participants[0].score).toBe(1);
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

describe('multi-participant ordering (regression)', () => {
  test('one participant answering does not advance the others', async () => {
    const emails = ['a@example.com', 'b@example.com', 'c@example.com'];
    const { store, graph, engine, quiz } = await setupMulti(emails);
    const session = await engine.startSession(quiz.id, T0);

    // Each participant got exactly a welcome + question 1 (2 messages).
    for (const e of emails) expect(graph.countSentTo('chat-' + e)).toBe(2);

    // Only A answers.
    const a = await runFor(store, session.id, 'a@example.com');
    graph.enqueue(a.chatId, await correctLetterFor(store, quiz.id, a));
    await engine.tick(T0 + 1000);

    // A advanced to Q2; B and C are untouched — still on Q1, no extra messages.
    expect((await runFor(store, session.id, 'a@example.com')).currentIndex).toBe(1);
    expect(graph.countSentTo('chat-a@example.com')).toBe(3); // welcome + Q1 + Q2

    for (const e of ['b@example.com', 'c@example.com']) {
      const r = await runFor(store, session.id, e);
      expect(r.currentIndex).toBe(0);
      expect(r.answers).toHaveLength(0);
      expect(graph.countSentTo('chat-' + e)).toBe(2); // no next question sent
    }
  });

  test('a reply to one question is never reused as the answer to the next', async () => {
    // This is the core bug: with a local-clock watermark, the Q1 reply (server
    // clock, "in the future") read as newer than Q2's watermark and auto-answered
    // Q2 — sending Q3 before the participant ever answered Q2.
    const { store, graph, engine, quiz } = await setupMulti(['a@example.com']);
    const session = await engine.startSession(quiz.id, T0);

    let run = await runFor(store, session.id, 'a@example.com');
    graph.enqueue(run.chatId, await correctLetterFor(store, quiz.id, run)); // answer Q1
    await engine.tick(T0 + 1000);

    run = await runFor(store, session.id, 'a@example.com');
    expect(run.currentIndex).toBe(1); // advanced to Q2 exactly once
    expect(run.answers).toHaveLength(1);

    // No new reply for Q2. Several ticks must NOT advance past Q2.
    await engine.tick(T0 + 2000);
    await engine.tick(T0 + 3000);
    run = await runFor(store, session.id, 'a@example.com');
    expect(run.currentIndex).toBe(1);
    expect(run.answers).toHaveLength(1);
    expect(graph.countSentTo('chat-a@example.com')).toBe(3); // welcome + Q1 + Q2 only
  });

  test('pre-existing chat history (from a previous session) is ignored', async () => {
    const { store, graph, engine, quiz } = await setupMulti(['a@example.com']);

    // Leftover replies sitting in the persistent 1:1 chat before this quiz.
    graph.seed('chat-a@example.com', 'A');
    graph.seed('chat-a@example.com', 'B');

    const session = await engine.startSession(quiz.id, T0);
    await engine.tick(T0 + 1000);

    // The stale letters must not be consumed as answers to Q1.
    const run = await runFor(store, session.id, 'a@example.com');
    expect(run.currentIndex).toBe(0);
    expect(run.answers).toHaveLength(0);
    expect(run.status).toBe('awaiting');
  });
});
