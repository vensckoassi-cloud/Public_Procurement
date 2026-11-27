/**
 * ============================================================================
 *  QUIZ & EXAM PLATFORM — Google Apps Script backend
 * ============================================================================
 *  Storage  : the Google Sheet this script is bound to (Quizzes, Questions,
 *             Roster, Sessions, Submissions tabs — created by setup()).
 *  Grading  : done HERE, on the server. Correct answers never reach the
 *             student's browser.
 *  Feedback : e-mailed with MailApp from the account that deploys the script.
 *
 *  First use: open the Sheet → Extensions → Apps Script → paste this file →
 *  run setup() once → Deploy → New deployment → Web app
 *  (Execute as: Me, Who has access: Anyone). See README.md.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Configuration you may edit
// ----------------------------------------------------------------------------
const CONFIG = {
  COURSE_NAME: 'Macroeconomics',          // shown as e-mail sender name / subject prefix
  REPLY_TO: '',                           // optional reply-to address for feedback e-mails
  GRACE_SECONDS: 90,                      // network grace after the timer ends
  OTP_TTL_SECONDS: 600,                   // e-mail verification code lifetime (10 min)
  OTP_MAX_TRIES: 5,                       // wrong code attempts before the code is burned
  OTP_MAX_SENDS_PER_HOUR: 4,              // codes one address can request per hour
  TOO_FAST_SECONDS_PER_QUESTION: 10,      // flag submissions faster than this on average
  // Violations that count towards the auto-submit limit. Everything else
  // (copy, paste, right-click, blocked shortcuts…) is logged but not counted.
  COUNTED_VIOLATIONS: ['tab_hidden', 'window_blur', 'fullscreen_exit', 'reload'],
};

const SHEETS = {
  QUIZZES: 'Quizzes',
  QUESTIONS: 'Questions',
  ROSTER: 'Roster',
  SESSIONS: 'Sessions',
  SUBMISSIONS: 'Submissions',
};

const HEADERS = {
  Quizzes: ['quiz_id', 'title', 'instructions', 'access_code', 'duration_min', 'open_at', 'close_at',
    'questions_per_student', 'shuffle_questions', 'shuffle_options', 'navigation', 'max_violations',
    'pass_mark_pct', 'feedback_mode', 'feedback_release', 'allowed_domain', 'require_roster',
    'require_email_code', 'active'],
  Questions: ['quiz_id', 'q_id', 'type', 'text', 'options', 'answer', 'points', 'tolerance', 'explanation'],
  Roster: ['quiz_id', 'email', 'name', 'student_id'],
  Sessions: ['token', 'quiz_id', 'email', 'name', 'student_id', 'started_at', 'expires_at', 'question_ids',
    'option_orders', 'status', 'violations', 'violation_log', 'draft_answers', 'last_seen', 'user_agent',
    'resumes', 'flags'],
  Submissions: ['submission_id', 'submitted_at', 'quiz_id', 'email', 'name', 'student_id', 'score', 'max_score',
    'pct', 'passed', 'duration_sec', 'violations', 'auto_submitted', 'late', 'flags', 'violation_log',
    'answers', 'detail', 'manual_pending', 'email_status', 'status'],
};

// ----------------------------------------------------------------------------
// HTTP entry points
// ----------------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, service: 'quiz-platform', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Malformed request.' });
  }
  const route = ROUTES[req.action];
  if (!route) return json_({ ok: false, error: 'Unknown action.' });
  try {
    if (route.admin) requireAdmin_(req.adminKey);
    const out = route.fn(req) || {};
    out.ok = true;
    out.serverNow = Date.now();
    return json_(out);
  } catch (err) {
    const msg = err && err.userFacing ? err.message : 'Server error: ' + (err && err.message);
    if (!(err && err.userFacing)) console.error(err && err.stack || err);
    return json_({ ok: false, error: msg, code: err && err.code, retry: !(err && err.userFacing) });
  }
}

const ROUTES = {
  quizInfo: { fn: apiQuizInfo_ },
  requestCode: { fn: apiRequestCode_ },
  start: { fn: apiStart_ },
  resume: { fn: apiResume_ },
  save: { fn: apiSave_ },
  violation: { fn: apiViolation_ },
  submit: { fn: apiSubmit_ },
  adminOverview: { fn: apiAdminOverview_, admin: true },
  adminResults: { fn: apiAdminResults_, admin: true },
  adminSendFeedback: { fn: apiAdminSendFeedback_, admin: true },
  adminVoid: { fn: apiAdminVoid_, admin: true },
  adminGrade: { fn: apiAdminGrade_, admin: true },
};

// ----------------------------------------------------------------------------
// Student API
// ----------------------------------------------------------------------------
function apiQuizInfo_(req) {
  const quiz = getQuiz_(req.quizId);
  const now = new Date();
  const qCount = countQuestions_(quiz);
  return {
    quiz: {
      id: quiz.quiz_id,
      title: quiz.title,
      instructions: quiz.instructions,
      durationMin: quiz.duration_min,
      questionCount: qCount,
      openAt: quiz.open_at ? quiz.open_at.getTime() : null,
      closeAt: quiz.close_at ? quiz.close_at.getTime() : null,
      isOpen: windowState_(quiz, now) === 'open',
      windowState: windowState_(quiz, now),
      requiresAccessCode: !!quiz.access_code,
      requiresEmailCode: quiz.require_email_code,
      allowedDomain: quiz.allowed_domain || '',
      navigation: quiz.navigation,
      maxViolations: quiz.max_violations,
      feedbackRelease: quiz.feedback_release,
    },
  };
}

function apiRequestCode_(req) {
  const quiz = getQuiz_(req.quizId);
  assertWindowOpen_(quiz);
  const email = cleanEmail_(req.email);
  assertDomain_(quiz, email);
  if (quiz.require_roster) assertRoster_(quiz, email);

  const cache = CacheService.getScriptCache();
  const rateKey = 'otp_rate:' + quiz.quiz_id + ':' + email;
  const sends = Number(cache.get(rateKey) || 0);
  if (sends >= CONFIG.OTP_MAX_SENDS_PER_HOUR) userError_('Too many codes requested. Try again later.');
  cache.put(rateKey, String(sends + 1), 3600);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  cache.put(otpKey_(quiz.quiz_id, email), JSON.stringify({ code: code, tries: 0 }), CONFIG.OTP_TTL_SECONDS);
  MailApp.sendEmail({
    to: email,
    subject: '[' + CONFIG.COURSE_NAME + '] Verification code: ' + code,
    name: CONFIG.COURSE_NAME,
    htmlBody: '<p>Your verification code for <b>' + esc_(quiz.title) + '</b> is:</p>' +
      '<p style="font-size:28px;letter-spacing:6px;font-weight:bold">' + code + '</p>' +
      '<p>It expires in ' + Math.round(CONFIG.OTP_TTL_SECONDS / 60) + ' minutes. ' +
      'If you did not request it, ignore this message.</p>',
  });
  return { sent: true };
}

function apiStart_(req) {
  const quiz = getQuiz_(req.quizId);
  assertWindowOpen_(quiz);
  const email = cleanEmail_(req.email);
  let name = String(req.name || '').trim().replace(/\s+/g, ' ');
  let studentId = String(req.studentId || '').trim();
  if (name.length < 3) userError_('Please enter your full name.');
  assertDomain_(quiz, email);

  if (quiz.access_code &&
      String(req.accessCode || '').trim().toLowerCase() !== String(quiz.access_code).trim().toLowerCase()) {
    userError_('Incorrect access code.');
  }
  if (quiz.require_roster) {
    const r = assertRoster_(quiz, email);
    if (r.name) name = r.name;              // the roster is authoritative
    if (r.student_id) studentId = String(r.student_id);
  }
  if (quiz.require_email_code) verifyOtp_(quiz.quiz_id, email, req.emailCode);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const prior = findSubmission_(quiz.quiz_id, email);
    if (prior) userError_('You have already submitted this assessment. Only one attempt is allowed.', 'ALREADY_SUBMITTED');

    const existing = findSession_(function (s) {
      return s.quiz_id === quiz.quiz_id && s.email === email && s.status === 'ACTIVE';
    });
    if (existing) {
      // Same student re-entering (closed tab, other browser…): keep the ORIGINAL clock.
      return resumeSession_(existing, quiz, req.userAgent, 'restart');
    }

    const pool = getQuestions_(quiz.quiz_id);
    if (!pool.length) userError_('This assessment has no questions yet.');
    let selected = pool.slice();
    if (quiz.shuffle_questions || quiz.questions_per_student) selected = shuffle_(selected);
    if (quiz.questions_per_student && quiz.questions_per_student < selected.length) {
      selected = selected.slice(0, quiz.questions_per_student);
    }
    if (!quiz.shuffle_questions) {
      // keep the authoring order for the chosen subset
      const order = pool.map(function (q) { return q.q_id; });
      selected.sort(function (a, b) { return order.indexOf(a.q_id) - order.indexOf(b.q_id); });
    }
    const optionOrders = {};
    selected.forEach(function (q) {
      const n = q.options.length;
      if (!n) return;
      const idx = range_(n);
      optionOrders[q.q_id] = quiz.shuffle_options ? shuffle_(idx) : idx;
    });

    const now = new Date();
    let expires = new Date(now.getTime() + quiz.duration_min * 60000);
    if (quiz.close_at && quiz.close_at < expires) expires = quiz.close_at;

    const session = {
      token: Utilities.getUuid(),
      quiz_id: quiz.quiz_id,
      email: email,
      name: name,
      student_id: studentId,
      started_at: now,
      expires_at: expires,
      question_ids: JSON.stringify(selected.map(function (q) { return q.q_id; })),
      option_orders: JSON.stringify(optionOrders),
      status: 'ACTIVE',
      violations: 0,
      violation_log: '[]',
      draft_answers: '{}',
      last_seen: now,
      user_agent: String(req.userAgent || '').slice(0, 300),
      resumes: 0,
      flags: '',
    };
    appendRow_(SHEETS.SESSIONS, session);
    return sessionPayload_(session, quiz, selected, {});
  } finally {
    lock.releaseLock();
  }
}

function apiResume_(req) {
  const session = getActiveSession_(req.token);
  const quiz = getQuiz_(session.quiz_id);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return resumeSession_(session, quiz, req.userAgent, 'reload');
  } finally {
    lock.releaseLock();
  }
}

function apiSave_(req) {
  const session = getActiveSession_(req.token);
  const now = Date.now();
  const deadline = toDate_(session.expires_at).getTime() + CONFIG.GRACE_SECONDS * 1000;
  const patch = { last_seen: new Date() };
  if (now <= deadline && req.answers && typeof req.answers === 'object') {
    patch.draft_answers = JSON.stringify(req.answers).slice(0, 45000);
  }
  updateRow_(SHEETS.SESSIONS, session._row, patch);
  return { expiresAt: toDate_(session.expires_at).getTime(), violations: Number(session.violations) || 0 };
}

function apiViolation_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const session = getActiveSession_(req.token);
    const quiz = getQuiz_(session.quiz_id);
    const counted = recordViolation_(session, req.type, req.detail);
    return {
      violations: Number(session.violations),
      counted: counted,
      maxViolations: quiz.max_violations,
      mustSubmit: quiz.max_violations > 0 && Number(session.violations) >= quiz.max_violations,
    };
  } finally {
    lock.releaseLock();
  }
}

function apiSubmit_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  let submission, quiz;
  try {
    const session = findSessionByToken_(req.token);
    if (!session) userError_('Session not found.');
    if (session.status === 'SUBMITTED') {
      const prev = findSubmission_(session.quiz_id, session.email);
      return { alreadySubmitted: true, result: prev ? publicResult_(prev, getQuiz_(session.quiz_id)) : null };
    }
    if (session.status !== 'ACTIVE') userError_('This attempt is no longer active.');
    quiz = getQuiz_(session.quiz_id);

    const now = new Date();
    const expires = toDate_(session.expires_at);
    const late = now.getTime() > expires.getTime() + CONFIG.GRACE_SECONDS * 1000;
    // After the grace period, ignore what the browser sends and grade the last
    // autosaved draft (saved before the deadline) instead.
    const answers = late ? safeJson_(session.draft_answers, {})
      : (req.answers && typeof req.answers === 'object' ? req.answers : safeJson_(session.draft_answers, {}));

    // Merge client-side violations that may not have reached the server.
    if (Array.isArray(req.pendingViolations)) {
      req.pendingViolations.slice(0, 50).forEach(function (v) { recordViolation_(session, v.type, v.detail, true); });
    }

    const pool = getQuestions_(quiz.quiz_id);
    const byId = {};
    pool.forEach(function (q) { byId[q.q_id] = q; });
    const ids = safeJson_(session.question_ids, []);
    const graded = gradeAttempt_(ids.map(function (id) { return byId[id]; }).filter(Boolean), answers);

    const durationSec = Math.round((now - toDate_(session.started_at)) / 1000);
    const flags = String(session.flags || '').split(',').filter(String);
    if (Number(session.violations) > 0) flags.push('violations');
    if (req.autoSubmitted) flags.push('auto_submitted:' + String(req.reason || '').slice(0, 30));
    if (late) flags.push('late');
    if (ids.length && durationSec < ids.length * CONFIG.TOO_FAST_SECONDS_PER_QUESTION) flags.push('too_fast');

    const pct = graded.max ? round_(100 * graded.score / graded.max, 2) : 0;
    submission = {
      submission_id: Utilities.getUuid().slice(0, 8).toUpperCase(),
      submitted_at: now,
      quiz_id: quiz.quiz_id,
      email: session.email,
      name: session.name,
      student_id: session.student_id,
      score: graded.score,
      max_score: graded.max,
      pct: pct,
      passed: pct >= quiz.pass_mark_pct ? 'YES' : 'NO',
      duration_sec: durationSec,
      violations: Number(session.violations) || 0,
      auto_submitted: req.autoSubmitted ? 'YES' : 'NO',
      late: late ? 'YES' : 'NO',
      flags: unique_(flags).join(','),
      violation_log: session.violation_log,
      answers: JSON.stringify(answers).slice(0, 45000),
      detail: JSON.stringify(graded.detail).slice(0, 45000),
      manual_pending: graded.manualPending ? 'YES' : 'NO',
      email_status: initialEmailStatus_(quiz, graded.manualPending),
      status: 'VALID',
    };
    submission._row = appendRow_(SHEETS.SUBMISSIONS, submission);
    updateRow_(SHEETS.SESSIONS, session._row, {
      status: 'SUBMITTED', last_seen: now, draft_answers: submission.answers,
      violations: session.violations, violation_log: session.violation_log,
    });
  } finally {
    lock.releaseLock();
  }

  if (submission.email_status === 'PENDING_SEND') sendFeedback_(submission, quiz);
  return { result: publicResult_(submission, quiz) };
}

// ----------------------------------------------------------------------------
// Admin API (requires the ADMIN_KEY script property)
// ----------------------------------------------------------------------------
function apiAdminOverview_() {
  const quizzes = readTable_(SHEETS.QUIZZES).map(normalizeQuiz_);
  const subs = readTable_(SHEETS.SUBMISSIONS).filter(function (s) { return s.status !== 'VOID'; });
  const sessions = readTable_(SHEETS.SESSIONS).filter(function (s) { return s.status === 'ACTIVE'; });
  return {
    quizzes: quizzes.map(function (q) {
      const qs = subs.filter(function (s) { return s.quiz_id === q.quiz_id; });
      const mean = qs.length ? qs.reduce(function (a, s) { return a + Number(s.pct); }, 0) / qs.length : null;
      return {
        id: q.quiz_id, title: q.title, active: q.active, durationMin: q.duration_min,
        openAt: q.open_at ? q.open_at.getTime() : null, closeAt: q.close_at ? q.close_at.getTime() : null,
        windowState: windowState_(q, new Date()), questionCount: countQuestions_(q),
        submissions: qs.length, inProgress: sessions.filter(function (s) { return s.quiz_id === q.quiz_id; }).length,
        meanPct: mean === null ? null : round_(mean, 1),
      };
    }),
    mailQuota: MailApp.getRemainingDailyQuota(),
  };
}

function apiAdminResults_(req) {
  const quiz = getQuiz_(req.quizId, true);
  const questions = getQuestions_(quiz.quiz_id).map(function (q) {
    return { id: q.q_id, type: q.type, text: q.text, points: q.points, options: q.options, answer: q.answerRaw };
  });
  const subs = readTable_(SHEETS.SUBMISSIONS).filter(function (s) { return s.quiz_id === quiz.quiz_id; })
    .map(function (s) {
      return {
        id: s.submission_id, submittedAt: toDate_(s.submitted_at).getTime(), email: s.email, name: s.name,
        studentId: s.student_id, score: Number(s.score), max: Number(s.max_score), pct: Number(s.pct),
        passed: s.passed === 'YES', durationSec: Number(s.duration_sec), violations: Number(s.violations),
        autoSubmitted: s.auto_submitted === 'YES', late: s.late === 'YES',
        flags: String(s.flags || '').split(',').filter(String), violationLog: safeJson_(s.violation_log, []),
        detail: safeJson_(s.detail, []), manualPending: s.manual_pending === 'YES',
        emailStatus: s.email_status, status: s.status,
      };
    });
  const now = Date.now();
  const live = readTable_(SHEETS.SESSIONS).filter(function (s) {
    return s.quiz_id === quiz.quiz_id && s.status === 'ACTIVE';
  }).map(function (s) {
    return {
      email: s.email, name: s.name, startedAt: toDate_(s.started_at).getTime(),
      expiresAt: toDate_(s.expires_at).getTime(), lastSeen: toDate_(s.last_seen).getTime(),
      violations: Number(s.violations), answered: Object.keys(safeJson_(s.draft_answers, {})).length,
      total: safeJson_(s.question_ids, []).length,
      expired: now > toDate_(s.expires_at).getTime() + CONFIG.GRACE_SECONDS * 1000,
      violationLog: safeJson_(s.violation_log, []),
    };
  });
  return {
    quiz: {
      id: quiz.quiz_id, title: quiz.title, passMarkPct: quiz.pass_mark_pct, durationMin: quiz.duration_min,
      feedbackMode: quiz.feedback_mode, feedbackRelease: quiz.feedback_release,
      closeAt: quiz.close_at ? quiz.close_at.getTime() : null, maxViolations: quiz.max_violations,
    },
    questions: questions, submissions: subs, live: live,
  };
}

function apiAdminSendFeedback_(req) {
  const quiz = getQuiz_(req.quizId, true);
  const ids = Array.isArray(req.submissionIds) ? req.submissionIds : null;
  const subs = readTable_(SHEETS.SUBMISSIONS).filter(function (s) {
    if (s.quiz_id !== quiz.quiz_id || s.status === 'VOID') return false;
    if (ids) return ids.indexOf(s.submission_id) >= 0;           // explicit (re)send
    return s.email_status !== 'SENT' && s.email_status !== 'DISABLED';
  });
  let sent = 0, failed = 0;
  subs.forEach(function (s) { if (sendFeedback_(s, quiz)) sent++; else failed++; });
  return { sent: sent, failed: failed };
}

function apiAdminVoid_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sub = readTable_(SHEETS.SUBMISSIONS).filter(function (s) { return s.submission_id === req.submissionId; })[0];
    if (!sub) userError_('Submission not found.');
    updateRow_(SHEETS.SUBMISSIONS, sub._row, { status: 'VOID' });
    readTable_(SHEETS.SESSIONS).forEach(function (s) {
      if (s.quiz_id === sub.quiz_id && s.email === sub.email && s.status !== 'VOID') {
        updateRow_(SHEETS.SESSIONS, s._row, { status: 'VOID' });
      }
    });
    return { voided: true };
  } finally {
    lock.releaseLock();
  }
}

/** Manually set points/comment on one question (essays, or overriding the auto-grade). */
function apiAdminGrade_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sub = readTable_(SHEETS.SUBMISSIONS).filter(function (s) { return s.submission_id === req.submissionId; })[0];
    if (!sub) userError_('Submission not found.');
    const quiz = getQuiz_(sub.quiz_id, true);
    const detail = safeJson_(sub.detail, []);
    const item = detail.filter(function (d) { return d.id === req.qId; })[0];
    if (!item) userError_('Question not in this attempt.');
    const pts = Number(req.points);
    if (!isFinite(pts) || pts < 0 || pts > item.points) userError_('Points must be between 0 and ' + item.points + '.');
    item.earned = pts;
    item.correct = pts >= item.points ? true : (pts > 0 ? 'partial' : false);
    item.manual = false;
    item.graded_by_instructor = true;
    if (req.comment !== undefined) item.comment = String(req.comment).slice(0, 2000);
    const score = round_(detail.reduce(function (a, d) { return a + (Number(d.earned) || 0); }, 0), 4);
    const max = Number(sub.max_score);
    const pct = max ? round_(100 * score / max, 2) : 0;
    const pending = detail.some(function (d) { return d.manual; });
    const patch = {
      detail: JSON.stringify(detail), score: score, pct: pct,
      passed: pct >= quiz.pass_mark_pct ? 'YES' : 'NO', manual_pending: pending ? 'YES' : 'NO',
    };
    if (!pending && sub.email_status === 'AWAITING_MANUAL_GRADING') patch.email_status = initialEmailStatus_(quiz, false);
    updateRow_(SHEETS.SUBMISSIONS, sub._row, patch);
    return { score: score, pct: pct, manualPending: pending, emailStatus: patch.email_status || sub.email_status };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// Grading (pure functions — unit-tested in tests/grading.test.js)
