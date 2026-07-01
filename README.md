# TeamsQuizBot

Run multiple-choice quizzes over **Microsoft Teams**. An admin uploads a pool of
questions and a list of participant emails, then starts a quiz. Each participant is
sent a **random subset** of the questions **one at a time** in a 1:1 Teams chat, and
replies with a letter (A/B/C/D). The bot polls the chat for replies, scores them, and
stores everything **locally in LevelDB** — no external database. An admin web UI
manages quizzes and reports results.

## How it works

- **Delivery:** 1:1 Teams chat via the Microsoft Graph API (delegated auth, ROPC flow).
- **Answering:** participants reply with a single letter. Parsing is forgiving of
  punctuation/case (`a`, `A)`, `(b)`, `C.` …) but rejects free text so chatter isn't
  mistaken for an answer.
- **Per participant:** a random subset of *N* questions (configurable per quiz) is sent
  sequentially — question 1, wait for a valid reply, question 2, and so on.
- **Bad / missing answers:** the bot re-prompts once; if the next reply is still invalid
  or a configurable timeout elapses, the question is marked unanswered and skipped.
- **Storage:** LevelDB (`classic-level`) under `./data`. Results never leave the machine.

## Prerequisites

An Azure AD **app registration** (public client) and a service account:

- Delegated Graph permissions (admin-consented): `Chat.ReadWrite`, `Chat.Create`,
  `ChatMessage.Send`. (`User.Read` — used for `GET /me` — is a default scope that
  needs no admin consent.) No directory-read permission is required: the bot opens
  chats by binding directly to each participant's sign-in address, so the emails in
  the participant CSV must be the users' **UPNs / sign-in addresses**.
- A sign-in account (the bot acts as this user) that **does not require MFA** — ROPC
  cannot satisfy an MFA challenge. If MFA is mandatory, a device-code or Bot Framework
  flow would be needed instead.

## Setup

```bash
npm install
cp .env.example .env      # then fill in Graph creds, port, timeouts
npm start                 # opens the admin UI on http://127.0.0.1:3000
```

## Using it

1. **Create a quiz** — give it a title and set *questions per participant* (e.g. 5).
2. **Upload questions** (CSV) — header `text,A,B,C,D,correct` (`correct` is a letter).
   See `samples/questions.csv`.
3. **Upload participants** (CSV) — a column `email` (optional `name`), or a plain list of
   emails. See `samples/participants.csv`.
4. **Start quiz session** — everyone is sent their first question in Teams.
5. **Watch results** — live per-participant progress and scores; export a CSV.

## Configuration (`.env`)

| Variable | Meaning |
| --- | --- |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` | App registration identifiers |
| `GRAPH_CLIENT_SECRET` | Optional (only for confidential-client registrations) |
| `GRAPH_USERNAME` / `GRAPH_PASSWORD` | Bot service account (no MFA) |
| `PORT` / `HOST` | Web server bind (defaults to `127.0.0.1:3000`) |
| `DB_PATH` | LevelDB directory (default `./data`) |
| `POLL_INTERVAL_MS` | How often replies are polled (default 5000) |
| `QUESTION_TIMEOUT_MS` | Wait per question before skipping (default 300000) |

## Testing

```bash
npm test
```

Unit tests cover the answer parser, randomizer, scoring, CSV parsers, the LevelDB store
(via in-memory LevelDB), and the full quiz engine end-to-end with **Microsoft Graph
mocked out** — no network access required.

## Architecture

```
src/
  config.js                 env → config
  auth/graphAuth.js         MSAL ROPC → access token (cached)
  graph/graphClient.js      Graph calls (resolve user, chat, send, read)  ← mock seam
  db/store.js               LevelDB store (injectable)
  quiz/
    questionParser.js       questions CSV → Question[]
    participantParser.js    participants CSV → {email,name}[]
    randomizer.js           seedable pickN / shuffle
    answerParser.js         reply text → letter | null
    scoring.js              answers → score
    results.js              per-session report + CSV
    engine.js               orchestration: startSession, tick()
  web/
    server.js, routes/api.js  Express API
    public/                   static admin UI
  index.js                  wires deps, starts server + poll loop
```

The engine is driven by `tick(now)`: production wraps it in `setInterval`; tests call it
directly with a controlled clock and a scripted fake Graph client, which is what keeps
the whole flow testable without Teams.

## Notes / limitations

- The admin UI has **no authentication** — it's intended to bind to localhost. Add auth
  (or a reverse proxy) before exposing it.
- ROPC is used for simplicity given username/password credentials; it won't work with
  MFA-enforced accounts.
