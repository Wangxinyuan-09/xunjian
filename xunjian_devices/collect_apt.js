// APT攻击预警平台（独立部署，地址见 xunjian_config 的 apt 段）— 会话复用优先(apt 用 localStorage token, 按实例分文件) + OCR 兜底
// 资源接口: /system/status（系统-系统资源页）
const path = require('path');
const lib = require('../xunjian_lib');

// 判登录：localStorage 有 token/auth/session 键
async function lsAuthKeys(page) {
  return page.evaluate(() => {
    const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/token|auth|session/i.test(k)) ls[k] = true; }
    return Object.keys(ls);
  }).catch(() => []);
}

// 只填【可见】的 input —— APT 登录页有 6 个 input, 后 3 个属于隐藏的 thirdAuth 表单,
// 按 inputs[0..2] 的位置索引填会填错行(实测 [3][4][5] 是 username/password/captcha 的另一套)
async function tryLogin(page, dcfg, code) {
  await page.evaluate(({ user, pass, code }) => {
    const setNative = (el, val) => {
      if (!el) return;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const vis = [...document.querySelectorAll('input')].filter((i) => i.offsetWidth || i.offsetHeight || i.getClientRects().length);
    setNative(vis[0], user);
    setNative(vis[1], pass);
    const cap = vis.find((i) => /验证码|captcha/i.test((i.name || '') + (i.placeholder || '')));
    if (cap) setNative(cap, code);
  }, { user: dcfg.user, pass: dcfg.pass, code });
  // 必须真实点击: JS .click() 打不中提交按钮(与漏扫同一个坑)
  await page.locator('button:visible', { hasText: /登\s*录/ }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return page.evaluate(() => {
    const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/token|auth|session/i.test(k)) ls[k] = true; }
    return { url: location.href, hasAuth: Object.keys(ls).length > 0, lsKeys: Object.keys(ls) };
  });
}

async function getCaptcha(page) {
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.src && i.src.includes('base64'));
    return imgs.length ? imgs[imgs.length - 1].src : '';
  });
}

// token 在 localStorage.echo_token, 值是 JSON 编码的字符串(带引号) → 需 JSON.parse 取裸 JWT
async function readToken(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('echo_token');
    if (!raw) return '';
    try {
      const p = JSON.parse(raw);
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && typeof p.token === 'string') return p.token;
    } catch (e) { /* 非 JSON 就当裸 token */ }
    return raw;
  }).catch(() => '');
}

// 调 APT 接口【必须带 Authorization: Bearer <echo_token>】。
// 【AP T-LC1/LC2 采集失败的根因之一, 2026-09-20 实测】旧代码用裸 fetch('/system/status'):
//   应用自己的 axios 拦截器会加 Authorization 头, 裸 fetch 绕过了它 → 服务端永远回
//   401 {"message":"缺少token，请重新登录","error_code":400}。对照实验: 加上 Bearer 头后
//   报错立刻从"缺少token"变成"token过期"(即头被服务端认可了), 换新 token 后直接 200 拿到数据。
async function apiGet(page, path, token) {
  return page.evaluate(async ({ path, token }) => {
    try {
      const r = await fetch(path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, credentials: 'include' });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { body = null; }
      return { status: r.status, text: text.slice(0, 4000), body };
    } catch (e) {
      return { status: 0, text: String(e.message || e), body: null };
    }
  }, { path, token });
}

// 取 body 里的 data(兼容 {"error_code":200,...,"data":...} 与 {"code":0,...,"data":...} 两种壳)
function dataOf(res) {
  const b = res && res.body;
  if (!b || typeof b !== 'object') return null;
  return b.data !== undefined ? b.data : null;
}

