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

let browser = null;
let page = null;
let ready = false;
let chain = Promise.resolve();          // 串行化每次验证
let pageUsed = false;                   // SDK 实例一次验证后即失效，需重载页面重新 init
let lastParamAt = 0;
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
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN', '--window-size=1280,900',
      ],
    });
  }
  return openPage();
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
    // 页面容器：http origin（file:// origin 会影响验证通过率），参数写死进 HTML
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
      mints, fails,
    }));
    return;
  }
  if (url.startsWith('/param')) {
    chain = chain.then(async () => {
      try {
        const param = await acquireParam();
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