// ----------------------------------------------------------------------------
function gradeAttempt_(questions, answers) {
  let score = 0, max = 0, manualPending = false;
  const detail = questions.map(function (q) {
    const r = gradeQuestion_(q, answers ? answers[q.q_id] : undefined);
    max += q.points;
    score += r.earned;
    if (r.manual) manualPending = true;
    return {
      id: q.q_id, type: q.type, text: q.text, points: q.points, earned: r.earned, correct: r.correct,
      manual: !!r.manual, response: describeResponse_(q, answers ? answers[q.q_id] : undefined),
      correctAnswer: describeCorrect_(q), explanation: q.explanation || '',
    };
  });
  return { score: round_(score, 4), max: round_(max, 4), detail: detail, manualPending: manualPending };
}

function gradeQuestion_(q, response) {
  const pts = q.points;
  const empty = response === undefined || response === null || response === '' ||
    (Array.isArray(response) && !response.length);
  switch (q.type) {
    case 'mcq':
    case 'tf': {
      if (empty) return { earned: 0, correct: false };
      const ok = Number(response) === q.answerIdx[0];
      return { earned: ok ? pts : 0, correct: ok };
    }
    case 'multi': {
      if (empty) return { earned: 0, correct: false };
      const chosen = unique_((Array.isArray(response) ? response : [response]).map(Number));
      const correctSet = q.answerIdx;
      let hits = 0, wrong = 0;
      chosen.forEach(function (c) { if (correctSet.indexOf(c) >= 0) hits++; else wrong++; });
      const frac = Math.max(0, (hits - wrong) / correctSet.length);
      const earned = round_(pts * frac, 4);
      return { earned: earned, correct: frac === 1 ? true : (frac > 0 ? 'partial' : false) };
    }
    case 'numeric': {
      const x = parseNumber_(response);
      if (x === null) return { earned: 0, correct: false };
      const target = parseNumber_(q.answerRaw);
      const tol = String(q.tolerance === undefined || q.tolerance === null ? '' : q.tolerance).trim();
      let allowed;
      if (/%$/.test(tol)) allowed = Math.abs(target) * (parseNumber_(tol.slice(0, -1)) || 0) / 100;
      else allowed = tol === '' ? 1e-9 * Math.max(1, Math.abs(target)) : Math.abs(parseNumber_(tol) || 0);
      const ok = Math.abs(x - target) <= allowed + 1e-12;
      return { earned: ok ? pts : 0, correct: ok };
    }
    case 'short': {
      if (empty) return { earned: 0, correct: false };
      const given = normalizeText_(response);
      const ok = String(q.answerRaw).split('|').some(function (a) { return normalizeText_(a) === given; });
      return { earned: ok ? pts : 0, correct: ok };
    }
    case 'essay':
      return { earned: 0, correct: null, manual: !empty };
    default:
      return { earned: 0, correct: false };
  }
}

