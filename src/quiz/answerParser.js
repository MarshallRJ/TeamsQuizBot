'use strict';

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * Normalize a chat reply into an answer letter, or null if it isn't a valid one.
 *
 * The whole (trimmed) message must be a single letter, optionally wrapped in
 * brackets and/or followed by punctuation. This is deliberately strict so that
 * chatter or the bot's own re-prompt text is never mistaken for an answer.
 * Accepts e.g. "A", "a", "A)", "(b)", " C. ", "d:".
 *
 * @param {string} text        the raw reply text
 * @param {number} optionCount number of available options (default 4 => A..D)
 * @returns {'A'|'B'|'C'|'D'|null}
 */
function normalizeAnswer(text, optionCount = 4) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^[([{]?\s*([A-Da-d])\s*[)\]}.,:;-]*$/);
  if (!match) return null;
  const letter = match[1].toUpperCase();
  const maxIndex = Math.min(optionCount, LETTERS.length);
  return LETTERS.slice(0, maxIndex).includes(letter) ? letter : null;
}

module.exports = { normalizeAnswer, LETTERS };
