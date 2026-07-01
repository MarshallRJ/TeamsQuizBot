'use strict';

const { parseParticipants } = require('../src/quiz/participantParser');

describe('parseParticipants', () => {
  test('parses email,name header form', () => {
    const csv = `email,name
alice@example.com,Alice
bob@example.com,Bob
`;
    expect(parseParticipants(csv)).toEqual([
      { email: 'alice@example.com', name: 'Alice' },
      { email: 'bob@example.com', name: 'Bob' },
    ]);
  });

  test('parses a headerless single column of emails', () => {
    const csv = `alice@example.com
bob@example.com
`;
    const p = parseParticipants(csv);
    expect(p.map((x) => x.email)).toEqual(['alice@example.com', 'bob@example.com']);
    expect(p[0].name).toBe('');
  });

  test('lowercases and de-duplicates emails', () => {
    const csv = `email
Alice@Example.com
alice@example.com
`;
    const p = parseParticipants(csv);
    expect(p).toHaveLength(1);
    expect(p[0].email).toBe('alice@example.com');
  });

  test('throws listing invalid emails', () => {
    const csv = `email
not-an-email
bob@example.com
`;
    expect(() => parseParticipants(csv)).toThrow(/invalid email/i);
  });

  test('throws when no valid emails are present', () => {
    expect(() => parseParticipants('email\n')).toThrow(/No valid email/i);
  });
});