function describeResponse_(q, response) {
  if (response === undefined || response === null || response === '' ||
      (Array.isArray(response) && !response.length)) return '(no answer)';
  if (q.type === 'mcq' || q.type === 'tf' || q.type === 'multi') {
    const arr = Array.isArray(response) ? response : [response];
    return arr.map(function (i) { return q.options[Number(i)] !== undefined ? q.options[Number(i)] : '?'; }).join('; ');
  }
  return String(response).slice(0, 5000);
}

function describeCorrect_(q) {
  if (q.type === 'mcq' || q.type === 'tf' || q.type === 'multi') {
    return q.answerIdx.map(function (i) { return q.options[i]; }).join('; ');
  }
  if (q.type === 'numeric') return String(q.answerRaw) + (q.tolerance !== '' && q.tolerance !== undefined ? ' (± ' + q.tolerance + ')' : '');
  if (q.type === 'short') return String(q.answerRaw).split('|')[0];
  if (q.type === 'essay') return q.answerRaw ? String(q.answerRaw) : '(graded by instructor)';
  return '';
}

/** "3,14" "3.14" " 1 200,5 " "-2.5e-3" "50%" → number, else null. */
function parseNumber_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[\s  ]/g, '');
  if (!s) return null;
  let pct = false;
  if (/%$/.test(s)) { pct = true; s = s.slice(0, -1); }
  // Thousands separators only when unambiguous (two groups, or both separators):
  // "1,234.5" / "1,234,567" → English; "1.234,5" / "1.234.567" → European.
  // A single separator is always the decimal mark: "5.009" = 5.009, "3,14" = 3.14.
  if (/^[-+]?\d{1,3}((,\d{3}){2,}(\.\d+)?|(,\d{3})+\.\d+)$/.test(s)) s = s.replace(/,/g, '');
  else if (/^[-+]?\d{1,3}((\.\d{3}){2,}(,\d+)?|(\.\d{3})+,\d+)$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  return pct ? n / 100 : n;
}

