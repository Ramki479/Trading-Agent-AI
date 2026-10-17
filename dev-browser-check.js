#!/usr/bin/env node
/**
 * dev-browser-check.js — headless end-to-end check for the dashboard UI.
 *
 * Loads the dashboard in headless Chrome via the DevTools Protocol, waits
 * for the page to load and the first API poll to finish, then reports
 * whether the key regions rendered data and whether any console errors
 * occurred. Local dev/testing tool only.
 *
 * Usage:
 *   node agentd/dev-browser-check.js <dashboard-url>
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');

const URL = process.argv[2];
if (!URL) { console.error('usage: node dev-browser-check.js <dashboard-url>'); process.exit(1); }

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) { if (fs.existsSync(c)) return c; }
  return null;
}

const chrome = findChrome();
if (!chrome) { console.error('Chrome not found — set CHROME_PATH'); process.exit(1); }

const port = 9333 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, [
  '--headless', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + os.tmpdir() + '/dash-cdp-' + process.pid,
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function connect(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });
}

async function main() {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson('/json'); if (targets.length) break; } catch (_) {}
    await sleep(250);
  }
  if (!targets || !targets.length) throw new Error('chrome debugging endpoint not reachable');

  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await connect(ws);

  let msgId = 0;
  const pending = new Map();
  const network = [];
  const errors = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Network.responseReceived' && m.params.response && m.params.response.url.indexOf('/api/') >= 0) {
      network.push(m.params.response.status + ' ' + m.params.response.url);
    }
    if (m.method === 'Network.loadingFailed') {
      network.push('FAILED ' + m.params.errorText + ' ' + (m.params.requestId || ''));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params.exceptionDetails;
      errors.push('EXCEPTION: ' + ((ex.exception && ex.exception.description) || ex.text));
    }
  });

  const send = (method, params) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  const loaded = new Promise((resolve) => {
    const h = (ev) => { const m = JSON.parse(ev.data.toString()); if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); resolve(); } };
    ws.addEventListener('message', h);
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: URL });
  await Promise.race([loaded, sleep(15000)]);

  // Let the app's initial poll (and possibly a retry) settle.
  await sleep(2500);

  const evaluate = async (expression, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (!r.result) return { error: 'no result', raw: JSON.stringify(r).slice(0, 300) };
    if (r.result.exceptionDetails) {
      const ex = r.result.exceptionDetails;
      return { error: ((ex.exception && ex.exception.description) || ex.text || '').split('\n')[0] };
    }
    const v = r.result.result ? r.result.result.value : r.result.value;
    return { value: v };
  };
  const evalJson = async (expression) => {
    const r = await evaluate(expression);
    if (r.error) return { error: r.error };
    if (typeof r.value !== 'string') return { error: 'non-string value', raw: JSON.stringify(r.value).slice(0, 200) };
    try { return { data: JSON.parse(r.value) }; } catch (e) { return { error: 'json parse: ' + e.message }; }
  };

  const snap = await evalJson(`(function () {
    try {
      return JSON.stringify({
        href: location.href,
        conn: (document.getElementById('conn') || {}).textContent || null,
        connClass: (document.getElementById('conn') || {}).className || null,
        status: (document.getElementById('status-line') || {}).textContent || null,
        cards: document.querySelectorAll('#cards .card').length,
        firstCard: (function () { var c = document.querySelector('#cards .card'); return c ? c.textContent.replace(/\\s+/g, ' ').trim() : null; })(),
        liveCells: document.querySelectorAll('#live-grid .live-cell').length,
        positionRows: document.querySelectorAll('#positions-wrap tbody tr').length,
        tradeRows: document.querySelectorAll('#trades-wrap tbody tr').length,
        perfCells: document.querySelectorAll('#perf-grid .perf-cell').length,
        chartEmpty: (function () { var e = document.getElementById('chart-empty'); return !!e && !e.classList.contains('hidden'); })(),
        fxLine: (document.getElementById('fx-line') || {}).textContent || null,
        posFirst: (function () { var c = document.querySelector('#positions-wrap tbody tr'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : null; })(),
        tradeFirst: (function () { var c = document.querySelector('#trades-wrap tbody tr'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : null; })(),
        sysFxCell: (function () { var cs = document.querySelectorAll('#sys-grid .sys-cell'); for (var i = 0; i < cs.length; i++) { if ((cs[i].querySelector('.k') || {}).textContent === 'Exchange rate') return (cs[i].querySelector('.v') || {}).textContent || null; } return null; })(),
        perfBest: (function () { var cs = document.querySelectorAll('#perf-grid .perf-cell'); for (var i = 0; i < cs.length; i++) { if ((cs[i].querySelector('.k') || {}).textContent === 'Best trade') return (cs[i].querySelector('.v') || {}).textContent || null; } return null; })(),
        haltVisible: (function () { var b = document.getElementById('halt-banner'); return !!b && !b.classList.contains('hidden'); })(),
        haltText: (function () { var b = document.getElementById('halt-banner'); return b ? (b.textContent || '').slice(0, 160) : null; })(),
        dayPnl: (function () { var cs = document.querySelectorAll('#adaptive-grid .adaptive-cell'); for (var i = 0; i < cs.length; i++) { if ((cs[i].querySelector('.k') || {}).textContent === 'Day P&L') return (cs[i].querySelector('.v') || {}).textContent || null; } return null; })(),
        tradeHeaders: (function () { var r = document.querySelector('#trades-wrap thead tr'); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })(),
        candHeaders: (function () { var r = document.querySelector('#candidates-wrap thead tr'); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })(),
        posHeaders: (function () { var r = document.querySelector('#positions-wrap thead tr'); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })(),
        riskBars: document.querySelectorAll('#positions-wrap .pbar').length,
        reasonPills: document.querySelectorAll('#trades-wrap .pill').length
      });
    } catch (e) {
      return JSON.stringify({ fatal: String(e), href: location.href });
    }
  })()`);

  console.log('--- dashboard render check ---');
  if (snap.error) { console.log('evaluate error:', snap.error, snap.raw || ''); }
  else { console.log(JSON.stringify(snap.data, null, 2)); }

  console.log('--- api requests seen by the page ---');
  (network.length ? network : ['(none)']).slice(0, 10).forEach((n) => console.log(' ', n));

  console.log('--- console/page errors (' + errors.length + ') ---');
  (errors.length ? errors : ['(none)']).slice(0, 8).forEach((e) => console.log(' ', e));

  ws.close();
  proc.kill();
}

main()
  .then(() => setTimeout(() => process.exit(process.exitCode || 0), 200))
  .catch((err) => { console.error('FAILED:', err.message); try { proc.kill(); } catch (_) {} process.exit(1); });
