'use strict';
// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../dev/fake-gas');

function fresh(opts) {
  const rt = createRuntime(Object.assign({ quiet: true }, opts));
  rt.context.setup();
  return rt;
}
function otpFor(rt, email) {
  const m = rt.outbox.filter((x) => x.to === email && /Verification code/.test(x.subject)).pop();
  return /code: (\d{6})/.exec(m.subject)[1];
}
function startStudent(rt, email, extra) {
  assert.equal(rt.call('requestCode', { quizId: 'DEMO-MACRO', email }).ok, true);
  return rt.call('start', Object.assign({
    quizId: 'DEMO-MACRO', name: 'Ada Student', email, studentId: 'S1', accessCode: 'DSGE2026',
    emailCode: otpFor(rt, email), userAgent: 'UA-1',
  }, extra || {}));
}
/** Builds a fully-correct answer sheet from the server-side question bank. */
function perfectAnswers(rt, questions) {
  const bank = rt.context.getQuestions_('DEMO-MACRO');
  const a = {};
  questions.forEach((q) => {
    const b = bank.find((x) => x.q_id === q.id);
    if (b.type === 'mcq' || b.type === 'tf') a[q.id] = b.answerIdx[0];
    else if (b.type === 'multi') a[q.id] = b.answerIdx.slice();
    else if (b.type === 'numeric') a[q.id] = b.answerRaw.replace('.', ',');   // comma decimal
    else if (b.type === 'short') a[q.id] = 'Forward-Looking ';
    else a[q.id] = 'Because the real rate rises more than one-for-one.';
  });
  return a;
}

// --------------------------------------------------------------------------
// Pure grading helpers
// --------------------------------------------------------------------------
test('parseNumber_ handles locales, percent and junk', () => {
  const rt = fresh();
  const p = rt.context.parseNumber_;
  assert.equal(p('3,14'), 3.14);
  assert.equal(p(' 9.40 '), 9.4);
  assert.equal(p('1,234.5'), 1234.5);
  assert.equal(p('1.234,5'), 1234.5);
  assert.equal(p('1 200,5'), 1200.5);
  assert.equal(p('1,234,567'), 1234567);
  assert.equal(p('5.009'), 5.009);   // single separator = decimal mark
  assert.equal(p('1,234'), 1.234);
  assert.equal(p('-2.5e-3'), -0.0025);
  assert.equal(p('50%'), 0.5);
  assert.equal(p('abc'), null);
  assert.equal(p(''), null);
  assert.equal(p('1/2'), null);
});

test('normalizeText_ ignores case, accents, spaces and trailing dots', () => {
  const n = fresh().context.normalizeText_;
  assert.equal(n('  Forward–Looking. '), 'forward-looking');
  assert.equal(n('Prédéterminées'), 'predeterminees');
  assert.equal(n('jump   variables'), 'jump variables');
});

test('gradeQuestion_ covers every question type', () => {
  const c = fresh().context;
  const Q = (row) => c.normalizeQuestion_(Object.assign({ quiz_id: 'X', q_id: 'q', points: 2, tolerance: '', explanation: '' }, row));
  const mcq = Q({ type: 'mcq', options: 'a|b|c', answer: 'B' });
  assert.equal(c.gradeQuestion_(mcq, 1).earned, 2);
  assert.equal(c.gradeQuestion_(mcq, 0).earned, 0);
  assert.equal(c.gradeQuestion_(mcq, undefined).earned, 0);

  const tf = Q({ type: 'tf', answer: false });
  assert.equal(c.gradeQuestion_(tf, 1).earned, 2);
  assert.equal(c.gradeQuestion_(tf, 0).earned, 0);

  const multi = Q({ type: 'multi', options: 'a|b|c|d', answer: 'A,C', points: 4 });
  assert.equal(c.gradeQuestion_(multi, [0, 2]).earned, 4);
  assert.equal(c.gradeQuestion_(multi, [0]).earned, 2);               // half right
  assert.equal(c.gradeQuestion_(multi, [0, 1]).earned, 0);            // one right, one wrong
  assert.equal(c.gradeQuestion_(multi, [0, 1, 2, 3]).earned, 0);      // "select all" doesn't pay

  const num = Q({ type: 'numeric', answer: '9.40', tolerance: '1%' });
  assert.equal(c.gradeQuestion_(num, '9,45').earned, 2);
  assert.equal(c.gradeQuestion_(num, '9.6').earned, 0);
  const numAbs = Q({ type: 'numeric', answer: '5', tolerance: '0.01' });
  assert.equal(c.gradeQuestion_(numAbs, '5.009').earned, 2);
  assert.equal(c.gradeQuestion_(numAbs, '5.02').earned, 0);
  const numExact = Q({ type: 'numeric', answer: '4' });
  assert.equal(c.gradeQuestion_(numExact, '4.0').earned, 2);

  const short = Q({ type: 'short', answer: 'jump|forward-looking' });
  assert.equal(c.gradeQuestion_(short, 'Forward Looking').earned, 0); // hyphen differs → not in list
  assert.equal(c.gradeQuestion_(short, 'JUMP.').earned, 2);

  const essay = Q({ type: 'essay', answer: '' });
  const r = c.gradeQuestion_(essay, 'some text');
  assert.equal(r.manual, true);
  assert.equal(r.earned, 0);
});

