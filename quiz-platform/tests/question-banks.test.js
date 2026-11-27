'use strict';
// Validates every question bank in question-banks/ against the real backend:
// rows parse, answer keys point at real options, and a perfect paper earns
// full marks (essays excepted). Run: node --test tests/question-banks.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRuntime } = require('../dev/fake-gas');

const DIR = path.join(__dirname, '..', 'question-banks');
const banks = fs.readdirSync(DIR).filter((f) => f.endsWith('-questions.tsv'));
const tsv = (file) => fs.readFileSync(path.join(DIR, file), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));

for (const file of banks) {
  test('question bank ' + file, () => {
    const rows = tsv(file);
    const quizFile = file.replace('-questions.tsv', '-quiz.tsv');
    const rt = createRuntime({ quiet: true });
    rt.context.setup();
    // replace the demo content with this bank
    const qs = rt.sheet('Questions'); qs.data = [qs.data[0]];
    const qz = rt.sheet('Quizzes'); qz.data = [qz.data[0]];
    rows.forEach((r) => { assert.equal(r.length, 9, 'row must have 9 columns: ' + r[1]); qs.appendRow(r); });
    let quizId = rows[0][0];
    if (fs.existsSync(path.join(DIR, quizFile))) {
      const qrow = tsv(quizFile)[0];
      assert.equal(qrow.length, 19, 'quiz row must have 19 columns');
      quizId = qrow[0];
      qz.appendRow(qrow);
    }

    const bank = rt.context.getQuestions_(quizId);
    assert.equal(bank.length, rows.length);
    assert.equal(new Set(bank.map((q) => q.q_id)).size, bank.length, 'q_id values must be unique');
    const answers = {};
    let expected = 0;
    for (const q of bank) {
      assert.ok(['mcq', 'multi', 'tf', 'numeric', 'short', 'essay'].includes(q.type), q.q_id + ': unknown type ' + q.type);
      if (q.type === 'mcq' || q.type === 'multi') {
        assert.ok(q.options.length >= 2, q.q_id + ': needs options');
        const letters = q.answerRaw.split(/[,;\s]+/).filter(Boolean);
        assert.equal(q.answerIdx.length, letters.length, q.q_id + ': answer letter outside the options');
        answers[q.q_id] = q.type === 'mcq' ? q.answerIdx[0] : q.answerIdx.slice();
      } else if (q.type === 'tf') {
        assert.match(q.answerRaw, /^(TRUE|FALSE)$/i, q.q_id + ': tf answer must be TRUE or FALSE');
        answers[q.q_id] = q.answerIdx[0];
      } else if (q.type === 'numeric') {
        assert.notEqual(rt.context.parseNumber_(q.answerRaw), null, q.q_id + ': numeric answer does not parse');
        answers[q.q_id] = q.answerRaw;
      } else if (q.type === 'short') {
        answers[q.q_id] = q.answerRaw.split('|')[0].toUpperCase() + '.';   // case/punctuation-insensitive
      } else {
        answers[q.q_id] = 'Model answer text.';
      }
      if (q.type !== 'essay') expected += q.points;
      assert.equal(/\$[^$]*$/.test(q.text.replace(/\$[^$]*\$/g, '')), false, q.q_id + ': unbalanced $ in LaTeX');
    }
    const graded = rt.context.gradeAttempt_(bank, answers);
    assert.equal(graded.score, expected, 'a perfect paper must earn every auto-graded point');
    const wrong = rt.context.gradeAttempt_(bank, {});
    assert.equal(wrong.score, 0, 'a blank paper must earn nothing');
  });
}
