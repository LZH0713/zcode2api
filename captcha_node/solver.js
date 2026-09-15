const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');
const SCENE = process.argv[2] || '11xygtvd';
const REGION = process.argv[3] || 'sgp';
const PREFIX = process.argv[4] || 'no8xfe';

// 阿里云 SDK 会动态加载 FeiLin 设备指纹模块，该模块在 jsdom 中触发 version 赋值异常，
// 导致设备指纹不完整并被服务端以 F001 拒绝 → 拦截该脚本返回空桩（SDK 会自行降级）。
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = e.message || String(e);
  if (msg.includes("setting 'version'")) return;  // FeiLin 相关噪声
  process.stderr.write('[jsdomError] ' + msg + '\n');
});

class SelectiveResourceLoader extends ResourceLoader {
  fetch(url, options) {
    if (url.includes('FeiLin')) {
      process.stderr.write('[BLOCK] ' + url + ' -> empty stub\n');
      return Promise.resolve(Buffer.from('window.__feilin_blocked=true;'));
    }
    return super.fetch(url, options);
  }
}

const html = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://zcode.z.ai/',
  runScripts: 'dangerously',
  resources: new SelectiveResourceLoader(),
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = () => ({ matches:false, media:'', onchange:null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false;} });
    let rafCount = 0;
    window.requestAnimationFrame = (cb) => { const id = ++rafCount; setTimeout(() => cb(Date.now()), 16); return id; };
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    // canvas / webgl 指纹桩：返回稳定值即可
    const proto = window.HTMLCanvasElement.prototype;
    proto.getContext = function (type) {
      if (/webgl/i.test(type)) return { canvas:this, getParameter:(p)=>{ if(p===37445) return 'Intel Inc.'; if(p===37446) return 'Intel Iris OpenGL Engine'; return 'Intel'; }, getExtension:()=>null, getSupportedExtensions:()=>['WEBGL_debug_renderer_info'], getContextAttributes:()=>({}), getShaderPrecisionFormat:()=>({precision:23,rangeMin:127,rangeMax:127}) };
      return { canvas:this, fillRect(){}, clearRect(){}, getImageData:(x,y,w=1,h=1)=>({data:new Uint8ClampedArray(w*h*4)}), putImageData(){}, createImageData:(w=1,h=1)=>({data:new Uint8ClampedArray(w*h*4)}), setTransform(){}, transform(){}, drawImage(){}, save(){}, restore(){}, beginPath(){}, moveTo(){}, lineTo(){}, bezierCurveTo(){}, quadraticCurveTo(){}, closePath(){}, clip(){}, stroke(){}, fill(){}, arc(){}, rect(){}, ellipse(){}, translate(){}, scale(){}, rotate(){}, fillText(){}, strokeText(){}, measureText:(t)=>({width:(''+t).length*8}), createLinearGradient:()=>({addColorStop(){}}), createRadialGradient:()=>({addColorStop(){}}), createPattern:()=>({}), isPointInPath:()=>false, font:'10px sans-serif', textBaseline:'alphabetic', textAlign:'start', fillStyle:'#000', strokeStyle:'#000', globalAlpha:1, lineWidth:1, shadowBlur:0, shadowColor:'' };
    };
    proto.toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    proto.toBlob = (cb) => cb && cb(null);
    // Worker 桩
    window.Worker = class { constructor(){} postMessage(){} terminate(){} addEventListener(){} removeEventListener(){} onmessage=null; onerror=null; };
    window.OffscreenCanvas = window.OffscreenCanvas || class { constructor(w,h){this.width=w;this.height=h;} getContext(){return proto.getContext.call(this);} };
    // performance 桩
    window.performance = window.performance || {};
    window.performance.now = () => Date.now();
    window.performance.timing = window.performance.timing || {};
    window.performance.getEntriesByType = () => [];
    // navigator 桩（与 UA 一致的 Win32 + Chrome 指纹）
    const origNav = window.navigator;
    try {
      Object.defineProperty(origNav, 'webdriver', { get: () => false });
      Object.defineProperty(origNav, 'platform', { get: () => 'Win32' });
      Object.defineProperty(origNav, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      Object.defineProperty(origNav, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(origNav, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(origNav, 'userAgent', { get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
    } catch(e) {}
    // screen 桩
    window.screen = window.screen || {};
    try {
      Object.defineProperty(window.screen, 'width', { get: () => 1920 });
      Object.defineProperty(window.screen, 'height', { get: () => 1080 });
      Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 });
      Object.defineProperty(window.screen, 'availHeight', { get: () => 1040 });
      Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
      Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });
    } catch(e) {}
    // localStorage 桩
    try {
      window.localStorage = window.localStorage || { _data:{}, getItem(k){return this._data[k]||null;}, setItem(k,v){this._data[k]=String(v);}, removeItem(k){delete this._data[k];}, clear(){this._data={};}, key(i){return Object.keys(this._data)[i]||null;}, get length(){return Object.keys(this._data).length;} };
    } catch(e) {}
  },
});
const { window } = dom;

function waitFor(cond, t = 15000) {
  return new Promise((res, rej) => {
    const s = Date.now();
    const i = setInterval(() => { let ok=false; try{ok=cond();}catch{} if(ok){clearInterval(i);res();} else if(Date.now()-s>t){clearInterval(i);rej(new Error('timeout'));} }, 80);
  });
}

(async () => {
  try {
    await waitFor(() => typeof window.initAliyunCaptcha === 'function');
  } catch(e) {
    process.stderr.write('SDK not loaded: ' + e.message + '\n');
    process.exit(6);
  }

  let captchaInst = null, exited = false;
  const done = (code) => { if(!exited){exited=true; process.exit(code);} };

  window.initAliyunCaptcha({
    SceneId: SCENE, mode: 'popup', region: REGION, prefix: PREFIX,
    element: '#cap', button: '#btn', captchaLogoImg: '', showErrorTip: false,
    getInstance: (inst) => {
      captchaInst = inst;
      // 等待 SDK 完成环境探测后再触发无痕验证
      setTimeout(() => {
        if (!captchaInst) return;
        try {
          if (typeof captchaInst.startTracelessVerification === 'function') {
            captchaInst.startTracelessVerification();
          } else if (typeof captchaInst.show === 'function') {
            captchaInst.show();
          }
        } catch(e) {}
      }, 1500);
    },
    success: (param) => { console.log('VERIFY_PARAM=' + param); done(0); },
    fail: () => done(4),
    onError: () => done(5),
  });

  setTimeout(() => done(2), 28000);
})().catch(() => process.exit(3));