// --------------------------------------------------------------------------
// Full API lifecycle
// --------------------------------------------------------------------------
test('quiz info hides answers and reports requirements', () => {
  const rt = fresh();
  const r = rt.call('quizInfo', { quizId: 'DEMO-MACRO' });
  assert.equal(r.ok, true);
  assert.equal(r.quiz.requiresAccessCode, true);
  assert.equal(r.quiz.requiresEmailCode, true);
  assert.equal(r.quiz.questionCount, 8);
  assert.equal(JSON.stringify(r).includes('DSGE2026'), false, 'access code must not leak');
});

test('start validates access code, e-mail code and returns no answers', () => {
  const rt = fresh();
  const bad = startStudent(rt, 'a@uni.edu', { accessCode: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /access code/i);

  rt.call('requestCode', { quizId: 'DEMO-MACRO', email: 'b@uni.edu' });
  const badOtp = rt.call('start', { quizId: 'DEMO-MACRO', name: 'Bob B', email: 'b@uni.edu', accessCode: 'DSGE2026', emailCode: '000000' });
  assert.equal(badOtp.ok, false);
  assert.match(badOtp.error, /verification code/i);

  const ok = startStudent(rt, 'c@uni.edu');
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.questions.length, 8);
  const blob = JSON.stringify(ok.questions);
  for (const leak of ['answer', 'explanation', 'tolerance', 'answerIdx', 'Expected duration', '9.40']) {
    assert.equal(blob.includes(leak), false, 'payload leaks "' + leak + '"');
  }
  // every MCQ option carries its original index so grading survives shuffling
  ok.questions.filter((q) => q.type === 'mcq').forEach((q) => q.options.forEach((o) => assert.equal(typeof o.i, 'number')));
});

test('perfect attempt scores full marks except the essay, then e-mails feedback', () => {
  const rt = fresh();
  const s = startStudent(rt, 'ada@uni.edu');
  const answers = perfectAnswers(rt, s.questions);
  const sub = rt.call('submit', { token: s.token, answers });
  assert.equal(sub.ok, true, sub.error);
  const row = rt.context.readTable_('Submissions')[0];
  assert.equal(Number(row.score), 13);          // 2+1+2+3+2+2+1, essay (4) pending
  assert.equal(Number(row.max_score), 17);
  assert.equal(row.manual_pending, 'YES');
  assert.equal(row.email_status, 'AWAITING_MANUAL_GRADING');
  assert.equal(sub.result.showScore, false, 'score hidden while essay ungraded');

  // Instructor grades the essay → feedback becomes sendable
  const key = rt.props.ADMIN_KEY;
  const g = rt.call('adminGrade', { adminKey: key, submissionId: row.submission_id, qId: 'Q8', points: 3, comment: 'Good intuition.' });
  assert.equal(g.ok, true, g.error);
  assert.equal(g.score, 16);
  assert.equal(g.manualPending, false);
  const send = rt.call('adminSendFeedback', { adminKey: key, quizId: 'DEMO-MACRO' });
  assert.equal(send.sent, 1);
  const mail = rt.outbox.find((m) => /Your result/.test(m.subject));
  assert.equal(mail.to, 'ada@uni.edu');
  assert.match(mail.htmlBody, /16 \/ 17/);
  assert.match(mail.htmlBody, /Good intuition/);
  assert.match(mail.htmlBody, /Correct answer/);
});