function normalizeText_(s) {
  return String(s === undefined || s === null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}\-\s.]/gu, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

// ----------------------------------------------------------------------------
// Session helpers
// ----------------------------------------------------------------------------
function resumeSession_(session, quiz, userAgent, kind) {
  const ua = String(userAgent || '').slice(0, 300);
  const flags = String(session.flags || '').split(',').filter(String);
  if (ua && session.user_agent && ua !== session.user_agent) flags.push('device_changed');
  session.flags = unique_(flags).join(',');
  session.resumes = (Number(session.resumes) || 0) + 1;
  recordViolation_(session, 'reload', kind === 'restart' ? 'Re-entered via start page' : 'Page reloaded');
  updateRow_(SHEETS.SESSIONS, session._row, { flags: session.flags, resumes: session.resumes, last_seen: new Date() });
  const pool = getQuestions_(quiz.quiz_id);
  const byId = {};
  pool.forEach(function (q) { byId[q.q_id] = q; });
  const selected = safeJson_(session.question_ids, []).map(function (id) { return byId[id]; }).filter(Boolean);
  return sessionPayload_(session, quiz, selected, safeJson_(session.draft_answers, {}));
}

function sessionPayload_(session, quiz, selected, draft) {
  const orders = safeJson_(session.option_orders, {});
  return {
    token: session.token,
    student: { name: session.name, email: session.email, studentId: session.student_id },
    quiz: {
      id: quiz.quiz_id, title: quiz.title, navigation: quiz.navigation, maxViolations: quiz.max_violations,
      feedbackRelease: quiz.feedback_release,
    },
    startedAt: toDate_(session.started_at).getTime(),
    expiresAt: toDate_(session.expires_at).getTime(),
    violations: Number(session.violations) || 0,
    draft: draft || {},
    // NOTE: no answers, tolerances or explanations are sent to the browser.
    questions: selected.map(function (q) {
      const order = orders[q.q_id] || range_(q.options.length);
      return {
        id: q.q_id, type: q.type, text: q.text, points: q.points,
        options: order.map(function (i) { return { i: i, t: q.options[i] }; }),
      };
    }),
  };
}

