'use strict';

const { MemoryLevel } = require('memory-level');
const { createStore } = require('../src/db/store');

function newStore() {
  return createStore(new MemoryLevel());
}

describe('store', () => {
  test('creates and lists quizzes', async () => {
    const store = newStore();
    const quiz = await store.createQuiz({ title: 'GK', questionsPerParticipant: 5 });
    expect(quiz.id).toBeTruthy();
    expect(quiz.questionsPerParticipant).toBe(5);

    const list = await store.listQuizzes();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('GK');
  });

  test('setQuestions replaces the pool and updates questionIds', async () => {
    const store = newStore();
    const quiz = await store.createQuiz({ title: 'Q', questionsPerParticipant: 2 });

    const count = await store.setQuestions(quiz.id, [
      { text: 'Q1', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'A' },
      { text: 'Q2', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'B' },
    ]);
    expect(count).toBe(2);

    const questions = await store.listQuestions(quiz.id);
    expect(questions).toHaveLength(2);

    const reloaded = await store.getQuiz(quiz.id);
    expect(reloaded.questionIds).toHaveLength(2);
    expect(reloaded.questionIds).toEqual(expect.arrayContaining(questions.map((q) => q.id)));

    // replacing shrinks the pool
    await store.setQuestions(quiz.id, [
      { text: 'only', options: { A: '1', B: '2', C: '3', D: '4' }, correct: 'C' },
    ]);
    expect(await store.listQuestions(quiz.id)).toHaveLength(1);
  });

  test('setParticipants + updateParticipant round-trips', async () => {
    const store = newStore();
    const quiz = await store.createQuiz({ title: 'Q', questionsPerParticipant: 1 });
    const created = await store.setParticipants(quiz.id, [
      { email: 'a@x.com', name: 'A' },
      { email: 'b@x.com', name: 'B' },
    ]);
    expect(created).toHaveLength(2);

    const p = created[0];
    p.graphUserId = 'user-123';
    await store.updateParticipant(p);

    const reloaded = await store.getParticipant(quiz.id, p.id);
    expect(reloaded.graphUserId).toBe('user-123');
  });

  test('sessions and runs round-trip and isolate by session', async () => {
    const store = newStore();
    const quiz = await store.createQuiz({ title: 'Q', questionsPerParticipant: 1 });
    const s1 = await store.createSession(quiz.id);
    const s2 = await store.createSession(quiz.id);

    await store.createRun({ sessionId: s1.id, participantId: 'p1', questionOrder: ['q1'], answers: [] });
    await store.createRun({ sessionId: s1.id, participantId: 'p2', questionOrder: ['q1'], answers: [] });
    await store.createRun({ sessionId: s2.id, participantId: 'p3', questionOrder: ['q1'], answers: [] });

    expect(await store.listRuns(s1.id)).toHaveLength(2);
    expect(await store.listRuns(s2.id)).toHaveLength(1);

    const [run] = await store.listRuns(s2.id);
    run.status = 'completed';
    await store.updateRun(run);
    expect((await store.getRun(s2.id, run.id)).status).toBe('completed');
  });

  test('getQuiz returns null for missing id', async () => {
    const store = newStore();
    expect(await store.getQuiz('nope')).toBeNull();
  });
});