// 按时间窗取告警总数。
// 【时间窗参数是 timeAgo, 不是 navigateTime】(2026-09-20 隔离实验实测):
//   无参 / navigateTime=d7 / type=d7  —— 全部返回同一份 25 个小时点(h24)
//   timeAgo=d7                        —— 才切到 16 个"半天"点, xAxis 形如 260913-AM…260920-PM
//   即: navigateTime 只是前端 Vuex 里的字段名, 真正落到 HTTP 上的是 timeAgo。
//   h24 → 逐小时 25 点(本日); d7 → 每天 2 点(AM/PM) 共 16 点 ≈ 含今天在内 8 天。
async function riskTotal(page, token, timeAgo) {
  const res = await apiGet(page, `/navigate/getRiskTrend?timeAgo=${timeAgo}`, token);
  const d = dataOf(res);
  if (!d || !Array.isArray(d.total)) return { n: null, pts: 0, st: res.status };
  const arr = d.total.map(Number).filter(Number.isFinite);
  // d7 取末尾 14 点 = 最近 7 个整天(点多于 14 说明往前多给了, 多的不要)
  const use = timeAgo === 'd7' ? arr.slice(-14) : arr;
  return { n: use.reduce((a, b) => a + b, 0), pts: use.length, st: res.status, axis: (d.xAxis || []).slice(-1)[0] };
}

// 采样流量峰值。
// 【本地无历史流量接口】(2026-09-20 实测):
//   大屏对告警类接口传 timeAgo=h24, 但对 /netflowTPS|/netflowHTTP|/netflowDNS 不传任何参数;
//   加 cache-buster 后三个时间窗变体返回【逐字节相同】的数据 → 确认它只有 50 秒实时窗, 不认时间窗。
//   740KB 的大屏设计器配置(screensConfig)里, 流量卡片也只挂了这三个接口, 没有任何峰值接口。
//   所以"本日流量峰值"只能靠【跨轮次累积】: 每次采集取一次实时窗口最大值, 与当天历史值比大,
//   跨天自动归零。采集跑得越勤, 越接近真实日峰值。
// 【单位换算(实测 12/12 次比值恒为 8.000)】: yv 是【字节/秒】, 大屏显示的是【比特/秒】,
//   故 bps = yv * 8。例: yv=111311612 → 890.5Mb/s → 0.89Gb/s。
function accumulateFlowPeak(cfg, id, yvMax) {
  const f = path.join(cfg.root, 'apt_flow_peak.json');
  const today = new Date().toISOString().slice(0, 10);
  let st = {};
  try { st = lib.readJson(f) || {}; } catch (e) { st = {}; }
  const prev = st[id];
  const cur = (prev && prev.date === today && Number(prev.peakBps) > 0)
    ? Math.max(Number(prev.peakBps), Number(yvMax) || 0)
    : (Number(yvMax) || 0);
  st[id] = { date: today, peakBps: cur, samples: ((prev && prev.date === today) ? (prev.samples || 0) : 0) + 1 };
  try { lib.writeJson(f, st); } catch (e) {}
  return st[id];
}

// APT 扩展指标: 版本 / 策略库 / 告警 / 流量
async function harvestMetrics(page, token, dcfg, cfg) {
  const out = {};
  const [ver, strat, info, h24, d7, flow] = await Promise.all([
    apiGet(page, '/system/checkOnlineVersion', token),
    apiGet(page, '/system/checkOnlineStrategy', token),
    apiGet(page, '/system/licence/info', token),
    riskTotal(page, token, 'h24'),
    riskTotal(page, token, 'd7'),
    apiGet(page, '/netflowTPS?_t=' + Date.now(), token),
  ]);

  const dv = dataOf(ver) || {};
  // masterVersion 是本机当前版本; code=-2 / cloudVersion="暂无数据" 表示【云端不可达】(本环境在内网), 不是采集失败
  out.platformVersion = dv.masterVersion || dv.version || '';
  out.versionCloudOk = Number(dv.code) === 0;

  const ds = dataOf(strat) || {};
  out.strategyVersion = ds.currentVersion || '';
  out.strategyCloudOk = Number(ds.code) === 0;

  const di = dataOf(info) || {};
  out.productModel = di.productModel || '';
  out.productName = di.productName || '';
  out.productSN = di.productSN || '';
  out.licenseContract = di.contractNumber || '';

  out.alarmToday = h24.n;
  out.alarmTodayPts = h24.pts;
  out.alarmWeek = d7.n;
  out.alarmWeekPts = d7.pts;

  const df = dataOf(flow);
  let yvMax = 0;
  if (Array.isArray(df)) for (const p of df) { const v = Number(p.yv); if (Number.isFinite(v) && v > yvMax) yvMax = v; }
  const acc = accumulateFlowPeak(cfg, dcfg.id, yvMax);
  out.flowPeakBps = acc.peakBps;
  out.flowPeakGbps = acc.peakBps * 8 / 1e9;   // yv 是字节/秒 → ×8 得比特/秒 → /1e9 得 Gb/s
  out.flowSamples = acc.samples;
  out.flowPeakDate = acc.date;
  return out;
}

