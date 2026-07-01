'use strict';

const { parse } = require('csv-parse/sync');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse a participants CSV into {email, name} objects.
 *
 * Flexible input: accepts a header row with an "email" column (and optional
 * "name"), OR a headerless single column of bare email addresses. Duplicate
 * emails (case-insensitive) are removed, keeping the first occurrence.
 *
 * @param {Buffer|string} input
 * @returns {Array<{email:string, name:string}>}
 * @throws {Error} if no valid emails are found or invalid emails are present
 */
function parseParticipants(input) {
  const rows = parse(input, { skip_empty_lines: true, trim: true, relax_quotes: true });
  if (rows.length === 0) throw new Error('Participants file is empty.');

  // Detect a header row: first row contains the word "email" in some cell.
  const header = rows[0].map((c) => String(c).trim().toLowerCase());
  const hasHeader = header.includes('email');

  let emailIdx = 0;
  let nameIdx = -1;
  let dataRows = rows;

  if (hasHeader) {
    emailIdx = header.indexOf('email');
    nameIdx = header.indexOf('name');
    dataRows = rows.slice(1);
  }

  const seen = new Set();
  const participants = [];
  const errors = [];

  dataRows.forEach((cols, i) => {
    const rowNum = i + 1 + (hasHeader ? 1 : 0);
    const email = String(cols[emailIdx] || '').trim().toLowerCase();
    const name = nameIdx >= 0 ? String(cols[nameIdx] || '').trim() : '';

    if (!email) return; // skip blank lines silently
    if (!EMAIL_RE.test(email)) {
      errors.push(`Row ${rowNum}: invalid email "${cols[emailIdx]}".`);
      return;
    }
    if (seen.has(email)) return;
    seen.add(email);
    participants.push({ email, name });
  });

  if (errors.length) {
    throw new Error(`Invalid participants CSV:\n- ${errors.join('\n- ')}`);
  }
  if (participants.length === 0) {
    throw new Error('No valid email addresses found in participants file.');
  }

  return participants;
}

module.exports = { parseParticipants };
