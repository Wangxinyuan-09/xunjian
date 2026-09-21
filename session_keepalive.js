#!/usr/bin/env node
// 会话保活 + 自动激活 — 用已保存会话向各平台发一次真实认证请求刷新滑动超时；
// 探测失效时【无人值守 OCR 重登】。人工弹窗兜底已按用户要求关闭(见 ENABLE_MANUAL_POPUP)。
//
// 用法:
//   node session_keepalive.js           全量周期(计划任务每10分钟调用)：探测→失效自动激活→写状态
//   node session_keepalive.js --list    只探测各设备有效性并打印，不做激活/不写档
//   node session_keepalive.js --activate <设备名>   只对单个设备跑一次 OCR 激活(无人值守), 打印结果
//
// 会话失效设备的激活策略(2026-09-20 起: 纯自动, 无人工):
//   - 每设备维护 act.failStreak；每次失效探测先试 OCR 激活(冷却15min)，失败就按冷却继续重试
//   - 人工弹窗默认关闭(ENABLE_MANUAL_POPUP=false)。开启时: failStreak>=2 转弹窗(冷却12h),
//     拉起对应 *_pick.js 由人输验证码 —— 需要时用 XUNJIAN_POPUP=1 临时恢复
// 单实例锁: 上一次周期未结束(>12min 旧锁)则跳过本次，避免计划任务重叠打架
//
// 判据与 collect_* 逐一对齐(2026-09-07 修正，避免误报):
//   漏扫  collect_lousao.isLoggedIn = URL含/rasm 且 body 无"欢迎登录"
//   EDR   collect_hs  = 复用会话后 URL 离开登录页 + 能捕获到 Bearer Authorization
//   UES   collect_ues = URL非login 且 body 含"安全概览"(版本接口匿名也能读，不能当判据)
//   APT   collect_apt = URL 离开 /#/login (真实主页 /#/home)
//   aidsc collect_aidsc = 直接调 /system/systemInfo 200
//   LT    collect_ltbastion.fileAuth = 会话文件原始 DAS_USM_ROUTER_AUTH_ token 调 pamapi license code==OK
//   DasV  auto-login(无验证码)：现登并确认 DasV-Edit_token
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const lib = require('./xunjian_lib');
const cfg = require('./xunjian_config');
const slog = require('./session_log');
const activator = require('./session_activate');
const STATUS_FILE = path.join(cfg.root, 'keepalive_status.json');
const LOCK_FILE = path.join(cfg.root, 'keepalive.lock');

// ---- 冷却/节流 ----
const ACT_COOLDOWN_MS = 15 * 60 * 1000;     // 同设备两次 OCR 激活最小间隔(防验证码轰炸)
// 单个设备的自动激活时间上限。计划任务每 10 分钟一轮, 但一个慢目标(如 LT 要试 4 轮 OCR,
// 或漏扫要跑 4 引擎)能把整轮拖到 10 分钟以上 → 后续轮次被"锁未过期"跳过 → 会话在空窗期过期。
// 2026-09-10 实测: 多轮保活被跳过, 巡检因此撞上过期会话。故给单目标加硬上限。
const ACT_TIMEOUT_MS = 5 * 60 * 1000; // LT 要试 4 轮 OCR(每轮含15s等待), 4 分钟会把成功的最后一轮切掉
const POPUP_COOLDOWN_MS = 12 * 3600 * 1000; // 同设备两次手动弹窗最小间隔
const OCR_FAIL_STREAK_TO_POPUP = 2;         // OCR 连续失败多少次后转弹窗
const LOCK_MAX_AGE_MS = 12 * 60 * 1000;     // 单实例锁最老年龄(计划任务每10分钟，容忍12分钟)
// 人工弹窗兜底开关。2026-09-20 按用户要求【默认关闭】("不要让我手动激活会话了, 不要弹窗了")。
// 需要临时恢复人工兜底时: 设环境变量 XUNJIAN_POPUP=1 再跑, 或把这里改成 true。
// 关闭时 maybeActivate 必须【整个跳过】failStreak→弹窗分支, 否则连失 2 次后会被 12h 冷却锁住,
// 连后续的自动 OCR 重试也一并没了(只剩会话一直失效)。
const ENABLE_MANUAL_POPUP = process.env.XUNJIAN_POPUP === '1';

