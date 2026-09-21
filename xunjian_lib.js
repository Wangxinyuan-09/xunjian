// 一键巡检 — 公共库：浏览器启动 / OCR / 分桶 / 工具
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function round1(x) {
  if (typeof x !== 'number' || isNaN(x)) return null;
  return Math.round(x * 10) / 10;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

async function launchBrowser(cfg) {
  log('启动 Chromium...');
  return chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: cfg.browser.headless,
    args: cfg.browser.args,
  });
}

function newContext(browser) {
  return browser.newContext({ ignoreHTTPSErrors: true });
}

// ---------- OCR ----------
function parseOcrOutput(type, stdout) {
  const s = stdout.trim();
  if (type === 'ddd') return (s && !s.startsWith('ERR')) ? [s.replace(/\s+/g, '')] : [];
  if (type === 'bastion' || type === 'enhanced') {
    try { return JSON.parse(s); } catch (e) { return s ? [s] : []; }
  }
  if (type === 'ls') {
    // 【2026-09-20】现输出整图候选: whole: ["bnad","bna0"]。
    // 旧格式是逐字符候选行 `char x[a-b]: [...]` 再笛卡尔组合 —— 那种组合在字符横向重叠时
    // 必然产出垃圾(实测把正确的 bnad 挤到垃圾 hnaj 后面), 配合"一次性验证码"直接导致登录全败。
    // 这里优先取 whole; 只有拿不到 whole 时才回落到旧格式, 兼容老脚本。
    const out = [];
    for (const line of s.split('\n')) {
      const m = line.match(/^whole:\s*(\[.*\])\s*$/);
      if (m) { try { out.push(...JSON.parse(m[1])); } catch (e) {} }
    }
    if (out.length) return [...new Set(out)].filter((x) => typeof x === 'string' && x);
    // ---- 旧格式回落(逐字符候选 → 组合) ----
    const chars = [];
    for (const line of s.split('\n')) {
      const m = line.match(/char x\[\d+-\d+\]:\s*\[(.*)\]/);
      if (m && m[1].trim()) {
        chars.push(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')));
      }
    }
    // 生成最多 10 个候选串
    const results = [];
    const build = (idx, acc) => {
      if (idx >= chars.length) { results.push(acc); return; }
      const cands = chars[idx].length ? chars[idx] : [''];
      for (const c of cands) {
        if (results.length >= 12) return;
        build(idx + 1, acc + c);
      }
    };
    build(0, '');
    return results;
  }
  return [];
}

let ocrQueue = Promise.resolve();
function ocr(type, imgBuffer, cfg) {
  // 串行化 OCR（ddddocr 模型加载重，且 python 子进程互斥更稳）
  const task = ocrQueue.then(() => _ocr(type, imgBuffer, cfg));
  ocrQueue = task.catch(() => {});
  return task;
}

async function _ocr(type, imgBuffer, cfg) {
  const script = cfg.ocrScripts[type];
  if (!script || !imgBuffer || !imgBuffer.length) return [];
  const tmp = path.join(cfg.root, 'cap_tmp', `ocr_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`);
  fs.writeFileSync(tmp, imgBuffer);
  try {
    const { stdout } = await execFileAsync('python', [script, tmp], { timeout: 30000 });
    return parseOcrOutput(type, stdout);
  } catch (e) {
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// 共识投票选【唯一】验证码候选 —— 专给"验证码一次性"的设备(漏扫/APT)。
// 背景(2026-09-20 实测): 漏扫 8891 与 APT 6943 的验证码都与当前会话绑定且【一次使用即作废】,
//   重取一次接口就会让页面显示的那张失效(与 EDR 同一个坑, 见 session_activate.loginEDR 注释)。
// 因此【一张图只能提交一个候选】。旧代码把各引擎候选串行全试, 第一个候选就把验证码消耗掉了,
//   后面即使有正确候选也必然被拒 —— 这正是"彩色验证码 OCR 识别率低"假象的来源。
// 选法: 被最多引擎读出来的那个最可信; 票数相同按 engines 的先后(优先级)。
//   engines 第一个应当是最可靠的那个, 'ls' 必须放最后(见 ocr_ls.py 的合并 bug)。
//
// 【验证码长度必须按设备给, 不能写死 4 位】(2026-09-20 实测 APT):
//   APT 的验证码是【5 位】, 四个引擎 top-1 全都是正确的 "3mdmx"(5字符),
//   但旧代码的 `^[0-9a-zA-Z]{4}$` 把正确答案整个滤掉, 只留下排第五的 "3mum" → 提交必错。
//   表象同样是"验证码识别不准", 实际是过滤器把对的答案扔了。
//   len 传数字(定长)或 {min,max}(范围); 不传默认 4 位(漏扫/alpha 的历史行为)。
function _lenRe(len) {
  if (len && typeof len === 'object') {
    const lo = len.min != null ? len.min : 1;
    const hi = len.max != null ? len.max : 12;
    return new RegExp(`^[0-9a-zA-Z]{${lo},${hi}}$`);
  }
  const n = len || 4;
  return new RegExp(`^[0-9a-zA-Z]{${n}}$`);
}

async function pickOneCaptcha(engines, imgBuffer, cfg, len) {
  if (!imgBuffer || !imgBuffer.length) return '';
  const re = _lenRe(len);
  const votes = new Map();
  for (let pi = 0; pi < engines.length; pi++) {
    let cands = [];
    try {
      cands = (await ocr(engines[pi], imgBuffer, cfg)).filter((c) => re.test(c));
    } catch (e) {}
    for (let oi = 0; oi < cands.length; oi++) {
      const v = votes.get(cands[oi]) || { c: cands[oi], n: 0, best: 99, order: 99 };
      v.n++;
      v.best = Math.min(v.best, pi);
      v.order = Math.min(v.order, oi);
      votes.set(cands[oi], v);
    }
  }
  const ranked = [...votes.values()].sort((a, b) => (b.n - a.n) || (a.best - b.best) || (a.order - b.order));
  return ranked.length ? ranked[0].c : '';
}

// 取验证码 b64（形如 data:image/...;base64,xxx）→ Buffer
function b64Buffer(b64) {
  const m = String(b64).split('base64,');
  return Buffer.from(m.length > 1 ? m[1] : m[0], 'base64');
}

// ---------- 7天分桶 ----------
// samples: [{timeMs, value}] 或传 getTime/getValue 取字段
// 返回 { days:[7], avg:[7], max:[7] }
function bucketByDay(samples, { getTime, getValue, endMs }) {
  const getT = getTime || ((s) => s.timeMs);
  const getV = getValue || ((s) => s.value);
  const startDay = (endMs || Date.now()) - 8 * 86400000;
  const buckets = {};
  for (const s of samples || []) {
    const t = getT(s);
    const v = getV(s);
    if (!t || typeof v !== 'number' || isNaN(v)) continue;
    if (t < startDay) continue;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push({ t, v });
  }
  const keys = Object.keys(buckets).sort();
  const last7 = keys.slice(-7);
  const days = [], avg = [], max = [];
  for (const k of last7) {
    const arr = buckets[k];
    const sum = arr.reduce((a, b) => a + b.v, 0);
    const mx = Math.max(...arr.map((b) => b.v));
    days.push(k);
    avg.push(round1(sum / arr.length));
    max.push(round1(mx));
  }
  return { days, avg, max };
}

// 实时快照 → 复制7份
function replicate(v) {
  return [v, v, v, v, v, v, v];
}

// ---------- React/Vue 原生 value setter ----------
function setNativeValue(el, val) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, val); else el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---------- 登录态持久化（localStorage + cookies）----------
// 用于验证码 OCR 成功率低的设备（漏扫/APT/UES等）：手动登录一次保存会话，之后自动复用
async function saveSession(page, ctx, file) {
  const ls = await page.evaluate(() => {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
    return o;
  }).catch(() => ({}));
  const cookies = await ctx.cookies().catch(() => []);
  fs.writeFileSync(file, JSON.stringify({ ls, cookies }, null, 2), 'utf8');
  // 自动记录会话更新(登录/续存),见 session_log.js —— 满足"每次登录记录会话更新"
  try {
    const slog = require('./session_log');
    slog.append(slog.labelOf(file), '会话保存/更新', true, `${path.basename(file)} (localStorage ${Object.keys(ls).length}项/cookies ${cookies.length}个)`);
  } catch (e) {}
  return { lsCount: Object.keys(ls).length, cookieCount: cookies.length };
}

async function restoreSession(page, ctx, file) {
  if (!fs.existsSync(file)) return false;
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return false; }
  if (s.cookies && s.cookies.length) { try { await ctx.addCookies(s.cookies); } catch (e) {} }
  if (s.ls && Object.keys(s.ls).length) {
    await page.addInitScript((ls) => {
      try { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch (e) {}
    }, s.ls);
  }
  return true;
}

// ---------- 通用工具 ----------
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || '') + ' timeout ' + ms + 'ms')), ms)),
  ]);
}

