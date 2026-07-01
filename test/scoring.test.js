'use strict';

const { scoreRun } = require('../src/quiz/scoring');

describe('scoreRun', () => {
  test('counts correct answers and tallies answered/unanswered', () => {
    const answers = [
      { questionId: 'a', given: 'A', correct: true, status: 'answered' },
      { questionId: 'b', given: 'C', correct: false, status: 'answered' },
      { questionId: 'c', given: null, correct: false, status: 'unanswered' },
    ];
    expect(scoreRun(answers)).toEqual({ score: 1, total: 3, answered: 2, unanswered: 1 });
  });

  test('handles an empty run', () => {
    expect(scoreRun([])).toEqual({ score: 0, total: 0, answered: 0, unanswered: 0 });
  });

  test('all correct', () => {
    const answers = [
      { given: 'A', correct: true, status: 'answered' },
      { given: 'B', correct: true, status: 'answered' },
    ];
    expect(scoreRun(answers)).toEqual({ score: 2, total: 2, answered: 2, unanswered: 0 });
  });
});
