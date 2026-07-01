'use strict';

const { parse } = require('csv-parse/sync');

const REQUIRED_COLUMNS = ['text', 'a', 'b', 'c', 'd', 'correct'];

/**
 * Parse a questions CSV buffer/string into question objects.
 * Expected header: text,A,B,C,D,correct  (correct is a letter A-D).
 *
 * @param {Buffer|string} input
 * @returns {Array<{text, options:{A,B,C,D}, correct}>}
 * @throws {Error} on missing columns or invalid rows (message lists row numbers)
 */
function parseQuestions(input) {
  const records = parse(input, {
    columns: (header) => header.map((h) => String(h).trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true, // tolerate stray double-quotes inside fields (e.g. book titles)
  });

  if (records.length === 0) {
    throw new Error('Questions file is empty.');
  }

  const firstRow = records[0];
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in firstRow));
  if (missing.length) {
    throw new Error(
      `Questions CSV is missing required columns: ${missing.join(', ')}. ` +
        `Expected header: text,A,B,C,D,correct`
    );
  }

  const questions = [];
  const errors = [];

  records.forEach((row, i) => {
    const rowNum = i + 2; // +1 for header, +1 for 1-based
    const text = (row.text || '').trim();
    const options = {
      A: (row.a || '').trim(),
      B: (row.b || '').trim(),
      C: (row.c || '').trim(),
      D: (row.d || '').trim(),
    };
    const correct = (row.correct || '').trim().toUpperCase();

    if (!text) errors.push(`Row ${rowNum}: missing question text.`);
    for (const letter of ['A', 'B', 'C', 'D']) {
      if (!options[letter]) errors.push(`Row ${rowNum}: missing option ${letter}.`);
    }
    if (!['A', 'B', 'C', 'D'].includes(correct)) {
      errors.push(`Row ${rowNum}: 'correct' must be one of A, B, C, D (got "${row.correct}").`);
    }

    questions.push({ text, options, correct });
  });

  if (errors.length) {
    throw new Error(`Invalid questions CSV:\n- ${errors.join('\n- ')}`);
  }

  return questions;
}

module.exports = { parseQuestions };
