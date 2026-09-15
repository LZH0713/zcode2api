/**
 * ZCode 验证码 param 提供器 v2（零自动化痕迹）。
 *
 * 不用 puppeteer/CDP（CDP 连接会被阿里云风控识别，导致验证结果的 risk score 偏高、
 * 上游以 3012 拒绝）。改为直接启动有头 Chromium（Xvfb 虚拟屏）打开工作页：
 * 页面自行循环「init SDK → 无痕验证 → 把 param POST 回 /report → 刷新重 init」，
 * 与 ZCode App 行为一致（每次验证前重 init、param 一次性使用）。
 *
 *   GET /health  → {ok, ready, paramAgeMs, mints, fails}
 *   GET /param   → 返回最新 param（超过 maxAge 视为过期，等待下一次上报）
 *
 * 用法: node param_provider.js <scene> <region> <prefix>
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const SCENE = process.argv[2] || '11xygtvd';
const REGION = process.argv[3] || 'sgp';
const PREFIX = process.argv[4] || 'no8xfe';
const PORT = Number(process.env.ZCODE_CAPTCHA_PROVIDER_PORT || 3931);
const CHROMIUM = process.env.ZCODE_CHROMIUM_PATH || 'chromium';
const PROFILE_DIR = process.env.ZCODE_CAPTCHA_PROFILE_DIR || '';
// param 有效窗口：超过该年龄不出参（等待页面下一轮上报）
const MAX_AGE_MS = Number(process.env.ZCODE_CAPTCHA_PARAM_MAX_AGE_MS || 70_000);
// 页面每轮验证后的刷新间隔（注入到工作页）
const RELOAD_DELAY_MS = Number(process.env.ZCODE_CAPTCHA_REFRESH_MS || 55_000);

const PAGE_HTML = fs.readFileSync(path.join(__dirname, 'captcha_page.html'), 'utf8')
  .replace(`Number(Q.get('reload') || 60000)`, `Number(Q.get('reload') || ${RELOAD_DELAY_MS})`);

let lastParam = null, lastParamAt = 0;
let mints = 0, fails = 0;
let chrome = null;

function log(...a) { console.log('[provider]', ...a); }
function errLog(...a) { console.error('[provider]', ...a); }

process.on('uncaughtException', (e) => errLog('uncaughtException:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => errLog('unhandledRejection:', (e && (e.stack || e.message)) || e));

function startChrome() {
  const args = [
    `--user-data-dir=${PROFILE_DIR || '/tmp/captcha-profile'}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--lang=zh-CN', '--window-size=1280,900',
    `http://127.0.0.1:${PORT}/page?scene=${encodeURIComponent(SCENE)}&region=${encodeURIComponent(REGION)}&prefix=${encodeURIComponent(PREFIX)}&reload=${RELOAD_DELAY_MS}`,
  ];
  log('launch chromium:', CHROMIUM);
  chrome = spawn(CHROMIUM, args, { stdio: 'ignore' });
  chrome.on('exit', (code) => {
    errLog('chromium exited code=' + code + ', restarting in 5s');
    chrome = null;
    setTimeout(startChrome, 5000);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (url.startsWith('/page')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
    return;
  }
  if (url.startsWith('/report')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end('{}');
      try {
        const d = JSON.parse(raw || '{}');
        if (url.includes('ok=1') && d.param) {
          lastParam = String(d.param);
          lastParamAt = Date.now();
          mints += 1;
          log(`report ok (len=${lastParam.length}, total=${mints})`);
        } else {
          fails += 1;
          errLog('report fail:', JSON.stringify(d.info || {}).slice(0, 200));
        }
      } catch (e) { errLog('bad report:', e.message); }
    });
    return;
  }
  if (url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      paramAgeMs: lastParamAt ? Date.now() - lastParamAt : null,
      maxAgeMs: MAX_AGE_MS, mints, fails,
    }));
    return;
  }
  if (url.startsWith('/param')) {
    const age = lastParamAt ? Date.now() - lastParamAt : Infinity;
    if (lastParam && age < MAX_AGE_MS) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ param: lastParam, ageMs: age }));
      log(`serve param (age=${age}ms)`);
    } else {
      // param 过期：告知调用方稍后再取（页面循环会在下轮上报）
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'param expired', ageMs: Number.isFinite(age) ? age : null }));
    }
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT} scene=${SCENE} region=${REGION} prefix=${PREFIX}`);
  log(`chromium: ${CHROMIUM} | profile: ${PROFILE_DIR || '(tmp)'}`);
  startChrome();
});

async function shutdown() {
  try { server.close(); } catch {}
  try { if (chrome) chrome.kill(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