test('immediate feedback is e-mailed at submission when nothing needs manual grading', () => {
  const rt = fresh();
  // drop the essay question
  const qs = rt.sheet('Questions');
  qs.data = qs.data.filter((r) => r[2] !== 'essay');
  const s = startStudent(rt, 'eve@uni.edu');
  const answers = perfectAnswers(rt, s.questions);
  answers.Q1 = (answers.Q1 + 1) % 4;   // one mistake (2 pts)
  const sub = rt.call('submit', { token: s.token, answers });
  assert.equal(sub.result.showScore, true);
  assert.equal(sub.result.score, 11);
  assert.equal(sub.result.max, 13);
  assert.match(sub.result.emailStatus, /^SENT/);
  assert.ok(rt.outbox.some((m) => m.to === 'eve@uni.edu' && /Your result/.test(m.subject)));
});

test('one attempt only; re-entering resumes the same clock and counts a violation', () => {
  const rt = fresh();
  const s1 = startStudent(rt, 'tom@uni.edu');
  const again = startStudent(rt, 'tom@uni.edu', { userAgent: 'Other-Browser' });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.token, s1.token, 'same session');
  assert.equal(again.expiresAt, s1.expiresAt, 'timer not reset');
  assert.deepEqual(again.questions.map((q) => q.id), s1.questions.map((q) => q.id), 'same question order');
  assert.equal(again.violations, 1);
  const sess = rt.context.readTable_('Sessions')[0];
  assert.match(sess.flags, /device_changed/);

  rt.call('submit', { token: s1.token, answers: {} });
  const third = startStudent(rt, 'tom@uni.edu');
  assert.equal(third.ok, false);
  assert.equal(third.code, 'ALREADY_SUBMITTED');
});

test('violation limit tells the client to submit; minor events are logged but not counted', () => {
  const rt = fresh();
  const s = startStudent(rt, 'v@uni.edu');
  const minor = rt.call('violation', { token: s.token, type: 'copy_attempt' });
  assert.equal(minor.counted, false);
  assert.equal(minor.violations, 0);
  rt.call('violation', { token: s.token, type: 'tab_hidden' });
  rt.call('violation', { token: s.token, type: 'fullscreen_exit' });
  const third = rt.call('violation', { token: s.token, type: 'window_blur' });
  assert.equal(third.violations, 3);
  assert.equal(third.mustSubmit, true);
  rt.call('submit', { token: s.token, answers: {}, autoSubmitted: true, reason: 'violation_limit' });
  const row = rt.context.readTable_('Submissions')[0];
  assert.equal(Number(row.violations), 3);
  assert.match(row.flags, /auto_submitted:violation_limit/);
  assert.equal(JSON.parse(row.violation_log).length, 4);
});

test('late submission ignores browser answers and grades the last autosave', () => {
  const rt = fresh();
  const s = startStudent(rt, 'late@uni.edu');
  const answers = perfectAnswers(rt, s.questions);
  rt.call('save', { token: s.token, answers: { Q7: answers.Q7 } });         // saved in time: 1 pt
  rt.clock.offsetMs = 25 * 60 * 1000;                                        // 25 min later (limit 20)
  const tooLateSave = rt.call('save', { token: s.token, answers });
  assert.equal(tooLateSave.ok, true);
  rt.call('submit', { token: s.token, answers });
  const row = rt.context.readTable_('Submissions')[0];
  assert.equal(row.late, 'YES');
  assert.equal(Number(row.score), 1, 'only the on-time draft counts');
});

