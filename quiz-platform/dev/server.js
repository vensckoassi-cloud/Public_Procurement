#!/usr/bin/env node
/**
 * Local preview server — runs the real Code.gs against an in-memory sheet.
 *
 *   node dev/server.js            → http://localhost:8787
 *
 * Student page : http://localhost:8787/student/quiz.html?quiz=DEMO-MACRO&api=http://localhost:8787/api
 * Dashboard    : http://localhost:8787/teacher/dashboard.html?api=http://localhost:8787/api
 * E-mails are printed in this terminal instead of being sent (also at /__mail).
 * Nothing is saved: restart = fresh demo data.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRuntime } = require('./fake-gas');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');
const quiet = process.argv.includes('--quiet');

const rt = createRuntime({
  quiet: true,
  onMail: (m) => {
    if (quiet) return;
    const text = String(m.htmlBody).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('\n📧  To: ' + m.to + '\n    Subject: ' + m.subject + '\n    ' + text.slice(0, 300) + (text.length > 300 ? '…' : ''));
  },
});
rt.context.setup();
const ADMIN_KEY = rt.props.ADMIN_KEY;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const out = rt.context.doPost({ postData: { contents: body } });
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(out.getContent());
    });
    return;
  }
  if (url.pathname === '/__mail') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    return res.end(JSON.stringify(rt.outbox));
  }
  if (url.pathname === '/__admin_key') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(ADMIN_KEY);
  }
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) { res.writeHead(302, { Location: '/student/quiz.html?quiz=DEMO-MACRO&api=http://localhost:' + PORT + '/api' }); return res.end(); }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  if (quiet) return;
  const api = 'http://localhost:' + PORT + '/api';
  console.log('Quiz platform preview running.\n');
  console.log('  Student : http://localhost:' + PORT + '/student/quiz.html?quiz=DEMO-MACRO&api=' + api);
  console.log('            (access code DSGE2026 — the e-mail verification code is printed below)');
  console.log('  Teacher : http://localhost:' + PORT + '/teacher/dashboard.html?api=' + api);
  console.log('  Admin key: ' + ADMIN_KEY + '\n');
});

module.exports = { server, rt, ADMIN_KEY };
