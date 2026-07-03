'use strict';

const { pickN } = require('./randomizer');
const { normalizeAnswer } = require('./answerParser');
const { scoreRun } = require('./scoring');
const { buildResults, summarize } = require('./results');

function formatQuestion(q, index, total) {
  return (
    `<b>Question ${index + 1} of ${total}</b><br>` +
    `${escapeHtml(q.text)}<br><br>` +
    `A) ${escapeHtml(q.options.A)}<br>` +
    `B) ${escapeHtml(q.options.B)}<br>` +
    `C) ${escapeHtml(q.options.C)}<br>` +
    `D) ${escapeHtml(q.options.D)}<br><br>` +
    `<i>Reply with A, B, C or D.</i>`
  );
}

function formatWelcome(quiz, total) {
  return (
    `👋 Hi! You've been invited to take a quiz: <b>${escapeHtml(quiz.title)}</b>.<br><br>` +
    (quiz.description ? `${escapeHtml(quiz.description)}<br><br>` : '') +
    `You'll receive <b>${total}</b> multiple-choice question${total === 1 ? '' : 's'}, ` +
    `one at a time. Reply to each with a single letter — <b>A</b>, <b>B</b>, <b>C</b> or <b>D</b>.<br><br>` +
    `Here's your first question 👇`
  );
}

const REPROMPT_HTML =
  "I didn't catch that — please reply with just a single letter: <b>A</b>, <b>B</b>, <b>C</b> or <b>D</b>.";
const COMPLETE_HTML = "That's the end of the quiz. Thanks for taking part! 🎉";

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Quiz orchestration engine. All I/O is injected:
 *   - store:       the LevelDB store (createStore)
 *   - graphClient: the Teams/Graph seam (createGraphClient or a test fake)
 *
 * The engine is driven by tick(now); production wraps it in setInterval, tests
 * call it directly with scripted graphClient responses and a controlled clock.
 */
