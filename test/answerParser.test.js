'use strict';

const { normalizeAnswer } = require('../src/quiz/answerParser');

describe('normalizeAnswer', () => {
  test('accepts a bare letter in any case', () => {
    expect(normalizeAnswer('A')).toBe('A');
    expect(normalizeAnswer('b')).toBe('B');
    expect(normalizeAnswer('  c  ')).toBe('C');
    expect(normalizeAnswer('D')).toBe('D');
  });

  test('accepts letters with surrounding punctuation/brackets', () => {
    expect(normalizeAnswer('A)')).toBe('A');
    expect(normalizeAnswer('(b)')).toBe('B');
    expect(normalizeAnswer('C.')).toBe('C');
    expect(normalizeAnswer('d:')).toBe('D');
    expect(normalizeAnswer('[A]')).toBe('A');
  });

  test('rejects out-of-range letters', () => {
    expect(normalizeAnswer('E')).toBeNull();
    expect(normalizeAnswer('Z')).toBeNull();
  });

  test('respects a smaller option count', () => {
    expect(normalizeAnswer('C', 2)).toBeNull();
    expect(normalizeAnswer('B', 2)).toBe('B');
  });

  test('rejects free-text and multi-token replies', () => {
    expect(normalizeAnswer('the answer is B')).toBeNull();
    expect(normalizeAnswer('AB')).toBeNull();
    expect(normalizeAnswer('a a')).toBeNull();
    expect(normalizeAnswer('hello')).toBeNull();
    expect(normalizeAnswer('')).toBeNull();
  });

  test('rejects non-strings', () => {
    expect(normalizeAnswer(null)).toBeNull();
    expect(normalizeAnswer(undefined)).toBeNull();
    expect(normalizeAnswer(3)).toBeNull();
  });
});