async function collect(ctx, dcfg, cfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const page = await ctx.newPage();
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const sessionFile = path.join(cfg.root, `apt_session_${dcfg.id}.json`);
  try {
    // 会话复用（须在导航前 addInitScript 才生效）
    const hadSession = await lib.restoreSession(page, ctx, sessionFile);
    await page.goto(`${host}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    // 真判据：URL 已离开登录页 且 有 token 键（登录页自带 APT_THIRD_AUTH_LOGIN，仅凭键会误判）
    const authKeys = await lsAuthKeys(page);
    const offLogin = !/(^|\/)(#\/)?login/i.test(page.url());
    let loggedIn = authKeys.length > 0 && offLogin;
    if (loggedIn) {
      lib.log(`${dcfg.product}: 复用已保存会话 (免验证码)`);
    }
    if (!loggedIn) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const b64 = await getCaptcha(page);
        if (!b64) { await page.waitForTimeout(800); continue; }
        // 验证码一次性(2026-09-20 实测 /auth/captcha 重取即换新图) → 一张图只提交一个共识候选。
        // 旧代码把各引擎候选串行全试: ddd 一旦读错, 这张验证码就被消耗掉, 后面更准的候选也没机会。
        // captchaLen 必须传 —— APT 是 5 位, 按 4 位过滤会把四个引擎都读对的答案整个滤掉(实测 3mdmx)。
        const code = await lib.pickOneCaptcha(['ddd', 'bastion', 'enhanced', 'ls'], lib.b64Buffer(b64), cfg, dcfg.captchaLen);
        if (!code) { await page.waitForTimeout(600); continue; }
        try {
          const res = await tryLogin(page, dcfg, code);
          if (!/login/i.test(res.url)) { loggedIn = true; }
        } catch (e) {}
        lib.log(`${dcfg.product} 第${attempt + 1}轮 提交 ${code} → ${loggedIn ? '成功' : '未过'}`);
        if (loggedIn) break;
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      if (!loggedIn) { r.error = `登录失败（6 轮验证码均未过, 每轮取新图并只提交一个 ${dcfg.captchaLen || 4} 位共识候选）`; return r; }
      await lib.saveSession(page, ctx, sessionFile).catch(() => {});
      lib.log(`${dcfg.product}: 登录成功，会话已保存 ${path.basename(sessionFile)}`);
    }

    // 调 /system/status —— 必须带 Authorization: Bearer(见 apiGet 注释, 这就是采集失败的根因之一)
    let token = await readToken(page);
    let st0 = await apiGet(page, '/system/status', token);
    // token 过期(但 SPA 还没跳登录页)时, 用会话续一次: 重新走登录拿新 token 再打
    if (st0.status === 401 || /token过期|缺少token/.test(st0.text)) {
      lib.log(`${dcfg.product}: token 已过期, 重登后重试`);
      await page.goto(`${host}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      for (let attempt = 0; attempt < 6; attempt++) {
        const b64 = await getCaptcha(page);
        if (!b64) { await page.waitForTimeout(800); continue; }
        const code = await lib.pickOneCaptcha(['ddd', 'bastion', 'enhanced', 'ls'], lib.b64Buffer(b64), cfg, dcfg.captchaLen);
        if (!code) { await page.waitForTimeout(600); continue; }
        const res = await tryLogin(page, dcfg, code).catch(() => ({ url: page.url() }));
        if (!/login/i.test(res.url)) { await lib.saveSession(page, ctx, sessionFile).catch(() => {}); break; }
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      token = await readToken(page);
      st0 = await apiGet(page, '/system/status', token);
    }
    const line0 = await apiGet(page, '/system/status/line', token);
    const status = { '/system/status': { st: st0.status, body: st0.text }, '/system/status/line': { st: line0.status, body: line0.text } };

    // 解析 CPU/内存/磁盘
    let cpu = null, mem = null, disk = null, raw = '';
    const st = status['/system/status'] && status['/system/status'].body;
    const line = status['/system/status/line'] && status['/system/status/line'].body;
    raw = st || '';
    try {
      const j = JSON.parse(st || '{}');
      const d = j.data || j;
      // 常见字段（APT 实测 /system/status: data.cpuused/memused/syshdused 均为百分数）
      const pick = (o, names) => { for (const n of names) if (o[n] != null) return o[n]; return null; };
      cpu = parseFloat(pick(d, ['cpuused', 'cpu', 'cpuUsage', 'cpuUtilization', 'cpuRate', 'cpuPercent', 'cpuUsageRate']));
      mem = parseFloat(pick(d, ['memused', 'mem', 'memory', 'memoryUsage', 'memRate', 'memoryPercent', 'ramUsage', 'memoryUsageRate']));
      disk = parseFloat(pick(d, ['syshdused', 'syshd', 'disk', 'diskUsage', 'diskRate', 'diskPercent', 'diskUsageRate']));
    } catch (e) {}
    // NaN/Inf 归空，交给下方 null 判断走错误/兜底路径，避免脏 series
    if (!Number.isFinite(cpu)) cpu = null;
    if (!Number.isFinite(mem)) mem = null;
    if (!Number.isFinite(disk)) disk = null;
    // 若接口是文本/其他格式，尝试从 status/line 提取
    if (cpu == null && line) {
      const m2 = line.match(/cpu[^0-9]*([\d.]+)/i) || line.match(/CPU[^0-9]*([\d.]+)/);
      if (m2) cpu = parseFloat(m2[1]);
    }
    if (cpu == null || mem == null) {
      r.error = '/system/status 未解析到资源: ' + raw.slice(0, 300);
      r.remarks = '接口返回: ' + raw.slice(0, 200);
      return r;
    }

    // APT 扩展指标(版本/策略库/告警/流量) —— 失败不影响 CPU/内存/磁盘 主指标
    let m = null;
    try {
      m = await harvestMetrics(page, token, dcfg, cfg);
      r.aptMetrics = m;
      // 提成结构化字段, 让 master 行也带版本号(需求: 所有产品都要有版本号)
      if (m.platformVersion) r.productVersion = m.platformVersion;
      if (m.productSN) r.deviceSN = m.productSN;
    } catch (e) {
      lib.log(`${dcfg.product}: 扩展指标采集异常 ${String(e.message || e).slice(0, 120)}`);
    }

    const bits = [];
    if (m && m.platformVersion) bits.push(`版本 ${m.platformVersion}`);
    if (m && m.strategyVersion) bits.push(`策略库 ${m.strategyVersion}`);
    if (m && m.alarmToday != null) bits.push(`本日告警 ${m.alarmToday}`);
    if (m && m.alarmWeek != null) bits.push(`近7天告警 ${m.alarmWeek}`);
    if (m && m.flowPeakGbps != null) bits.push(`流量峰值 ${m.flowPeakGbps.toFixed(3)}Gb/s`);

    lib.fillOk(r, {
      cpu, mem, disk: disk == null ? 0 : disk,
      remarks: `${dcfg.product}(${host}) /system/status实时快照` + (bits.length ? ' | ' + bits.join(' · ') : ''),
      source: 'apt /system/status',
    });
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