// host 一律从 xunjian_config 取（真实地址在 xunjian_config.local.js，不入库）。
// 写死地址会让本文件没法公开，也容易和 config 里的改动脱节。
const H = (name) => {
  const d = name === 'apt16' ? cfg.apt[0] : name === 'apt17' ? cfg.apt[1] : cfg.devices[name];
  return `${d.host}:${d.port}`;
};

const TARGETS = [
  { name: '漏扫', file: 'lousao_session.json', host: H('lousao'), home: '/rasm/home', probeType: 'lousao', activate: 'lousao', pick: 'lousao_pick.js' },
  { name: '终端安全EDR', file: 'hs_session.json', host: H('hs'), home: '/#/home/complex-dashboard', probeType: 'edr', activate: 'hs', pick: 'hs_pick.js' },
  { name: 'UES办公智盾', file: 'ues_session.json', host: H('ues'), home: '/ues/base/home', probeType: 'ues', activate: 'ues', pick: 'ues_pick.js' },
  { name: 'APT-LC1', file: 'apt_session_16.json', host: H('apt16'), home: '/#/home', probeType: 'apt', activate: 'apt', aptId: 16, pick: 'apt_pick.js' },
  { name: 'APT-LC2', file: 'apt_session_17.json', host: H('apt17'), home: '/#/home', probeType: 'apt', activate: 'apt', aptId: 17, pick: 'apt_pick.js' },
  { name: '数据安全管控Aidsc', file: 'aidsc_session.json', host: H('aidsc'), home: '/', probeType: 'aidsc', activate: 'aidsc', pick: 'aidsc_pick.js' },
  { name: 'LT堡垒机', file: 'ltb_session.json', host: H('ltbastion'), home: '/', probeType: 'ltb', activate: 'ltb', pick: 'ltb_pick.js' },
  { name: 'EDR-超管', file: 'hs_admin_session.json', host: H('hs'), home: '/#/home/complex-dashboard', probeType: 'edr_admin', activate: 'hs_admin', pick: 'hs_admin_pick.js' },
  { name: 'DasV大屏', file: null, host: H('dasv'), scheme: 'http', home: '/', probeType: 'dasv', activate: 'dasv', pick: null },
];

const offLoginRe = /(^|\/)(#\/)?login/i;
const AUTH_MARKER = 'DAS_USM_ROUTER_AUTH_';

// ================= 单实例锁 =================
// 锁里记了 pid: 进程若崩溃(浏览器被外部关掉→整轮探测全废)会来不及释放锁,
// 只靠"锁年龄<12分钟"判定会让调度器白白空转 1~2 轮(2026-09-10 实测)。
// 所以再加一条: pid 已不存在 = 上一次是崩的, 立刻接管。
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM=进程在但没权限 → 视为活着
}
function acquireLock() {
  try {
    const now = Date.now();
    if (fs.existsSync(LOCK_FILE)) {
      const s = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = now - (s.ts || 0);
      if (age < LOCK_MAX_AGE_MS && pidAlive(s.pid)) {
        lib.log('检测到上一次保活仍在运行(锁未过期)，跳过本次');
        return false;
      }
      lib.log(pidAlive(s.pid)
        ? `上一次保活锁已超龄(${Math.round(age / 60000)}分钟)，接管`
        : `上一次保活进程(pid ${s.pid})已退出但未释放锁，接管`);
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: now }));
    return true;
  } catch (e) { return true; }
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} }

// ================= 探测(判据对齐 collect_*) =================
// 读会话文件原始 token(适用 LT: localStorage 启动会被轮换成无效占位值)
function fileToken(t) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(cfg.root, t.file), 'utf8'));
    for (const k of Object.keys(s.ls || {})) if (k.indexOf(AUTH_MARKER) >= 0) return s.ls[k];
  } catch (e) {}
  return null;
}

