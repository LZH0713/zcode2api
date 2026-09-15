/**
 * ZCode 验证码 param 提供器（常驻）。
 *
 * 用真实 Chromium（headless，与 ZCode App 同款引擎）运行阿里云无痕验证 SDK，
 * 通过本地 HTTP 接口向网关提供一次性 verifyParam：
 *
 *   GET /health  → {ok, ready, lastParamAgeMs, mints, fails}
 *   GET /param   → 现解一发新 param（对齐 App「每次发送前现解、用后即弃」语义，约 3-5s）
 *
 * 请求串行执行；页面/浏览器异常自动重建。验证码 scene/region/prefix 从 client/configs
 * 拉取后由调用方（app/captcha.py）在启动参数里传入。
 *
 * 用法: node param_provider.js <scene> <region> <prefix>
 */

const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const SCENE = process.argv[2] || '11xygtvd';
const REGION = process.argv[3] || 'sgp';
const PREFIX = process.argv[4] || 'no8xfe';
const PORT = Number(process.env.ZCODE_CAPTCHA_PROVIDER_PORT || 3931);
const CHROMIUM = process.env.ZCODE_CHROMIUM_PATH || 'chromium';
const HEADFUL = (process.env.ZCODE_CAPTCHA_HEADFUL || '') === '1';
const PAGE_HTML = require('fs').readFileSync(path.join(__dirname, 'captcha_page.html'), 'utf8');
const PAGE_URL = `http://127.0.0.1:${PORT}/page`
  + `?scene=${encodeURIComponent(SCENE)}&region=${encodeURIComponent(REGION)}&prefix=${encodeURIComponent(PREFIX)}`;

const READY_TIMEOUT_MS = 40_000;
const MINT_TIMEOUT_MS = 30_000;
// IP 信誉节奏：数据中心 IP 上无痕验证约每 60-90s 只放行一发；
// 在复用窗口内直接返回上一个 param（上游历史上接受 45s 内复用），F001 后延迟重试
const REUSE_MS = Number(process.env.ZCODE_CAPTCHA_PARAM_REUSE_MS || 45_000);
const FAIL_RETRY_DELAY_MS = Number(process.env.ZCODE_CAPTCHA_FAIL_RETRY_MS || 20_000);
const PROFILE_DIR = process.env.ZCODE_CAPTCHA_PROFILE_DIR || '';

let browser = null;
let page = null;
let ready = false;
let chain = Promise.resolve();          // 串行化每次验证
let pageUsed = false;                   // SDK 实例一次验证后即失效，需重载页面重新 init
let lastParam = null, lastParamAt = 0;
let mints = 0, fails = 0;

function log(...a) { console.log('[provider]', ...a); }
function errLog(...a) { console.error('[provider]', ...a); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage() {
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });
  await page.waitForFunction('window.__ready === true', { timeout: READY_TIMEOUT_MS, polling: 200 });
  pageUsed = false;
  log('page ready');
  return page;
}

async function ensurePage() {
  if (browser && page && !page.isClosed()) {
    // 对齐 ZCode App 行为（每次验证前 IX() 重置重 init）：用过的页面重载换新 SDK 实例
    if (!pageUsed) return page;
    try { await page.close(); } catch {}
    page = null;
  } else if (browser) {
    try { await browser.close(); } catch {}
    browser = null; page = null;
  }
  if (!browser) {
    log('launch chromium:', CHROMIUM);
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: !HEADFUL,   // 阿里云风控识别 headless（F001），默认有头 + Xvfb 虚拟屏
      ...(PROFILE_DIR ? { userDataDir: PROFILE_DIR } : {}),  // 持久 profile 攒设备信誉
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN', '--window-size=1280,900',
      ],
    });
  }
  return openPage();
}

async function mintWithRetry() {
  try {
    const param = await acquireParam();
    return param;
  } catch (e) {
    // F001 多为 IP 节奏限制：等待后重开页面再试一次
    errLog(`mint failed (${e.message}); retry in ${FAIL_RETRY_DELAY_MS}ms`);
    try { if (page && !page.isClosed()) await page.close(); } catch {}
    page = null;
    await sleep(FAIL_RETRY_DELAY_MS);
    return acquireParam();
  }
}

async function mint(pg) {
  await pg.evaluate('window.__result = null');
  const started = await pg.evaluate('window.__start()');
  const s = String(started);
  if (s !== 'started' && s !== 'started-show') throw new Error('verification start failed: ' + s);

  const deadline = Date.now() + MINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await pg.evaluate('window.__result ? JSON.stringify(window.__result) : null');
    if (raw) {
      const r = JSON.parse(raw);
      if (r.ok && r.param) return String(r.param);
      throw new Error('verification rejected: ' + JSON.stringify(r.info || {}));
    }
    if (pg.isClosed()) throw new Error('page closed during verification');
    await sleep(250);
  }
  throw new Error('verification timeout');
}

async function acquireParam() {
  const pg = await ensurePage();
  try {
    const param = await mint(pg);
    mints += 1;
    pageUsed = true;
    lastParam = param;
    lastParamAt = Date.now();
    return param;
  } catch (e) {
    fails += 1;
    throw e;
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/page')) {
    const html = PAGE_HTML
      .replace(/'11xygtvd'/g, JSON.stringify(SCENE))
      .replace(/'sgp'/g, JSON.stringify(REGION))
      .replace(/'no8xfe'/g, JSON.stringify(PREFIX));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, ready,
      lastParamAgeMs: lastParamAt ? Date.now() - lastParamAt : null,
      reuseMs: REUSE_MS, mints, fails,
    }));
    return;
  }
  if (url.startsWith('/param')) {
    chain = chain.then(async () => {
      try {
        // 复用窗口内直接返回（ bursts 共享一发 param；上游历史接受 45s 内复用）
        if (lastParam && Date.now() - lastParamAt < REUSE_MS) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ param: lastParam, cached: true }));
          log(`serve cached (age=${Date.now() - lastParamAt}ms)`);
          return;
        }
        const param = await mintWithRetry();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ param }));
        log(`mint ok (len=${param.length}, total=${mints})`);
      } catch (e) {
        errLog('mint failed:', e.message);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        // 失败后丢弃页面，下次请求重建，避免坏状态卡死
        try { if (page && !page.isClosed()) await page.close(); } catch {}
        page = null;
      }
    }).catch(() => {});
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT} scene=${SCENE} region=${REGION} prefix=${PREFIX}`);
  log(`chromium: ${CHROMIUM}`);
  log(`page: ${PAGE_URL}`);
});

async function shutdown() {
  try { server.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
