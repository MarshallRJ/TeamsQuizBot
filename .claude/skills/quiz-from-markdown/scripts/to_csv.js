'use strict';

/**
 * Serialize authored quiz questions (JSON) into a TeamsQuizBot questions CSV.
 *
 * Usage:
 *   node to_csv.js <input.json|-> <output.csv>
 *
 * Input JSON: an array of objects, each:
 *   { "text": "...", "A": "...", "B": "...", "C": "...", "D": "...", "correct": "A|B|C|D" }
 *
 * The script validates every row and handles CSV quoting/escaping so the output
 * always parses cleanly with src/quiz/questionParser.js. It exits non-zero and
 * reports the offending row(s) on any validation error — never emits a bad CSV.
 */

const fs = require('fs');

function readInput(pathArg) {
  const raw = pathArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(pathArg, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`Input is not valid JSON: ${err.message}`);
  }
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function validate(questions) {
  if (!Array.isArray(questions)) fail('Input JSON must be an array of question objects.');
  if (questions.length === 0) fail('No questions provided.');

  const errors = [];
  questions.forEach((q, i) => {
    const row = i + 1;
    if (!q || typeof q !== 'object') return errors.push(`Q${row}: not an object.`);
    if (!q.text || !String(q.text).trim()) errors.push(`Q${row}: missing "text".`);
    for (const letter of ['A', 'B', 'C', 'D']) {
      if (!q[letter] || !String(q[letter]).trim()) errors.push(`Q${row}: missing option "${letter}".`);
    }
    const correct = String(q.correct || '').trim().toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(correct)) {
      errors.push(`Q${row}: "correct" must be A, B, C or D (got "${q.correct}").`);
    }
  });

  if (errors.length) fail(`Invalid questions:\n- ${errors.join('\n- ')}`);
}

function toCsv(questions) {
  const lines = ['text,A,B,C,D,correct'];
  for (const q of questions) {
    lines.push(
      [q.text, q.A, q.B, q.C, q.D, String(q.correct).trim().toUpperCase()]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function main() {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg) {
    fail('Usage: node to_csv.js <input.json|-> <output.csv>');
  }
  const questions = readInput(inputArg);
  validate(questions);
  fs.writeFileSync(outputArg, toCsv(questions), 'utf8');
  console.log(`Wrote ${questions.length} question(s) to ${outputArg}`);
}

main();
