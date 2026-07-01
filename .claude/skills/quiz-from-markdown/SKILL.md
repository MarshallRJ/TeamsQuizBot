---
name: quiz-from-markdown
description: Generates a TeamsQuizBot multiple-choice questions CSV from a markdown source file of notes, docs, or reference material. Use when the user wants to author quiz questions from markdown/prose content, turn notes or documentation into a quiz, or produce a questions.csv (columns text,A,B,C,D,correct) to upload into TeamsQuizBot. Triggers include "make a quiz from this markdown/doc/notes", "generate quiz questions from <file>.md", or "create questions.csv from this content".
---

# Quiz from Markdown

Author multiple-choice quiz questions from a markdown source file and emit a
`questions.csv` in the exact format TeamsQuizBot ingests (`text,A,B,C,D,correct`,
where `correct` is a letter A–D).

The workflow is: **you author the questions** (this is the judgement part), then a
bundled script serializes and validates them so the CSV always parses cleanly.

## Steps

1. **Read the source.** Read the markdown file the user names. If they didn't name
   one, ask which file. Base every question strictly on this content — do not
   introduce outside facts.

2. **Decide the count.** Use the number the user asked for. If unspecified, author
   roughly one question per distinct key concept and tell the user how many you made
   and why. Never pad thin content with filler questions.

3. **Author the questions** following the quality rules below. Produce them as a JSON
   array, each object shaped exactly:
   ```json
   { "text": "...", "A": "...", "B": "...", "C": "...", "D": "...", "correct": "B" }
   ```
   Write this array to a temp file (use the scratchpad directory), e.g. `questions.json`.

4. **Serialize + validate.** Run the bundled script — it handles CSV quoting/escaping
   and rejects malformed rows, so the output is guaranteed ingestible:
   ```bash
   node .claude/skills/quiz-from-markdown/scripts/to_csv.js <questions.json> <output.csv>
   ```
   Default `<output.csv>` to `questions.csv` in the current directory unless the user
   gave a path.

5. **Verify it parses** with the app's own parser (the real consumer):
   ```bash
   node -e "console.log(require('./src/quiz/questionParser').parseQuestions(require('fs').readFileSync('<output.csv>')).length + ' questions OK')"
   ```
   If it throws, fix the flagged rows and re-run.

6. **Report.** Tell the user the file path and count, and that they can upload it in
   the admin UI (Quiz → Upload questions) or via `POST /api/quizzes/:id/questions`.

## Question quality rules

- **Grounded:** every question and its correct answer must be supported by the source.
  If the material doesn't clearly support a fact, don't ask about it.
- **Exactly one correct answer**, unambiguous to someone who read the material.
- **Plausible distractors:** the 3 wrong options should be believable to someone who
  didn't study — similar in length, style, and specificity to the correct one. Avoid
  obviously silly or throwaway options.
- **Vary the correct letter** across questions — don't cluster answers on A (aim for a
  roughly even spread of A/B/C/D).
- **Single line of text** per question; keep options concise. Commas are fine — the
  script quotes them correctly.
- **Avoid** "All/None of the above", double negatives, trick wording, and two options
  that mean the same thing.
- **De-duplicate:** don't ask the same fact twice in different words.

## Notes

- The script is deterministic and does the CSV escaping — do not hand-write the CSV,
  always pass JSON through it. This avoids quoting bugs when option text contains
  commas or quotes.
- Correct-answer letters are normalized to uppercase by the script.
