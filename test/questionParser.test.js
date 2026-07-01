'use strict';

const { parseQuestions } = require('../src/quiz/questionParser');

const VALID = `text,A,B,C,D,correct
What is 2+2?,3,4,5,6,B
Capital of France?,Paris,London,Rome,Berlin,A
`;

describe('parseQuestions', () => {
  test('parses valid rows into question objects', () => {
    const q = parseQuestions(VALID);
    expect(q).toHaveLength(2);
    expect(q[0]).toEqual({
      text: 'What is 2+2?',
      options: { A: '3', B: '4', C: '5', D: '6' },
      correct: 'B',
    });
    expect(q[1].correct).toBe('A');
  });

  test('is case-insensitive on the header and the correct letter', () => {
    const csv = `TEXT,a,b,c,d,CORRECT
Q1,w,x,y,z,d
`;
    const q = parseQuestions(csv);
    expect(q[0].correct).toBe('D');
  });

  test('throws when required columns are missing', () => {
    const csv = `question,A,B,C,D,correct
Q1,w,x,y,z,A
`;
    expect(() => parseQuestions(csv)).toThrow(/missing required columns/i);
  });

  test('throws with row numbers for bad rows', () => {
    const csv = `text,A,B,C,D,correct
Good,1,2,3,4,A
Bad,1,2,3,4,X
,1,2,3,4,B
`;
    expect(() => parseQuestions(csv)).toThrow(/Row 3.*correct/is);
    expect(() => parseQuestions(csv)).toThrow(/Row 4.*text/is);
  });

  test('throws on empty input', () => {
    expect(() => parseQuestions('')).toThrow(/empty/i);
  });
});