function recordViolation_(session, type, detail, skipWrite) {
  type = String(type || 'unknown').replace(/[^a-z_]/gi, '').slice(0, 40) || 'unknown';
  const log = safeJson_(session.violation_log, []);
  const counted = CONFIG.COUNTED_VIOLATIONS.indexOf(type) >= 0;
  if (log.length < 300) log.push({ t: Date.now(), type: type, detail: String(detail || '').slice(0, 120), counted: counted });
  session.violation_log = JSON.stringify(log);
  if (counted) session.violations = (Number(session.violations) || 0) + 1;
  if (!skipWrite) {
    updateRow_(SHEETS.SESSIONS, session._row, {
      violation_log: session.violation_log, violations: session.violations, last_seen: new Date(),
    });
  }
  return counted;
}

function getActiveSession_(token) {
  const s = findSessionByToken_(token);
  if (!s) userError_('Session not found. Please start again.', 'NO_SESSION');
  if (s.status === 'SUBMITTED') userError_('This attempt has already been submitted.', 'ALREADY_SUBMITTED');
  if (s.status !== 'ACTIVE') userError_('This attempt is no longer active.', 'INACTIVE');
  return s;
}

function findSessionByToken_(token) {
  if (!token || !/^[0-9a-f-]{36}$/i.test(String(token))) return null;
  const sh = sheet_(SHEETS.SESSIONS);
  const cell = sh.getRange('A:A').createTextFinder(String(token)).matchEntireCell(true).findNext();
  if (!cell) return null;
  return rowToObject_(SHEETS.SESSIONS, cell.getRow());
}

function findSession_(pred) {
  return readTable_(SHEETS.SESSIONS).filter(pred)[0] || null;
}

function findSubmission_(quizId, email) {
  return readTable_(SHEETS.SUBMISSIONS).filter(function (s) {
    return s.quiz_id === quizId && s.email === email && s.status !== 'VOID';
  })[0] || null;
}

function publicResult_(sub, quiz) {
  const showScore = quiz.feedback_release === 'immediate' && quiz.feedback_mode !== 'none' && sub.manual_pending !== 'YES';
  return {
    submissionId: sub.submission_id,
    showScore: showScore,
    score: showScore ? Number(sub.score) : null,
    max: showScore ? Number(sub.max_score) : null,
    pct: showScore ? Number(sub.pct) : null,
    passed: showScore ? sub.passed === 'YES' : null,
    emailStatus: sub.email_status,
    email: sub.email,
  };
}

// ----------------------------------------------------------------------------
// Feedback e-mail
// ----------------------------------------------------------------------------
function initialEmailStatus_(quiz, manualPending) {
  if (quiz.feedback_mode === 'none') return 'DISABLED';
  if (manualPending) return 'AWAITING_MANUAL_GRADING';
  if (quiz.feedback_release === 'immediate') return 'PENDING_SEND';
  if (quiz.feedback_release === 'after_close') return 'QUEUED';
  return 'HELD';  // 'manual' — instructor releases from the dashboard
}