async function probe(page, t) {
  const scheme = t.scheme || 'https';
  const host = `${scheme}://${t.host}`;
  // 先回到真实主页，让 SPA 完成路由与登录态检测
  // 注意: EDR 跳过公共预加载——EDR 首次加载会做 token 轮换，再 goto 一次会把 addInitScript
  // 重置回的旧 token 暴露给服务端(旧 token 已被轮换) → SPA 只渲染壳、不发鉴权请求。
  // EDR 分支内部自行单次 goto 抓 token(与 collect_hs.loadAndCaptureAuth 一致)。
  if (t.probeType !== 'edr' && t.probeType !== 'edr_admin') {
    await page.goto(host + t.home, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  if (t.probeType === 'lousao') {
    // 与 collect_lousao.isLoggedIn 一致：URL 含 /rasm 且 body 无"欢迎登录/请输入验证码"
    const body = await page.evaluate(() => (document.body.innerText || '')).catch(() => '');
    const onRasm = /rasm/.test(page.url());
    const notLogin = !/欢迎登录|请输入验证码/.test(body);
    return onRasm && notLogin;
  }

  if (t.probeType === 'edr' || t.probeType === 'edr_admin') {
    // 与 collect_hs 一致：单次加载主页 → 捕获 Authorization → 调接口(200)。
    // edr(manger) 查授权 /user_license(200)；edr_admin(超管) 查 /upgrade/get_upgrade_progress(admin 可读)
    let auth = '';
    const onReq = (req) => { if (!auth && req.headers()['authorization']) auth = req.headers()['authorization']; };
    page.on('request', onReq);
    await page.goto(host + t.home, { waitUntil: 'load', timeout: 40000 }).catch(() => {});
    const t0 = Date.now();
    while (!auth && Date.now() - t0 < 15000) { await page.waitForTimeout(300); }
    page.off('request', onReq);
    if (!auth) auth = await page.evaluate(() => localStorage.getItem('CUT_token') || '').catch(() => '');
    if (auth && !/^Bearer\s/i.test(auth)) auth = 'Bearer ' + auth;
    const offLogin = !offLoginRe.test(page.url());
    if (!offLogin || !auth) return false;
    const ep = t.probeType === 'edr' ? '/user_license/list_licenses?offset=0' : '/upgrade/get_upgrade_progress';
    const st = await page.evaluate(async ({ a, u }) => {
      const r = await fetch(u, { headers: { Authorization: a, Accept: 'application/json' } });
      return r.status;
    }, { a: auth, u: ep }).catch(() => -1);
    return st === 200;
  }

  if (t.probeType === 'ues') {
    // 与 collect_ues 一致：URL 非 login 且 body 含"安全概览"(版本接口匿名也返回，不能当判据)
    const body = await page.evaluate(() => (document.body.innerText || '')).catch(() => '');
    const okUrl = !offLoginRe.test(page.url());
    const seenOverview = body.includes('安全概览');
    return seenOverview || (okUrl && !body.includes('欢迎登录'));
  }

  if (t.probeType === 'apt') {
    const st = await page.evaluate(() => {
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/token|auth|session/i.test(k)) ls[k] = true; }
      return { url: location.href, authKeys: Object.keys(ls) };
    }).catch(() => null);
    const offLogin = !offLoginRe.test(st ? st.url : '');
    return !!(st && st.authKeys.length && offLogin);
  }

  if (t.probeType === 'aidsc') {
    const st = await page.evaluate(async () => { const x = await fetch('/system/systemInfo', { headers: { Accept: 'application/json' } }); return x.status; }).catch(() => -1);
    return st === 200;
  }

  if (t.probeType === 'ltb') {
    // 会话文件原始 token 直连 pamapi license(页面落在 7443 origin 上发同源请求即可)
    const tok = fileToken(t);
    if (!tok) return false;
    const st = await page.evaluate(async (token) => {
      let code = '';
      try {
        const r = await fetch('/pamapi/maintain/v1/license:get_license_info', {
          headers: { authorization: token, 'content-type': 'application/json', lang: 'ZH_CN' },
        });
        const j = await r.json().catch(() => null);
        code = j && j.code;
        return { st: r.status, code };
      } catch (e) { return { st: -1, code }; }
    }, tok).catch(() => ({ st: -1, code: '' }));
    return st.st === 200 && st.code === 'OK';
  }

  if (t.probeType === 'dasv') {
    // DasV 无会话文件、无验证码：现登即探活
    await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await page.waitForSelector('input', { timeout: 20000 }).catch(() => {});
    const ins = page.locator('input');
    await ins.nth(0).fill(cfg.devices.dasv.user).catch(() => {});
    await ins.nth(1).fill(cfg.devices.dasv.pass).catch(() => {});
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button, input[type=button], [role=button], .ant-btn')].find((x) => {
        const t2 = ((x.textContent || '') + ' ' + (x.value || '')).replace(/\s+/g, '');
        return t2.includes('登') && t2.includes('录');
      });
      if (b) b.click();
    }).catch(() => {});
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const has = await page.evaluate(() => !!localStorage.getItem('DasV-Edit_token')).catch(() => false);
      if (has) return true;
    }
    return false;
  }
  return false;
}

