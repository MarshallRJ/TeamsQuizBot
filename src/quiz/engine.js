'use strict';

const { pickN } = require('./randomizer');
const { normalizeAnswer } = require('./answerParser');
const { scoreRun } = require('./scoring');

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
function createEngine({ store, graphClient, questionTimeoutMs = 300000, logger = console }) {
  const nowIso = (now) => new Date(now).toISOString();

  /**
   * Open a 1:1 chat with the participant by their sign-in address. Graph resolves
   * the user during chat creation, so we need no directory-read permission; an
   * unreachable/unknown address surfaces as a chat-create error (caught by the
   * caller and recorded as an error run).
   */
  async function ensureChat(participant) {
    return graphClient.ensureOneOnOneChat(participant.email);
  }

  /** Send question at run.currentIndex; sets timing + status on the run. */
  async function sendCurrentQuestion(run, questionsById, now) {
    const total = run.questionOrder.length;
    const q = questionsById.get(run.questionOrder[run.currentIndex]);
    await graphClient.sendMessage(run.chatId, formatQuestion(q, run.currentIndex, total));
    run.currentSentAt = nowIso(now);
    run.reprompted = false;
    run.status = 'awaiting';
  }

  /** Record an answer for the current question and move to the next (or finish). */
  async function recordAndAdvance(run, questionsById, given, now) {
    const q = questionsById.get(run.questionOrder[run.currentIndex]);
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

    const participants = await store.listParticipants(quizId);
    if (!participants.length) throw new Error('Quiz has no participants uploaded.');

    const questions = await store.listQuestions(quizId);
    const questionsById = new Map(questions.map((q) => [q.id, q]));

    const session = await store.createSession(quizId);

    for (const participant of participants) {
      const questionOrder = pickN(quiz.questionIds, quiz.questionsPerParticipant);
      let run = await store.createRun({
        sessionId: session.id,
        participantId: participant.id,
        participantEmail: participant.email,
        participantName: participant.name,
        chatId: null,
        questionOrder,
        currentIndex: 0,
        status: 'pending',
        currentSentAt: null,
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
    }

    return session;
  }

  /** Process a single run: read replies, score/advance/re-prompt/time-out. */
  async function tickRun(run, questionsById, now) {
    if (run.status !== 'awaiting') return;

    const messages = await graphClient.getMessagesSince(run.chatId, run.currentSentAt);
    const validMsg = messages
      .map((m) => normalizeAnswer(m.text))
      .find((letter) => letter !== null);

    if (validMsg) {
      await recordAndAdvance(run, questionsById, validMsg, now);
      return;
    }

    const hasReply = messages.length > 0;
    const timedOut = now - Date.parse(run.currentSentAt) >= questionTimeoutMs;

    if (!run.reprompted && (hasReply || timedOut)) {
      // First strike: nudge them once and restart the wait window.
      await graphClient.sendMessage(run.chatId, REPROMPT_HTML);
      run.reprompted = true;
      run.currentSentAt = nowIso(now);
    } else if (run.reprompted && (hasReply || timedOut)) {
      // Second strike: give up on this question, mark unanswered, move on.
      await recordAndAdvance(run, questionsById, null, now);
    }
    // otherwise: still waiting, do nothing this tick
  }

  /** Advance every running session by one poll cycle. */
  async function tick(now = Date.now()) {
    const sessions = await store.listSessions();
    for (const session of sessions) {
      if (session.status !== 'running') continue;
      await tickSession(session, now);
    }
  }

  async function tickSession(session, now = Date.now()) {
    const quiz = await store.getQuiz(session.quizId);
    const questions = await store.listQuestions(session.quizId);
    const questionsById = new Map(questions.map((q) => [q.id, q]));

    const runs = await store.listRuns(session.id);
    for (const run of runs) {
      if (run.status === 'awaiting') {
        await tickRun(run, questionsById, now);
        await store.updateRun(run);
      }
    }

    const active = runs.some((r) => r.status === 'awaiting' || r.status === 'pending');
    if (!active) {
      session.status = 'completed';
      session.completedAt = nowIso(now);
      await store.updateSession(session);
    }
    return { quiz, runs };
  }

  return { startSession, tick, tickSession, tickRun, scoreRun, formatQuestion };
}

module.exports = { createEngine, formatQuestion, formatWelcome, escapeHtml };