function sendFeedback_(sub, quiz) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('daily e-mail quota exhausted');
    const detail = safeJson_(sub.detail, []);
    MailApp.sendEmail({
      to: sub.email,
      subject: '[' + CONFIG.COURSE_NAME + '] Your result — ' + quiz.title,
      name: CONFIG.COURSE_NAME,
      replyTo: CONFIG.REPLY_TO || undefined,
      htmlBody: feedbackHtml_(sub, quiz, detail),
    });
    sub.email_status = 'SENT ' + new Date().toISOString().slice(0, 16);
    updateRow_(SHEETS.SUBMISSIONS, sub._row, { email_status: sub.email_status });
    return true;
  } catch (err) {
    sub.email_status = 'FAILED: ' + String(err.message).slice(0, 80);
    updateRow_(SHEETS.SUBMISSIONS, sub._row, { email_status: sub.email_status });
    return false;
  }
}

function feedbackHtml_(sub, quiz, detail) {
  const passed = sub.passed === 'YES';
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;color:#222">' +
    '<h2 style="margin:0 0 4px">' + esc_(quiz.title) + '</h2>' +
    '<p style="margin:0 0 16px;color:#666">' + esc_(sub.name) + (sub.student_id ? ' · ' + esc_(sub.student_id) : '') +
    ' · submitted ' + esc_(Utilities.formatDate(toDate_(sub.submitted_at), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')) +
    ' · ref ' + esc_(sub.submission_id) + '</p>' +
    '<table style="border-collapse:collapse;margin-bottom:16px"><tr>' +
    '<td style="padding:10px 16px;background:#f3f5f8;border-radius:6px"><div style="font-size:12px;color:#666">Score</div>' +
    '<div style="font-size:24px;font-weight:bold">' + fmt_(sub.score) + ' / ' + fmt_(sub.max_score) + '</div></td>' +
    '<td style="width:12px"></td>' +
    '<td style="padding:10px 16px;background:#f3f5f8;border-radius:6px"><div style="font-size:12px;color:#666">Percentage</div>' +
    '<div style="font-size:24px;font-weight:bold">' + fmt_(sub.pct) + '%</div></td>' +
    '<td style="width:12px"></td>' +
    '<td style="padding:10px 16px;background:' + (passed ? '#e7f6ea' : '#fdecec') + ';border-radius:6px">' +
    '<div style="font-size:12px;color:#666">Result</div><div style="font-size:24px;font-weight:bold">' +
    (passed ? '✔ Pass' : '✖ Below pass mark') + '</div></td></tr></table>';

  if (Number(sub.violations) > 0 || sub.auto_submitted === 'YES' || sub.late === 'YES') {
    html += '<p style="padding:8px 12px;background:#fff6e0;border-radius:6px">Integrity note: ' +
      Number(sub.violations) + ' recorded violation(s)' + (sub.auto_submitted === 'YES' ? ', auto-submitted' : '') +
      (sub.late === 'YES' ? ', submitted after the deadline' : '') + '. Your instructor can see this log.</p>';
  }

  if (quiz.feedback_mode === 'detailed') {
    html += '<h3 style="margin:20px 0 8px">Question-by-question feedback</h3>';
    detail.forEach(function (d, i) {
      const color = d.correct === true ? '#1e7b34' : d.correct === 'partial' ? '#9a6700' : d.correct === null ? '#555' : '#b42318';
      const label = d.correct === true ? 'Correct' : d.correct === 'partial' ? 'Partially correct' : d.manual ? 'Awaiting grading' : d.correct === null ? 'Graded' : 'Incorrect';
      html += '<div style="border:1px solid #e3e3e3;border-radius:6px;padding:10px 12px;margin-bottom:8px">' +
        '<div style="font-weight:bold">Q' + (i + 1) + '. ' + esc_(d.text) + '</div>' +
        '<div style="margin-top:6px"><span style="color:' + color + ';font-weight:bold">' + label + '</span> — ' +
        fmt_(d.earned) + ' / ' + fmt_(d.points) + ' pt</div>' +
        '<div style="margin-top:4px"><b>Your answer:</b> ' + esc_(d.response) + '</div>' +
        (d.type !== 'essay' ? '<div><b>Correct answer:</b> ' + esc_(d.correctAnswer) + '</div>' : '') +
        (d.explanation ? '<div style="margin-top:4px;color:#444"><b>Explanation:</b> ' + esc_(d.explanation) + '</div>' : '') +
        (d.comment ? '<div style="margin-top:4px;color:#444"><b>Instructor comment:</b> ' + esc_(d.comment) + '</div>' : '') +
        '</div>';
    });
  }
  html += '<p style="color:#888;font-size:12px;margin-top:20px">Automated message from the ' +
    esc_(CONFIG.COURSE_NAME) + ' assessment system. Mathematical notation is shown in LaTeX source form.</p></div>';
  return html;
}

/** Time-driven trigger (installed by setup): releases 'after_close' feedback once a quiz has closed. */
function sendQueuedFeedback() {
  const now = new Date();
  const quizzes = {};
  readTable_(SHEETS.QUIZZES).map(normalizeQuiz_).forEach(function (q) { quizzes[q.quiz_id] = q; });
  readTable_(SHEETS.SUBMISSIONS).forEach(function (s) {
    const q = quizzes[s.quiz_id];
    if (!q || s.status === 'VOID' || s.email_status !== 'QUEUED') return;
    if (q.close_at && q.close_at <= now) sendFeedback_(s, q);
  });
}

// ----------------------------------------------------------------------------
// Quiz / question loading
// ----------------------------------------------------------------------------
function getQuiz_(quizId, adminMode) {
  const id = String(quizId || '').trim();
  if (!id) userError_('Missing quiz id.');
  const row = readTable_(SHEETS.QUIZZES).filter(function (q) { return String(q.quiz_id).trim() === id; })[0];
  if (!row) userError_('Quiz not found.');
  const quiz = normalizeQuiz_(row);
  if (!quiz.active && !adminMode) userError_('This assessment is not active.');
  return quiz;
}

function normalizeQuiz_(r) {
  const nav = String(r.navigation || 'free').toLowerCase();
  const mode = String(r.feedback_mode || 'detailed').toLowerCase();
  const rel = String(r.feedback_release || 'immediate').toLowerCase();
  return {
    _row: r._row,
    quiz_id: String(r.quiz_id).trim(),
    title: String(r.title || r.quiz_id),
    instructions: String(r.instructions || ''),
    access_code: String(r.access_code || '').trim(),
    duration_min: Math.max(1, Number(r.duration_min) || 30),
    open_at: toDate_(r.open_at),
    close_at: toDate_(r.close_at),
    questions_per_student: Math.max(0, Math.floor(Number(r.questions_per_student) || 0)),
    shuffle_questions: bool_(r.shuffle_questions, true),
    shuffle_options: bool_(r.shuffle_options, true),
    navigation: nav === 'forward_only' ? 'forward_only' : 'free',
    max_violations: r.max_violations === '' || r.max_violations === undefined ? 3 : Math.max(0, Number(r.max_violations) || 0),
    pass_mark_pct: r.pass_mark_pct === '' || r.pass_mark_pct === undefined ? 50 : Number(r.pass_mark_pct),
    feedback_mode: ['none', 'score', 'detailed'].indexOf(mode) >= 0 ? mode : 'detailed',
    feedback_release: ['immediate', 'after_close', 'manual'].indexOf(rel) >= 0 ? rel : 'immediate',
    allowed_domain: String(r.allowed_domain || '').trim().toLowerCase().replace(/^@/, ''),
    require_roster: bool_(r.require_roster, false),
    require_email_code: bool_(r.require_email_code, true),
    active: bool_(r.active, true),
  };
}

function getQuestions_(quizId) {
  return readTable_(SHEETS.QUESTIONS)
    .filter(function (q) { return String(q.quiz_id).trim() === quizId && String(q.q_id).trim() !== ''; })
    .map(normalizeQuestion_);
}

function countQuestions_(quiz) {
  const n = getQuestions_(quiz.quiz_id).length;
  return quiz.questions_per_student ? Math.min(n, quiz.questions_per_student) : n;
}

function normalizeQuestion_(r) {
  const type = String(r.type || 'mcq').trim().toLowerCase();
  let options = String(r.options || '').split('|').map(function (s) { return s.trim(); }).filter(String);
  let answerIdx = [];
  const raw = r.answer === true ? 'TRUE' : r.answer === false ? 'FALSE' : String(r.answer === undefined ? '' : r.answer).trim();
  if (type === 'tf') {
    options = ['True', 'False'];
    answerIdx = [/^(t|true|vrai|v|yes|1)$/i.test(raw) ? 0 : 1];
  } else if (type === 'mcq' || type === 'multi') {
    answerIdx = raw.split(/[,;\s]+/).filter(String).map(function (tok) {
      if (/^[A-Za-z]$/.test(tok)) return tok.toUpperCase().charCodeAt(0) - 65;   // letter A,B,C…
      if (/^\d+$/.test(tok)) return Number(tok) - 1;                              // or 1-based number
      return options.indexOf(tok);
    }).filter(function (i) { return i >= 0 && i < options.length; });
    if (type === 'mcq') answerIdx = answerIdx.slice(0, 1);
  } else {
    options = [];
  }
  return {
    q_id: String(r.q_id).trim(),
    type: type,
    text: String(r.text || ''),
    options: options,
    answerRaw: raw,
    answerIdx: answerIdx,
    points: Number(r.points) > 0 ? Number(r.points) : 1,
    tolerance: r.tolerance === undefined || r.tolerance === null ? '' : String(r.tolerance).trim(),
    explanation: String(r.explanation || ''),
  };
}

// ----------------------------------------------------------------------------
// Validation helpers
// ----------------------------------------------------------------------------
function windowState_(quiz, now) {
  if (!quiz.active) return 'inactive';
  if (quiz.open_at && now < quiz.open_at) return 'not_open';
  if (quiz.close_at && now >= quiz.close_at) return 'closed';
  return 'open';
}

function assertWindowOpen_(quiz) {
  const st = windowState_(quiz, new Date());
  if (st === 'not_open') userError_('This assessment is not open yet.');
  if (st === 'closed') userError_('This assessment is closed.');
  if (st === 'inactive') userError_('This assessment is not active.');
}

function cleanEmail_(e) {
  const email = String(e || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) userError_('Please enter a valid e-mail address.');
  return email;
}

function assertDomain_(quiz, email) {
  if (quiz.allowed_domain) {
    const doms = quiz.allowed_domain.split(/[,;\s]+/).filter(String);
    const d = email.split('@')[1];
    if (!doms.some(function (x) { return d === x || d.slice(-(x.length + 1)) === '.' + x; })) {
      userError_('Please use your institutional e-mail (@' + doms.join(', @') + ').');
    }
  }
}

function assertRoster_(quiz, email) {
  const r = readTable_(SHEETS.ROSTER).filter(function (x) {
    const qid = String(x.quiz_id || '').trim();
    return (qid === '' || qid === '*' || qid === quiz.quiz_id) && String(x.email).trim().toLowerCase() === email;
  })[0];
  if (!r) userError_('This e-mail is not on the class list for this assessment.');
  return r;
}

function otpKey_(quizId, email) { return 'otp:' + quizId + ':' + email; }

function verifyOtp_(quizId, email, code) {
  const cache = CacheService.getScriptCache();
  const key = otpKey_(quizId, email);
  const rec = safeJson_(cache.get(key), null);
  if (!rec) userError_('Verification code missing or expired. Request a new code.');
  if (String(code || '').trim() !== rec.code) {
    rec.tries++;
    if (rec.tries >= CONFIG.OTP_MAX_TRIES) cache.remove(key);
    else cache.put(key, JSON.stringify(rec), CONFIG.OTP_TTL_SECONDS);
    userError_('Incorrect verification code.');
  }
  cache.remove(key); // single use
}

function requireAdmin_(key) {
  const real = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!real) userError_('ADMIN_KEY not configured. Run setup() in the Apps Script editor.');
  const a = String(key || ''), b = String(real);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (diff !== 0) {
    Utilities.sleep(400);
    userError_('Invalid admin key.', 'BAD_KEY');
  }
}

// ----------------------------------------------------------------------------
// Sheet I/O
// ----------------------------------------------------------------------------
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) userError_('Sheet "' + name + '" missing. Run setup().');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0].map(function (h) { return String(h).trim(); });
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const o = { _row: r + 1 };
    let any = false;
    head.forEach(function (h, c) {
      if (!h) return;
      o[h] = values[r][c];
      if (values[r][c] !== '' && values[r][c] !== null) any = true;
    });
    if (o.email !== undefined) o.email = String(o.email).trim().toLowerCase();
    if (o.quiz_id !== undefined) o.quiz_id = String(o.quiz_id).trim();
    if (any) out.push(o);
  }
  return out;
}

