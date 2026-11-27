/**
 * In-memory stand-ins for the Google Apps Script services used by Code.gs
 * (SpreadsheetApp, CacheService, LockService, MailApp, …). Lets the real
 * backend run unchanged under Node for tests and local previews.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

class FakeRange {
  constructor(sheet, row, col, nRows, nCols) {
    Object.assign(this, { sheet, row, col, nRows, nCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nRows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  getRow() { return this.row; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  createTextFinder(text) {
    const range = this;
    return {
      matchEntireCell() { return this; },
      findNext() {
        const last = range.sheet.getLastRow();
        for (let r = 1; r <= last; r++) {
          const v = (range.sheet.data[r - 1] || [])[range.col - 1];
          if (String(v) === String(text)) return new FakeRange(range.sheet, r, range.col, 1, 1);
        }
        return null;
      },
    };
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    const line = this.data[row - 1];
    while (line.length < col) line.push('');
    // Sheets turn ISO-ish date strings into Date objects only via the UI; keep values as given.
    line[col - 1] = v;
  }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) {
      if ((this.data[r - 1] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r;
    }
    return 0;
  }
  getLastColumn() { return this.data.reduce((m, l) => Math.max(m, l.length), 0); }
  getDataRange() { return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+):\1$/i.exec(a);
      if (!m) throw new Error('Unsupported A1 range ' + a);
      return new FakeRange(this, 1, colToIndex(m[1]), Math.max(1, this.getLastRow()), 1);
    }
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  appendRow(values) { const r = this.getLastRow() + 1; values.forEach((v, i) => this.set(r, i + 1, v)); }
  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor() { this.sheets = [new FakeSheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

function createRuntime(opts = {}) {
  const ss = new FakeSpreadsheet();
  const outbox = [];
  const props = {};
  const cache = new Map();
  const clock = { offsetMs: 0 };
  const RealDate = Date;

  // A Date whose "now" can be shifted forward to test deadlines.
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + clock.offsetMs).toString();
    if (args.length === 0) return new RealDate(RealDate.now() + clock.offsetMs);
    return new RealDate(...args);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = () => RealDate.now() + clock.offsetMs;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;

  const context = {
    console: opts.quiet ? { log() {}, error() {}, warn() {} } : console,
    Date: ShiftedDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => { throw new Error('No UI in tests'); },
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => { const e = cache.get(k); if (!e) return null; if (e.exp < ShiftedDate.now()) { cache.delete(k); return null; } return e.v; },
        put: (k, v, ttl) => { cache.set(k, { v: String(v), exp: ShiftedDate.now() + (ttl || 600) * 1000 }); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
      }),
    },
    MailApp: {
      sendEmail: (m) => {
        if (opts.failMail) throw new Error('mail down');
        outbox.push(m);
        if (opts.onMail) opts.onMail(m);
      },
      getRemainingDailyQuota: () => 100 - outbox.length,
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
      formatDate: (d) => new RealDate(d).toISOString().slice(0, 16).replace('T', ' '),
    },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => { const t = { timeBased: () => t, everyHours: () => t, create: () => t }; return t; },
    },
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, context, { filename: 'Code.gs' });

  function call(action, payload) {
    const out = context.doPost({ postData: { contents: JSON.stringify(Object.assign({ action }, payload || {})) } });
    return JSON.parse(out.getContent());
  }

  return { context, ss, outbox, props, cache, clock, call, sheet: (n) => ss.getSheetByName(n) };
}

module.exports = { createRuntime };
