'use strict';

const { scoreRun } = require('./scoring');

/**
 * Build a full results report for a session: per-participant scores plus a
 * per-question breakdown. Used by both the JSON and CSV report endpoints.
 */
async function buildResults(store, sessionId) {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found.`);

  const quiz = await store.getQuiz(session.quizId);
  const questions = await store.listQuestions(session.quizId);
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  const runs = await store.listRuns(sessionId);

  const participants = runs.map((run) => {
    const { score, total, answered, unanswered } = scoreRun(run.answers);
    const breakdown = run.answers.map((a) => {
      const q = questionsById.get(a.questionId);
      return {
        questionId: a.questionId,
        questionText: q ? q.text : '(unknown)',
        given: a.given,
        givenText: a.given && q ? q.options[a.given] : null,
        correctAnswer: q ? q.correct : null,
        correctText: q ? q.options[q.correct] : null,
        correct: a.correct,
        status: a.status,
      };
    });
    return {
      participantId: run.participantId,
      name: run.participantName || '',
      email: run.participantEmail || '',
      status: run.status,
      error: run.error || null,
      score,
      total,
      answered,
      unanswered,
      breakdown,
    };
  });

  participants.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));

  return {
    session,
    quiz: quiz ? { id: quiz.id, title: quiz.title, questionsPerParticipant: quiz.questionsPerParticipant } : null,
    participants,
  };
}

/**
 * Aggregate a results report into session-level stats: participation, average
 * score, and per-question difficulty (correct rate, hardest first). Error runs
 * (participant unreachable) are excluded from score/question averages.
 */
function summarize(report) {
  const all = report.participants;
  const scored = all.filter((p) => p.status !== 'error');
  const totalScore = scored.reduce((s, p) => s + p.score, 0);
  const totalPossible = scored.reduce((s, p) => s + p.total, 0);

  const qmap = new Map();
  for (const p of scored) {
    for (const b of p.breakdown) {
      if (!b.questionId) continue;
      const e = qmap.get(b.questionId) || {
        questionId: b.questionId,
        questionText: b.questionText,
        asked: 0,
        correct: 0,
      };
      e.asked += 1;
      if (b.correct) e.correct += 1;
      qmap.set(b.questionId, e);
    }
  }
  const questionStats = [...qmap.values()]
    .map((e) => ({ ...e, correctRate: e.asked ? Math.round((100 * e.correct) / e.asked) : 0 }))
    .sort((a, b) => a.correctRate - b.correctRate);

  return {
    participantCount: all.length,
    completed: all.filter((p) => p.status === 'completed').length,
    errored: all.filter((p) => p.status === 'error').length,
    averageScore: scored.length ? Math.round((100 * totalScore) / scored.length) / 100 : 0,
    averagePercent: totalPossible ? Math.round((100 * totalScore) / totalPossible) : 0,
    questionStats,
  };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render a session's results as a summary CSV (one row per participant). */
function resultsToCsv(report) {
  const header = ['name', 'email', 'score', 'total', 'answered', 'unanswered', 'status'];
  const lines = [header.join(',')];
  for (const p of report.participants) {
    lines.push(
      [p.name, p.email, p.score, p.total, p.answered, p.unanswered, p.status]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildResults, summarize, resultsToCsv };