function createEngine({
  store,
  graphClient,
  questionTimeoutMs = 300000,
  concurrency = 5,
  logger = console,
}) {
  const nowIso = (now) => new Date(now).toISOString();

  // Sessions currently being started. The poll loop must not process (or worse,
  // mark complete) a session while startSession is still creating its runs.
  const startingSessions = new Set();

  /** Run fn over items with a bounded number of concurrent workers. */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  /**
   * Open a 1:1 chat with the participant by their sign-in address. Graph resolves
   * the user during chat creation, so we need no directory-read permission; an
   * unreachable/unknown address surfaces as a chat-create error (caught by the
   * caller and recorded as an error run).
   */
  async function ensureChat(participant) {
    return graphClient.ensureOneOnOneChat(participant.email);
  }

  /** Look up the run's current question, or fail loudly if it has gone missing. */
  function questionFor(run, questionsById) {
    const q = questionsById.get(run.questionOrder[run.currentIndex]);
    if (!q) {
      throw new Error(
        `Question ${run.questionOrder[run.currentIndex]} not found — the quiz's ` +
          `questions were likely changed while this session was running.`
      );
    }
    return q;
  }

  /** Send question at run.currentIndex; sets timing + status on the run. */
  async function sendCurrentQuestion(run, questionsById, now) {
    const total = run.questionOrder.length;
    const q = questionFor(run, questionsById);
    const sent = await graphClient.sendMessage(run.chatId, formatQuestion(q, run.currentIndex, total));
    // Watermark replies against Graph's clock: only messages newer than this
    // just-sent question count as answers to it. This ignores any pre-existing
    // chat history (e.g. replies from a previous session in the same 1:1 chat).
    run.seenUpTo = sent && sent.createdDateTime ? sent.createdDateTime : nowIso(now);
    run.currentSentAt = nowIso(now); // local clock, used only for the timeout
    run.reprompted = false;
    run.status = 'awaiting';
  }

  /** Record an answer for the current question and move to the next (or finish). */
  async function recordAndAdvance(run, questionsById, given, now) {
    const q = questionFor(run, questionsById);
    run.answers.push({
      questionId: q.id,
      given,
      correct: given !== null && given === q.correct,
      status: given === null ? 'unanswered' : 'answered',
    });
    run.currentIndex += 1;
    if (run.currentIndex >= run.questionOrder.length) {
      run.status = 'completed';
      try {
        await graphClient.sendMessage(run.chatId, COMPLETE_HTML);
      } catch (err) {
        logger.warn(`Could not send completion message: ${err.message}`);
      }
    } else {
      await sendCurrentQuestion(run, questionsById, now);
    }
  }

  /**
   * Start a new session for a quiz: build a random per-participant question set
   * and send everyone their first question. Participants that can't be reached
   * are recorded as 'error' runs so the rest of the quiz still proceeds.
   */
  async function startSession(quizId, now = Date.now()) {
    const quiz = await store.getQuiz(quizId);
    if (!quiz) throw new Error(`Quiz ${quizId} not found.`);
    if (!quiz.questionIds.length) throw new Error('Quiz has no questions uploaded.');

    const existing = await store.listSessions(quizId);
    if (existing.some((s) => s.status === 'running')) {
      throw new Error('A session is already running for this quiz. Abandon it before starting a new one.');
    }

    const participants = await store.listParticipants(quizId);
    if (!participants.length) throw new Error('Quiz has no participants uploaded.');

    const questions = await store.listQuestions(quizId);
    const questionsById = new Map(questions.map((q) => [q.id, q]));

    const session = await store.createSession(quizId);
    startingSessions.add(session.id); // no await between createSession and here

    try {
      await mapLimit(participants, concurrency, async (participant) => {
        const questionOrder = pickN(quiz.questionIds, quiz.questionsPerParticipant);
        const run = await store.createRun({
          sessionId: session.id,
          participantId: participant.id,
          participantEmail: participant.email,
          participantName: participant.name,
          chatId: null,
          questionOrder,
          currentIndex: 0,
          status: 'pending',
          currentSentAt: null,
          seenUpTo: null,
          reprompted: false,
          answers: [],
          error: null,
        });

        try {
          run.chatId = await ensureChat(participant);
          await graphClient.sendMessage(run.chatId, formatWelcome(quiz, run.questionOrder.length));
          await sendCurrentQuestion(run, questionsById, now);
        } catch (err) {
          run.status = 'error';
          run.error = err.message;
          logger.error(`Failed to start run for ${participant.email}: ${err.message}`);
        }
        await store.updateRun(run);
      });
    } finally {
      startingSessions.delete(session.id);
    }

    return session;
  }

  /**
   * Freeze a finished session's results into a durable snapshot and store a
   * compact summary on the session record (used for history listings). The
   * snapshot embeds question text, so results survive later question re-uploads.
   */
  async function finalizeSession(session, now) {
    session.finalizedAt = nowIso(now);
    await store.updateSession(session); // persist final status first
    const report = await buildResults(store, session.id);
    session.summary = summarize(report);
    await store.saveSnapshot(session.id, report);
    await store.updateSession(session); // persist the summary
  }

  /**
   * Abandon a running session so a fresh one can be started for the quiz. Its
   * runs are left as-is but stop being processed (tick only touches running
   * sessions), and their partial answers remain viewable in the results report.
   */
  async function abandonSession(sessionId, now = Date.now()) {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    if (session.status !== 'running') {
      throw new Error(`Session cannot be abandoned (status: ${session.status}).`);
    }
    session.status = 'abandoned';
    session.abandonedAt = nowIso(now);
    await finalizeSession(session, now);
    return session;
  }

  /**
   * Process one run against the replies already fetched for its chat this tick.
   * Handles score/advance, the single re-prompt, and timeout skip.
   */
  async function processRun(run, questionsById, now, chatMessages) {
    if (run.status !== 'awaiting') return;

    // Only messages newer than this run's current-question watermark count.
    const relevant = (chatMessages || [])
      .filter((m) => !run.seenUpTo || m.createdDateTime > run.seenUpTo)
      .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
    if (relevant.length) {
      run.seenUpTo = relevant.reduce(
        (max, m) => (m.createdDateTime > max ? m.createdDateTime : max),
        run.seenUpTo || ''
      );
    }

    const validMsg = relevant.map((m) => normalizeAnswer(m.text)).find((letter) => letter !== null);
    if (validMsg) {
      await recordAndAdvance(run, questionsById, validMsg, now);
      return;
    }

    const hasReply = relevant.length > 0;
    const timedOut = now - Date.parse(run.currentSentAt) >= questionTimeoutMs;

    if (!run.reprompted && (hasReply || timedOut)) {
      await graphClient.sendMessage(run.chatId, REPROMPT_HTML);
      run.reprompted = true;
      run.currentSentAt = nowIso(now);
    } else if (run.reprompted && (hasReply || timedOut)) {
      await recordAndAdvance(run, questionsById, null, now);
    }
    // otherwise: still waiting, do nothing this tick
  }

  /**
   * One poll cycle for ALL running sessions. Makes a SINGLE Graph call to fetch
   * new messages across every chat (not one call per participant), then routes
   * each reply to its run by chatId. The fetch watermark is the oldest
   * outstanding question across all runs — a server timestamp, so no clock skew.
   */
  async function tick(now = Date.now()) {
    const sessions = (await store.listSessions()).filter(
      (s) => s.status === 'running' && !startingSessions.has(s.id)
    );
    if (!sessions.length) return;

    const loaded = [];
    let since = null;
    for (const session of sessions) {
      const questions = await store.listQuestions(session.quizId);
      const questionsById = new Map(questions.map((q) => [q.id, q]));
      const runs = await store.listRuns(session.id);
      loaded.push({ session, questionsById, runs });
      for (const r of runs) {
        if (r.status === 'awaiting' && r.seenUpTo && (since === null || r.seenUpTo < since)) {
          since = r.seenUpTo;
        }
      }
    }

    // Single sweep across all chats, grouped by chatId for routing.
    const messagesByChat = {};
    if (since !== null) {
      for (const m of await graphClient.getAllMessagesSince(since)) {
        (messagesByChat[m.chatId] = messagesByChat[m.chatId] || []).push(m);
      }
    }

    for (const { session, questionsById, runs } of loaded) {
      try {
        const awaiting = runs.filter((r) => r.status === 'awaiting');
        await mapLimit(awaiting, concurrency, async (run) => {
          // Isolate each run: a failure (e.g. a missing question) marks just that
          // run as errored instead of aborting the tick for everyone else.
          try {
            await processRun(run, questionsById, now, messagesByChat[run.chatId]);
          } catch (err) {
            run.status = 'error';
            run.error = err.message;
            logger.error(`Run for ${run.participantEmail} failed: ${err.message}`);
          }
          await store.updateRun(run);
        });

        const active = runs.some((r) => r.status === 'awaiting' || r.status === 'pending');
        if (!active) {
          session.status = 'completed';
          session.completedAt = nowIso(now);
          await finalizeSession(session, now);
        }
      } catch (err) {
        logger.error(`Session ${session.id} tick failed: ${err.message}`);
      }
    }
  }

  return { startSession, abandonSession, tick, processRun, scoreRun, formatQuestion };
}

module.exports = { createEngine, formatQuestion, formatWelcome, escapeHtml };