function emptyResult(id, product) {
  return {
    id, product, collectionMode: 'web', hasWebChart: 'no',
    cpuSeries: null, diskSeries: null, memSeries: null,
    cpuPeakSeries: null, diskPeakSeries: null, memPeakSeries: null,
    days: null, remarks: '', ok: false, error: '', collectedAt: new Date().toISOString(), source: '',
  };
}

function fillOk(r, { cpu, mem, disk, cpuPeak, diskPeak, memPeak, days, remarks, source, collectionMode, hasWebChart }) {
  r.cpuSeries = Array.isArray(cpu) ? cpu : replicate(cpu == null ? 0 : cpu);
  r.memSeries = Array.isArray(mem) ? mem : replicate(mem == null ? 0 : mem);
  r.diskSeries = Array.isArray(disk) ? disk : replicate(disk == null ? 0 : disk);
  r.cpuPeakSeries = cpuPeak || null;
  r.memPeakSeries = memPeak || null;
  r.diskPeakSeries = diskPeak || null;
  r.days = days || null;
  r.remarks = remarks || '';
  r.source = source || '';
  r.collectionMode = collectionMode || 'web';
  r.hasWebChart = hasWebChart || (Array.isArray(cpu) && cpu.length === 7 ? 'yes' : 'no');
  r.ok = true;
  return r;
}

module.exports = {
  log, round1, readJson, writeJson, launchBrowser, newContext,
  ocr, pickOneCaptcha, b64Buffer, bucketByDay, replicate, setNativeValue,
  withTimeout, emptyResult, fillOk, saveSession, restoreSession,
};