function rowToObject_(name, row) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const vals = sh.getRange(row, 1, 1, head.length).getValues()[0];
  const o = { _row: row };
  head.forEach(function (h, i) { if (h) o[String(h).trim()] = vals[i]; });
  if (o.email !== undefined) o.email = String(o.email).trim().toLowerCase();
  if (o.quiz_id !== undefined) o.quiz_id = String(o.quiz_id).trim();
  return o;
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
  return sh.getLastRow();
}

function updateRow_(name, row, patch) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(patch).forEach(function (k) {
    const c = head.indexOf(k);
    if (c >= 0) sh.getRange(row, c + 1).setValue(patch[k]);
  });
}

// ----------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function userError_(msg, code) { const e = new Error(msg); e.userFacing = true; e.code = code; throw e; }
function safeJson_(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } }
function toDate_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function bool_(v, dflt) {
  if (v === true || v === false) return v;
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (s === '') return dflt;
  return ['true', 'yes', 'y', '1', 'oui', 'x'].indexOf(s) >= 0;
}
function range_(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; }
function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function unique_(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function round_(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }
function fmt_(x) { return String(round_(Number(x) || 0, 2)); }
function esc_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ----------------------------------------------------------------------------
// One-time setup, menu and admin utilities (run from the Apps Script editor)
// ----------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Quiz Platform')
    .addItem('Run setup / repair sheets', 'setup')
    .addItem('Show admin key', 'showAdminKey')
    .addItem('Rotate admin key', 'rotateAdminKey')
    .addItem('Send queued feedback now', 'sendQueuedFeedback')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const existing = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    const missing = HEADERS[name].filter(function (h) { return existing.indexOf(h) < 0; });
    if (!existing.filter(String).length) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    } else if (missing.length) {
      sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#e8eef7');
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (readTable_(SHEETS.QUIZZES).length === 0) seedDemo_();

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, ''));

  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sendQueuedFeedback'; });
  if (!has) ScriptApp.newTrigger('sendQueuedFeedback').timeBased().everyHours(1).create();

  const msg = 'Setup complete.\n\nADMIN KEY (keep secret, paste into the dashboard):\n' + props.getProperty('ADMIN_KEY') +
    '\n\nNext: Deploy → New deployment → Web app → Execute as "Me", Who has access "Anyone".';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from editor without UI */ }
}