// 单设备探测(独占 context)，返回 {ok} 或抛错
async function keepaliveOne(t, browser) {
  const file = t.file ? path.join(cfg.root, t.file) : null;
  if (t.probeType !== 'dasv' && (!file || !fs.existsSync(file))) {
    lib.log(`${t.name}: 无会话文件 ${t.file}，走自动激活或 *_pick.js 登录一次`);
    return { ok: false, noFile: true };
  }
  const ctx = await lib.newContext(browser);
  try {
    const page = await ctx.newPage();
    if (file) {
      const restored = await lib.restoreSession(page, ctx, file);
      if (!restored) { lib.log(`${t.name}: 会话文件无法解析 ${t.file}`); return { ok: false }; }
    }
    const ok = await probe(page, t);
    lib.log(`${t.name}: ${ok ? '✅ 会话有效，已续期' : '❌ 会话失效，尝试自动激活'}`);
    return { ok };
  } finally { await ctx.close().catch(() => {}); }
}

// ================= 激活与弹窗 =================
function launchPopup(t, stA) {
  if (!ENABLE_MANUAL_POPUP) {
    lib.log(`${t.name}: 人工弹窗已按用户要求关闭(设 XUNJIAN_POPUP=1 可临时恢复), 只做自动 OCR 重试`);
    return false;
  }
  if (!t.pick) { lib.log(`${t.name}: 无手动登录脚本可弹窗`); return false; }
  // EDR 账号锁定期间弹窗也没用(服务端直接拒绝登录), 别打扰人
  if (/^EDR/.test(t.name) && typeof activator.edrLock === 'function' && activator.edrLock()) {
    const lk = activator.edrLock();
    lib.log(`${t.name}: EDR 账号仍在锁定冷却中(至 ${new Date(lk.until).toLocaleString()})，不弹窗`);
    return false;
  }
  const script = path.join(cfg.root, t.pick);
  if (!fs.existsSync(script)) { lib.log(`${t.name}: 弹窗脚本不存在 ${t.pick}`); return false; }
  const args = [script];
  if (t.activate === 'apt') args.push(String(t.aptId));
  lib.log(`⚠️ ${t.name} OCR连续失败(${(stA && stA.failStreak) || 1}次)，拉起手动登录窗口 ${t.pick}`);
  slog.append(t.name, '需要手动重登(弹窗)', false, `自动OCR激活连续失败，已拉起 ${t.pick} 等待人工输验证码`);
  try {
    const child = spawn(process.execPath, args, { cwd: cfg.root, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) { return false; }
}

// 单个失效设备：先 OCR(冷却内)，失败满 N 次→弹窗(冷却内)。返回是否已恢复
async function maybeActivate(t, stA) {
  if (!t.activate) return false;
  const now = Date.now();
  stA.failStreak = (stA.failStreak || 0) + 1;

  // 仅在开启弹窗兜底时才走这个分支; 关闭时直接落到下面的 OCR 重试, 由 ACT_COOLDOWN_MS 节流
  if (ENABLE_MANUAL_POPUP && stA.failStreak >= OCR_FAIL_STREAK_TO_POPUP) {
    const lastPopup = stA.lastPopupAt ? new Date(stA.lastPopupAt).getTime() : 0;
    if (now - lastPopup < POPUP_COOLDOWN_MS) {
      lib.log(`${t.name}: OCR已连续失败，手动弹窗冷却中，本次跳过`);
      return false;
    }
    launchPopup(t, stA);
    stA.lastPopupAt = new Date().toISOString();
    stA.failStreak = 0; // 弹窗后允许再次尝试 OCR(可能碰上易识别验证码)
    return false;
  }

  const lastAct = stA.lastActAt ? new Date(stA.lastActAt).getTime() : 0;
  if (now - lastAct < ACT_COOLDOWN_MS) {
    lib.log(`${t.name}: 自动激活冷却中，本次跳过`);
    return false;
  }
  stA.lastActAt = new Date().toISOString();
  lib.log(`${t.name}: 自动激活(OCR)开始...`);
  // 单目标硬超时: 超时即放弃本轮(底下的 activate 会自己收尾关浏览器), 不让一个慢目标拖垮整轮保活
  const r = await Promise.race([
    activator.activate(t).catch((e) => ({ ok: false, note: String(e.message || e).slice(0, 120) })),
    new Promise((res) => setTimeout(() => res({ ok: false, note: `自动激活超时(${ACT_TIMEOUT_MS / 60000}分钟), 放弃本轮` }), ACT_TIMEOUT_MS).unref()),
  ]);
  // 账号被锁/口令错: 自动重试有害无益(会把生产账号越锁越死) → 立刻转人工弹窗, 不占用冷却
  if (r && r.locked) {
    stA.failStreak = 0;
    slog.append(t.name, '自动激活暂停(账号锁定/口令错)', false, (r.note || '').replace(/\|/g, '\\|'));
    lib.log(`${t.name}: ⛔ ${r.note}`);
    if (ENABLE_MANUAL_POPUP) {
      const lastPopup = stA.lastPopupAt ? new Date(stA.lastPopupAt).getTime() : 0;
      if (now - lastPopup >= POPUP_COOLDOWN_MS && launchPopup(t, stA)) stA.lastPopupAt = new Date().toISOString();
    } else {
      lib.log(`${t.name}: 账号锁定/口令错, 人工弹窗已关闭 → 本轮放弃(不自动重试, 避免越锁越死)`);
    }
    return false;
  }
  if (r && r.ok) {
    stA.failStreak = 0;
    slog.append(t.name, '自动激活(OCR)成功', true, (r.note || '会话已重新登录').replace(/\|/g, '\\|'));
    lib.log(`${t.name}: ✅ 自动激活成功 ${(r.note || '').slice(0, 60)}`);
    return true;
  }
  slog.append(t.name, '自动激活(OCR)失败', false, ((r && r.note) || '未过验证码').replace(/\|/g, '\\|'));
  lib.log(`${t.name}: ❌ 自动激活未过 ${(r && r.note) || ''} (连失${stA.failStreak}次)`);
  return false;
}

// ================= 全量周期 =================
// 巡检 sweep(xunjian_all.js)运行中标记: 两个脚本同时开 Chromium 会互相把对方浏览器搞崩
// (2026-09-10 实测: 保活日志里整轮探测全是 "Target page, context or browser has been closed")
const SWEEP_FLAG = path.join(cfg.root, 'sweep.running');
const SWEEP_FLAG_MAX_AGE_MS = 30 * 60 * 1000;

function sweepRunning() {
  try {
    const st = fs.statSync(SWEEP_FLAG);
    return Date.now() - st.mtimeMs < SWEEP_FLAG_MAX_AGE_MS;
  } catch (e) { return false; }
}

async function runCycle() {
  if (sweepRunning()) { lib.log('巡检 sweep 正在运行, 跳过本次保活(避免争抢 Chromium)'); return; }
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (e) {}
  const prevOk = (prev.ok) || prev; // 兼容旧扁平结构 {name: bool}
  const prevAct = (prev.act) || {};
  const cur = {};
  const act = JSON.parse(JSON.stringify(prevAct));

  let browser = await lib.launchBrowser(cfg);
  const probeResults = {};
  try {
    lib.log('===== 会话保活+自动激活 =====');
    // —— 第 1 阶段：探测全部设备 ——
    // 每个探测必须独立限时: 某个设备(实测是会话失效的漏扫)可能卡住不返回,
    // 而它是队首 → 整个 8 分钟预算被它烧光, 后面 EDR/UES/LT 一次都没轮到(2026-09-11 实测 CYCLE ABORT)。
    for (const t of TARGETS) {
      try {
        const { ok } = await lib.withTimeout(keepaliveOne(t, browser), 90 * 1000, `${t.name} 探测`);
        probeResults[t.name] = ok;
      } catch (e) {
        probeResults[t.name] = false;
        lib.log(`${t.name}: 探测异常/超时 ` + String(e.message || e).slice(0, 80));
      }
    }
  } finally { await browser.close().catch(() => {}); }

  // —— 第 2 阶段：失效设备逐个自动激活(独立 Chromium, 不与上面探测争) ——
  const dead = TARGETS.filter((t) => probeResults[t.name] === false);
  for (const t of dead) {
    const stA = (act[t.name] = act[t.name] || { failStreak: 0 });
    stA.lastProbeAt = new Date().toISOString();
    try {
      const recovered = await maybeActivate(t, stA);
      cur[t.name] = recovered;
      stA.lastActOk = recovered;
    } catch (e) {
      cur[t.name] = false;
      lib.log(`${t.name}: 自动激活异常 ` + String(e.message || e).slice(0, 100));
    }
  }

  // —— 第 3 阶段：写状态 + 变更记录 ——
  const prevOkVal = (n) => prevOk && prevOk[n];
  for (const t of TARGETS) {
    const isDead = dead.includes(t);
    const was = prevOkVal(t.name);
    const nowOk = isDead ? (cur[t.name] || false) : true;
    cur[t.name] = nowOk;
    if (was === undefined) {
      lib.log(`  (基线) ${t.name}: ${nowOk ? '✅ 有效' : '❌ 失效/需人工'}`);
    } else if (nowOk && !was) {
      // 由自动激活恢复（上面 maybeActivate 已记"自动激活成功"），或本周期自然恢复
      if (!isDead) slog.append(t.name, 'keepalive自动续期恢复', true, '会话从失效恢复,已续期');
    } else if (!nowOk && was) {
      slog.append(t.name, 'keepalive检测失效', false, isDead ? '已尝试自动激活仍失败,需弹窗人工重登' : '会话已失效,需自动/手动重登');
    }
  }
  lib.writeJson(STATUS_FILE, { updatedAt: new Date().toISOString(), ok: cur, act });
  lib.log('===== 保活结束 =====');
}

// ================= CLI =================
function targetOf(name) {
  return TARGETS.find((t) => t.name === name || t.file === name + '_session.json' || t.activate === name);
}

async function listOnly() {
  const browser = await lib.launchBrowser(cfg);
  try {
    lib.log('===== 保活探测(--list, 不激活) =====');
    for (const t of TARGETS) {
      try { await keepaliveOne(t, browser); } catch (e) { lib.log(`${t.name}: 探测异常 ` + String(e.message || e).slice(0, 80)); }
    }
    lib.log('===== 结束 =====');
  } finally { await browser.close().catch(() => {}); }
}

async function activateOne(name) {
  const t = targetOf(name);
  if (!t) { console.error('未知设备: ' + name + ' (可选: ' + TARGETS.map((x) => x.name).join(' / ') + ')'); process.exit(1); }
  if (!t.activate) { console.log(t.name + ' 无自动激活'); process.exit(0); }
  console.log('自动激活(OCR):', t.name, '...');
  const r = await activator.activate(t);
  console.log(JSON.stringify({ name: t.name, ok: !!(r && r.ok), note: (r && r.note) || '', failStreak: 0 }, null, 2));
  process.exit(r && r.ok ? 0 : 1);
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--list') return listOnly();
  if (arg === '--activate') return activateOne(process.argv[3]);
  if (!acquireLock()) process.exit(0);
  try {
    // 整体超时: 单轮卡死(激活挂着不放)会把锁占满 10 分钟, 挡住后续所有周期(2026-09-10 实测)
    const cycle = (async () => {
      // 若 Chromium 中途崩溃导致整体失败，重置锁后重试一次
      for (let round = 1; round <= 2; round++) {
        try { await runCycle(); break; }
        catch (e) {
          console.error('FATAL round ' + round + ': ' + (e.message || e));
          if (round === 2) throw e;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    await Promise.race([
      cycle,
      new Promise((_, rej) => setTimeout(() => rej(new Error('保活单轮超时(8分钟), 强制结束释放锁')), 8 * 60 * 1000).unref()),
    ]);
  } catch (e) {
    console.error('CYCLE ABORT: ' + (e.message || e));
  } finally { releaseLock(); }
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e); releaseLock(); process.exit(1); });
}

module.exports = { TARGETS, targetOf, runCycle, listOnly, launchPopup, maybeActivate };
