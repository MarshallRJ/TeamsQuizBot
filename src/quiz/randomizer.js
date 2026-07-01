'use strict';

/**
 * Deterministic PRNG (mulberry32) so tests can pass a seed and assert output.
 * When no seed is given we derive one from Math.random().
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle returning a new array. Does not mutate the input.
 * @param {Array} items
 * @param {number} [seed] optional seed for reproducibility
 */
function shuffle(items, seed) {
  const rng = seed === undefined ? Math.random : mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pick n items at random (no duplicates) from the pool. If n >= pool length,
 * returns all items shuffled.
 * @param {Array} pool
 * @param {number} n
 * @param {number} [seed]
 */
function pickN(pool, n, seed) {
  const shuffled = shuffle(pool, seed);
  const count = Math.max(0, Math.min(n, shuffled.length));
  return shuffled.slice(0, count);
}

module.exports = { shuffle, pickN, mulberry32 };
