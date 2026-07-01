'use strict';

const $ = (sel) => document.querySelector(sel);
let currentQuizId = null;
let currentSessionId = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function setStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

// ---- Quizzes list ----
async function loadQuizzes() {
  const quizzes = await api('/quizzes');
  const box = $('#quizzes');
  if (!quizzes.length) {
    box.innerHTML = '<p class="meta">No quizzes yet — create one above.</p>';
    return;
  }
  box.innerHTML = '';
  for (const q of quizzes) {
    const div = document.createElement('div');
    div.className = 'quiz-item';
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(q.title)}</strong>
        <div class="meta">${q.questionIds.length} questions · ${q.questionsPerParticipant} per participant</div>
      </div>
      <button class="secondary">Manage</button>`;
    div.querySelector('button').onclick = () => openQuiz(q.id);
    box.appendChild(div);
  }
}

$('#create-quiz-form').onsubmit = async (e) => {
  e.preventDefault();
  await api('/quizzes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: $('#quiz-title').value,
      description: $('#quiz-description').value,
      questionsPerParticipant: Number($('#quiz-n').value),
    }),
  });
  $('#quiz-title').value = '';
  $('#quiz-description').value = '';
  await loadQuizzes();
};

// ---- Quiz detail ----
async function openQuiz(id) {
  currentQuizId = id;
  const quiz = await api(`/quizzes/${id}`);
  $('#detail-title').textContent = quiz.title;
  $('#detail').classList.remove('hidden');
  $('#questions-status').textContent = quiz.questionCount
    ? `${quiz.questionCount} loaded`
    : '';
  $('#participants-status').textContent = quiz.participantCount
    ? `${quiz.participantCount} loaded`
    : '';
  $('#detail').scrollIntoView({ behavior: 'smooth' });
  renderSessions(quiz.sessions || []);
}

async function uploadFile(inputSel, urlSuffix, statusSel) {
  const file = $(inputSel).files[0];
  const status = $(statusSel);
  if (!file) return setStatus(status, 'Choose a file first.', false);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api(`/quizzes/${currentQuizId}/${urlSuffix}`, { method: 'POST', body: fd });
    setStatus(status, `${r.count} loaded ✓`, true);
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

$('#upload-questions').onclick = () => uploadFile('#questions-file', 'questions', '#questions-status');
$('#upload-participants').onclick = () => uploadFile('#participants-file', 'participants', '#participants-status');

$('#start-session').onclick = async () => {
  const status = $('#start-status');
  try {
    const session = await api(`/quizzes/${currentQuizId}/sessions`, { method: 'POST' });
    setStatus(status, 'Started! Questions are being sent.', true);
    await openQuiz(currentQuizId);
    openResults(session.id);
  } catch (err) {
    setStatus(status, err.message, false);
  }
};

function renderSessions(sessions) {
  const box = $('#sessions');

  // Only one running session is allowed per quiz.
  const running = sessions.find((s) => s.status === 'running');
  $('#start-session').disabled = Boolean(running);
  const startStatus = $('#start-status');
  if (running && !startStatus.textContent) {
    startStatus.textContent = 'A session is already running — abandon it to start a new one.';
    startStatus.className = 'status';
  } else if (!running && startStatus.className === 'status') {
    startStatus.textContent = ''; // clear the neutral note, keep ok/err messages
  }

  if (!sessions.length) {
    box.innerHTML = '<p class="meta">No sessions run yet.</p>';
    return;
  }
  box.innerHTML = '';
  for (const s of sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';
    const abandonBtn =
      s.status === 'running' ? '<button class="danger" data-abandon>Abandon</button>' : '';
    const summary = s.summary
      ? `<span class="meta"> · ${s.summary.averagePercent}% avg · ${s.summary.participantCount} participant(s)</span>`
      : '';
    div.innerHTML = `
      <div>
        <span class="badge ${s.status}">${s.status}</span>
        <span class="meta">started ${new Date(s.startedAt).toLocaleString()}</span>
        ${summary}
      </div>
      <div class="session-actions">
        ${abandonBtn}
        <button class="secondary" data-results>View results</button>
      </div>`;
    div.querySelector('[data-results]').onclick = () => openResults(s.id);
    const ab = div.querySelector('[data-abandon]');
    if (ab) ab.onclick = () => abandonSession(s.id);
    box.appendChild(div);
  }
}

async function abandonSession(sessionId) {
  if (!confirm('Abandon this running session? Participants stop receiving questions and you can start a new one.')) return;
  try {
    await api(`/sessions/${sessionId}/abandon`, { method: 'POST' });
    await openQuiz(currentQuizId);
  } catch (err) {
    setStatus($('#start-status'), err.message, false);
  }
}

// ---- Results ----
async function openResults(sessionId) {
  currentSessionId = sessionId;
  $('#results').classList.remove('hidden');
  $('#download-csv').href = `/api/sessions/${sessionId}/results.csv`;
  await loadResults();
  $('#results').scrollIntoView({ behavior: 'smooth' });
}

$('#refresh-results').onclick = loadResults;

async function loadResults() {
  if (!currentSessionId) return;
  const report = await api(`/sessions/${currentSessionId}/results`);
  const s = report.summary || {};
  const rows = report.participants
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.name || p.email)}</td>
        <td>${escapeHtml(p.email)}</td>
        <td><span class="badge ${p.status}">${p.status}</span></td>
        <td>${p.score} / ${p.total}</td>
        <td>${p.answered} answered, ${p.unanswered} skipped</td>
      </tr>`
    )
    .join('');

  // Hardest questions (lowest correct rate) — up to 5.
  const hardest = (s.questionStats || [])
    .slice(0, 5)
    .map(
      (q) => `<li>${escapeHtml(q.questionText)} — <strong>${q.correctRate}%</strong> correct (${q.correct}/${q.asked})</li>`
    )
    .join('');

  $('#results-body').innerHTML = `
    <div class="summary">
      <span class="badge ${report.session.status}">${report.session.status}</span>
      <span class="stat"><strong>${s.averagePercent ?? 0}%</strong> avg score</span>
      <span class="stat"><strong>${s.averageScore ?? 0}</strong> avg correct</span>
      <span class="stat"><strong>${s.completed ?? 0}</strong>/${s.participantCount ?? 0} completed</span>
      ${s.errored ? `<span class="stat err">${s.errored} unreachable</span>` : ''}
    </div>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Score</th><th>Detail</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="meta">No data yet.</td></tr>'}</tbody>
    </table>
    ${hardest ? `<h3>Hardest questions</h3><ul class="hardest">${hardest}</ul>` : ''}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

loadQuizzes();
