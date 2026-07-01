'use strict';

const { pickN, shuffle } = require('../src/quiz/randomizer');

describe('randomizer', () => {
  const pool = ['q1', 'q2', 'q3', 'q4', 'q5'];

  test('pickN returns exactly n items, all from the pool, no duplicates', () => {
    const picked = pickN(pool, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    picked.forEach((p) => expect(pool).toContain(p));
  });

  test('pickN clamps n to pool size', () => {
    expect(pickN(pool, 99)).toHaveLength(5);
    expect(pickN(pool, 0)).toHaveLength(0);
  });

  test('seeded shuffle is deterministic', () => {
    expect(shuffle(pool, 42)).toEqual(shuffle(pool, 42));
    expect(pickN(pool, 3, 7)).toEqual(pickN(pool, 3, 7));
  });

  test('different seeds generally differ and input is not mutated', () => {
    const copy = pool.slice();
    shuffle(pool, 1);
    expect(pool).toEqual(copy); // no mutation
    // extremely unlikely to be equal for these two seeds
    expect(shuffle(pool, 1)).not.toEqual(shuffle(pool, 999));
  });
});