test('roster, domain and window restrictions', () => {
  const rt = fresh();
  const qz = rt.sheet('Quizzes');
  const head = qz.data[0];
  const set = (k, v) => { qz.data[1][head.indexOf(k)] = v; };
  set('allowed_domain', 'uni.edu');
  set('require_roster', true);
  set('require_email_code', false);
  rt.sheet('Roster').appendRow(['DEMO-MACRO', 'listed@uni.edu', 'Listed Student', 'R-42']);

  const dom = rt.call('start', { quizId: 'DEMO-MACRO', name: 'X Y', email: 'x@gmail.com', accessCode: 'DSGE2026' });
  assert.match(dom.error, /institutional/);
  const notListed = rt.call('start', { quizId: 'DEMO-MACRO', name: 'X Y', email: 'x@uni.edu', accessCode: 'DSGE2026' });
  assert.match(notListed.error, /class list/);
  const ok = rt.call('start', { quizId: 'DEMO-MACRO', name: 'Nickname', email: 'Listed@Uni.edu', accessCode: 'DSGE2026' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.student.name, 'Listed Student', 'roster name wins');
  assert.equal(ok.student.studentId, 'R-42');

  set('close_at', new Date(Date.now() - 1000));
  const closed = rt.call('start', { quizId: 'DEMO-MACRO', name: 'Listed', email: 'listed@uni.edu', accessCode: 'DSGE2026' });
  assert.match(closed.error, /closed/);
});

test('question pool: each student gets a random subset', () => {
  const rt = fresh();
  const qz = rt.sheet('Quizzes');
  qz.data[1][qz.data[0].indexOf('questions_per_student')] = 5;
  const s = startStudent(rt, 'pool@uni.edu');
  assert.equal(s.questions.length, 5);
  assert.equal(new Set(s.questions.map((q) => q.id)).size, 5);
});

test('admin endpoints require the key; void allows a retake', () => {
  const rt = fresh();
  assert.equal(rt.call('adminOverview', { adminKey: 'wrong' }).ok, false);
  const s = startStudent(rt, 'redo@uni.edu');
  rt.call('submit', { token: s.token, answers: {} });
  const key = rt.props.ADMIN_KEY;
  const ov = rt.call('adminOverview', { adminKey: key });
  assert.equal(ov.quizzes[0].submissions, 1);
  const res = rt.call('adminResults', { adminKey: key, quizId: 'DEMO-MACRO' });
  assert.equal(res.submissions.length, 1);
  assert.equal(rt.call('adminVoid', { adminKey: key, submissionId: res.submissions[0].id }).ok, true);
  const retake = startStudent(rt, 'redo@uni.edu');
  assert.equal(retake.ok, true, retake.error);
  assert.notEqual(retake.token, s.token);
});

test('after_close release queues e-mails until the quiz closes', () => {
  const rt = fresh();
  const qz = rt.sheet('Quizzes');
  qz.data[1][qz.data[0].indexOf('feedback_release')] = 'after_close';
  rt.sheet('Questions').data = rt.sheet('Questions').data.filter((r) => r[2] !== 'essay');
  const s = startStudent(rt, 'q@uni.edu');
  const sub = rt.call('submit', { token: s.token, answers: {} });
  assert.equal(sub.result.showScore, false);
  assert.equal(sub.result.emailStatus, 'QUEUED');
  rt.context.sendQueuedFeedback();
  assert.equal(rt.outbox.filter((m) => /Your result/.test(m.subject)).length, 0, 'still open');
  qz.data[1][qz.data[0].indexOf('close_at')] = new Date(Date.now() - 1000);
  rt.context.sendQueuedFeedback();
  assert.equal(rt.outbox.filter((m) => /Your result/.test(m.subject)).length, 1);
});

test('e-mail failure is recorded, not fatal', () => {
  const rt = fresh({ failMail: false });
  rt.sheet('Questions').data = rt.sheet('Questions').data.filter((r) => r[2] !== 'essay');
  const qz = rt.sheet('Quizzes');
  qz.data[1][qz.data[0].indexOf('require_email_code')] = false;
  rt.context.MailApp.sendEmail = () => { throw new Error('quota'); };
  const s = rt.call('start', { quizId: 'DEMO-MACRO', name: 'No Mail', email: 'nm@uni.edu', accessCode: 'DSGE2026' });
  const sub = rt.call('submit', { token: s.token, answers: {} });
  assert.equal(sub.ok, true);
  assert.match(sub.result.emailStatus, /^FAILED/);
});