function showAdminKey() {
  const k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  console.log(k);
  try { SpreadsheetApp.getUi().alert('Admin key:\n' + k); } catch (e) { }
}

function rotateAdminKey() {
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, ''));
  showAdminKey();
}

function seedDemo_() {
  const now = new Date();
  const close = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  appendRow_(SHEETS.QUIZZES, {
    quiz_id: 'DEMO-MACRO', title: 'Demo quiz — New Keynesian & RBC models',
    instructions: 'Answer all questions. Numeric answers accept a comma or a dot as decimal separator. Calculators are allowed.',
    access_code: 'DSGE2026', duration_min: 20, open_at: now, close_at: close, questions_per_student: 0,
    shuffle_questions: true, shuffle_options: true, navigation: 'free', max_violations: 3, pass_mark_pct: 50,
    feedback_mode: 'detailed', feedback_release: 'immediate', allowed_domain: '', require_roster: false,
    require_email_code: true, active: true,
  });
  const Q = [
    ['DEMO-MACRO', 'Q1', 'mcq', 'In the New Keynesian Phillips curve $\\pi_t = \\beta E_t \\pi_{t+1} + \\kappa \\tilde{y}_t$, a higher Calvo parameter $\\theta$ (more price stickiness) implies that $\\kappa$:',
      'increases|decreases|is unaffected|becomes negative', 'B', 2, '', 'κ = (1−θ)(1−βθ)/θ·(σ+φ)… is decreasing in θ: stickier prices flatten the Phillips curve.'],
    ['DEMO-MACRO', 'Q2', 'tf', 'With King–Plosser–Rebelo (balanced-growth) preferences, a permanent rise in the level of TFP leaves steady-state hours worked unchanged.',
      '', 'TRUE', 1, '', 'Income and substitution effects cancel under balanced-growth preferences.'],
    ['DEMO-MACRO', 'Q3', 'numeric', 'Taylor rule: $i_t = r^* + \\pi_t + 0.5(\\pi_t - \\pi^*) + 0.5\\,\\tilde{y}_t$ with $r^*=2$, $\\pi_t=3$, $\\pi^*=2$ and $\\tilde{y}_t=-1$ (all in %). What is $i_t$ (in %)?',
      '', '5', 2, '0.01', '2 + 3 + 0.5(1) + 0.5(−1) = 5.'],
    ['DEMO-MACRO', 'Q4', 'multi', 'Which equations belong to the canonical three-equation New Keynesian model? (select all that apply)',
      'Dynamic IS curve|New Keynesian Phillips curve|Interest-rate (Taylor-type) rule|Capital accumulation equation', 'A,B,C', 3, '', 'The canonical model has no capital.'],
    ['DEMO-MACRO', 'Q5', 'short', 'Blanchard–Kahn: a unique stable solution requires the number of unstable eigenvalues to equal the number of ______ variables.',
      '', 'forward-looking|forward looking|jump|non-predetermined|non predetermined|jump variables|forward-looking variables', 2, '', 'Forward-looking (jump / non-predetermined) variables.'],
    ['DEMO-MACRO', 'Q6', 'numeric', 'RBC steady state with $\\beta=0.99$, $\\delta=0.025$, $\\alpha=0.33$. Compute the capital–output ratio $K/Y = \\alpha / (1/\\beta - 1 + \\delta)$ (quarterly). Two decimals.',
      '', '9.40', 2, '1%', '1/0.99 − 1 + 0.025 = 0.0351, and 0.33/0.0351 ≈ 9.40.'],
    ['DEMO-MACRO', 'Q7', 'mcq', 'With a quarterly Calvo parameter $\\theta = 0.75$, the expected duration of a price spell is:',
      '3 quarters|4 quarters|0.75 quarters|1.33 quarters', 'B', 1, '', 'Expected duration = 1/(1−θ) = 4 quarters.'],
    ['DEMO-MACRO', 'Q8', 'essay', 'Explain in a few sentences why the Taylor principle ($\\phi_\\pi > 1$) delivers determinacy in the basic NK model.',
      '', 'Real-rate rises more than one-for-one with inflation; rules out self-fulfilling sunspot paths (BK conditions satisfied).', 4, '', ''],
  ];
  const sh = sheet_(SHEETS.QUESTIONS);
  sh.getRange(2, 1, Q.length, Q[0].length).setValues(Q);
}
