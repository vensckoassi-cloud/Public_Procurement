#!/usr/bin/env node
/**
 * Browser end-to-end check (Playwright + Chromium):
 *   student registers → verifies e-mail → takes exam → violation recorded →
 *   submits → dashboard shows the graded, flagged attempt.
 * Usage: node tests/e2e.js [screenshotDir]
 */
'use strict';
process.env.PORT = process.env.PORT || '8799';
const assert = require('assert/strict');
const path = require('path');
const { chromium } = require('playwright');
const { server, rt, ADMIN_KEY } = (() => { process.argv.push('--quiet'); return require('../dev/server'); })();

const BASE = 'http://localhost:' + process.env.PORT;
const API = BASE + '/api';
const shots = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

(async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    // Optional: serve KaTeX from a local npm install when the CDN is unreachable (sandboxed CI).
    if (process.env.KATEX_DIR) {
      const fs = require('fs');
      ctx._katexRoute = (route) => {
        const rel = new URL(route.request().url()).pathname.split('/0.16.9/')[1];
        const file = path.join(process.env.KATEX_DIR, rel);
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'font/woff2';
        route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: type });
      };
      await ctx.route('https://cdnjs.cloudflare.com/**', ctx._katexRoute);
    }
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(BASE + '/student/quiz.html?quiz=DEMO-MACRO&api=' + encodeURIComponent(API));
    await page.waitForSelector('#screen-intro:not(.hidden)');
    assert.match(await page.textContent('#intro-title'), /New Keynesian/);
    if (shots) await page.screenshot({ path: path.join(shots, '1-intro.png'), fullPage: true });

    await page.fill('#f-name', 'Grace Hopper');
    await page.fill('#f-email', 'grace@uni.edu');
    await page.fill('#f-sid', 'S-2026-17');
    await page.fill('#f-access', 'DSGE2026');
    await page.click('#btn-code');
    await page.waitForFunction(() => /Code sent/.test(document.getElementById('intro-msg').textContent));
    const code = /code: (\d{6})/.exec(rt.outbox.find((m) => m.to === 'grace@uni.edu').subject)[1];
    await page.fill('#f-otp', code);
    await page.check('#f-honour');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-exam:not(.hidden)');

    // Some headless builds refuse fullscreen → the guard overlay appears; dismiss it.
    if (await page.isVisible('#guard')) await page.click('#guard-btn');
    await page.evaluate(() => { document.getElementById('guard').classList.add('hidden'); document.getElementById('exam-content').classList.remove('blurred'); });

    // The payload in the page must not contain answers.
    const bank = rt.context.getQuestions_('DEMO-MACRO');
    const n = await page.$$eval('#palette button', (b) => b.length);
    assert.equal(n, 8);

    // Answer every question correctly by looking up the server-side bank.
    const order = JSON.parse(rt.context.readTable_('Sessions')[0].question_ids);
    for (let i = 0; i < n; i++) {
      const q = bank.find((b) => b.q_id === order[i]);
      if (q.type === 'mcq' || q.type === 'tf') await page.check('input[name=opt][value="' + q.answerIdx[0] + '"]');
      else if (q.type === 'multi') for (const k of q.answerIdx) await page.check('input[name=opt][value="' + k + '"]');
      else if (q.type === 'numeric') await page.fill('#ans', q.answerRaw.replace('.', ','));
      else if (q.type === 'short') await page.fill('#ans', 'jump');
      else await page.fill('#ans', 'The real rate rises more than one-for-one with inflation.');
      if (i === 2 && shots) {
        await page.screenshot({ path: path.join(shots, '2-exam.png') });
      }
      if (i < n - 1) await page.click('#btn-next');
    }

    // Integrity: a blocked shortcut (minor) and a tab switch (counted).
    await page.keyboard.press('Control+c');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForSelector('#guard:not(.hidden)');
    assert.match(await page.textContent('#guard-text'), /left the assessment/);
    await page.waitForFunction(() => /Violations 1/.test(document.getElementById('viol-pill').textContent));
    if (shots) await page.screenshot({ path: path.join(shots, '3-guard.png') });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
    await page.click('#guard-btn');
    await page.evaluate(() => { document.getElementById('guard').classList.add('hidden'); document.getElementById('exam-content').classList.remove('blurred'); });

    await page.click('#btn-submit');
    await page.click('#confirm-yes');
    await page.waitForSelector('#screen-done:not(.hidden)');
    const done = await page.textContent('#done-body');
    assert.match(done, /recorded|e-mailed/);
    if (shots) await page.screenshot({ path: path.join(shots, '4-done.png') });

    const row = rt.context.readTable_('Submissions')[0];
    assert.equal(Number(row.score), 13, 'auto-graded score');   // essay pending
    assert.equal(Number(row.violations), 1);
    const log = JSON.parse(row.violation_log).map((v) => v.type);
    assert.ok(log.includes('blocked_shortcut') && log.includes('tab_hidden'), log.join(','));

    // ---------------- phone-width layout (second student) ----------------
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    if (process.env.KATEX_DIR) await phone.route('https://cdnjs.cloudflare.com/**', (r) => ctx._katexRoute ? ctx._katexRoute(r) : r.abort());
    const pp = await phone.newPage();
    await pp.goto(BASE + '/student/quiz.html?quiz=DEMO-MACRO&api=' + encodeURIComponent(API));
    await pp.waitForSelector('#screen-intro:not(.hidden)');
    assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'intro: no horizontal scroll on phone');
    await pp.fill('#f-name', 'Phone User'); await pp.fill('#f-email', 'phone@uni.edu'); await pp.fill('#f-access', 'DSGE2026');
    await pp.click('#btn-code');
    await pp.waitForFunction(() => /Code sent/.test(document.getElementById('intro-msg').textContent));
    await pp.fill('#f-otp', /code: (\d{6})/.exec(rt.outbox.filter((m) => m.to === 'phone@uni.edu').pop().subject)[1]);
    await pp.check('#f-honour'); await pp.click('#btn-start');
    await pp.waitForSelector('#screen-exam:not(.hidden)');
    await pp.evaluate(() => { document.getElementById('guard').classList.add('hidden'); document.getElementById('exam-content').classList.remove('blurred'); });
    assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'exam: no horizontal scroll on phone');
    if (shots) await pp.screenshot({ path: path.join(shots, '2b-exam-phone.png') });
    await phone.close();

    // ---------------- dashboard ----------------
    const dash = await ctx.newPage();
    dash.on('pageerror', (e) => { throw e; });
    await dash.goto(BASE + '/teacher/dashboard.html?api=' + encodeURIComponent(API));
    await dash.fill('#s-key', ADMIN_KEY);
    await dash.fill('#s-quizurl', 'https://example.org/quiz.html');
    await dash.click('#btn-connect');
    await dash.waitForSelector('#quiz-table tr.click');
    await dash.click('#quiz-table tr.click');
    await dash.waitForSelector('#results tr.click');
    assert.match(await dash.textContent('#results'), /Grace Hopper/);
    assert.match(await dash.textContent('#results'), /1 violation/);
    if (shots) await dash.screenshot({ path: path.join(shots, '5-dashboard.png'), fullPage: true });

    // Grade the essay from the student modal, then send feedback.
    await dash.click('#results tr.click');
    await dash.fill('.m-pts[data-q="Q8"]', '4');
    await dash.fill('.m-com[data-q="Q8"]', 'Excellent.');
    await dash.click('.m-save[data-q="Q8"]');
    await dash.waitForFunction(() => /New score 17/.test(document.getElementById('m-msg').textContent));
    if (shots) await dash.screenshot({ path: path.join(shots, '6-student-detail.png'), fullPage: true });
    await dash.click('#m-send');
    await dash.waitForFunction(() => /Feedback sent/.test(document.getElementById('m-msg').textContent));
    const mail = rt.outbox.find((m) => m.to === 'grace@uni.edu' && /Your result/.test(m.subject));
    assert.ok(mail, 'feedback e-mail sent');
    assert.match(mail.htmlBody, /17 \/ 17/);
    console.log('E2E OK — student flow, integrity logging, grading, dashboard and feedback e-mail all verified.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
