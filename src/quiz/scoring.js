'use strict';

/**
 * Score a participant run's answers.
 *
 * @param {Array<{questionId, given, correct, status}>} answers
 * @returns {{score:number, total:number, answered:number, unanswered:number}}
 */
function scoreRun(answers) {
  const total = answers.length;
  let score = 0;
  let answered = 0;
  for (const a of answers) {
    if (a.status === 'answered') answered += 1;
    if (a.correct === true) score += 1;
  }
  return { score, total, answered, unanswered: total - answered };
}

module.exports = { scoreRun };
