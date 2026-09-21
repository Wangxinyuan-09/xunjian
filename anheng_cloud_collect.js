// 安恒云专享实例 — 资源利用率 + 版本号采集（13 个实例全覆盖）
//
// 【为什么要有这个脚本】13 个专享实例的产品会话拿不到(被 CAS/SSO 弹回 login.html),
// 只能从控制台借道: 登录控制台 → 点「专享型产品」页签 → 行内点「配置」→ 新标签页自带 SSO 登录态,
// 之后所有接口都从这个标签页里发(不用自己拼鉴权)。产品真实地址在 9443 + `tgws<产品>tgwe` 前缀
// (控制台给的 accessUrl 端口常常是错的)。
//
// 【实时性要求(2026-09-21 用户明确)】每次巡检都要取实时数据, 不能用之前存下来的。
//   → 所以本模块被 xunjian_all.js 直接调用, 是巡检流程的一部分, 不是"跑一次存一年"的离线脚本。
//   → 每个实例成功后写 inst.resourceCollectedAt; 失败的实例【保留旧值但显式标注失败】,
//     不允许把旧数据伪装成本次采集。
//
// 取数方式分两类:
//   A. 有历史接口 → 拉 7 天算 avg/max(数据库审计/网关/API风险监测/APT);
//   B. 只有实时值 → 单点序列 + live 标记(防火墙/日志审计/加解密/WAF), 备注写明"实时值, 峰值=当前值"。
//   用户 2026-09-21 明确: 日志审计/加解密/防火墙-19 这类"只要实时值"即可。
//
// 凭据: 环境变量 ANHENG_CLOUD_USER / ANHENG_CLOUD_PASSWORD，或 xunjian_config.local.js
//   的 anhengCloud 段（见 xunjian_config.local.example.js）。
//   【Windows 坑】父进程若早于用户设置 User 级环境变量启动, 子进程继承的是旧环境块,
//   此时 process.env 里是空的 —— 兜底读 Windows 用户级注册表(envVar())。
//   密码只在脚本内部使用, 不打印。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const lib = require('./xunjian_lib');
const cfg = require('./xunjian_config');

// 控制台地址来自配置（真实值在 xunjian_config.local.js，不入库）
const CONSOLE = cfg.anhengCloud.console;
const CONSOLE_LIST = CONSOLE + '/index.html#/productManagement/teamProductInstance';
const SESSION = path.join(__dirname, 'anheng_cloud_session.json');
const OUT = path.join(__dirname, 'anheng_collected.json');
const FLOW_PEAK = path.join(__dirname, 'apt_flow_peak.json');

function envVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execSync(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}','User')"`,
      { encoding: 'utf8' }
    ).trim();
  } catch (e) {
    return '';
  }
}

// 版本号一定含数字(V4.0R75C00 / WAF-V3.0R47C59 / TC_nologo_fw 20251231 / APIG-V3.0R26C00-aarch64);
// 产品名不含数字。用来挡掉"数据库安全网关"这类被当成版本上报的脏值。
const looksLikeVersion = (s) => !!s && /\d/.test(String(s));

// ---------- 控制台登录 ----------
async function loginConsole(ctx) {
  const page = await ctx.newPage();
  await lib.restoreSession(page, ctx, SESSION);
  await page.goto(CONSOLE_LIST, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const onLogin = await page.evaluate(() => /login\.html/.test(location.href) || !!document.querySelector('input[type=password]')).catch(() => false);
  if (!onLogin) {
    lib.log('安恒云: 复用已保存会话');
    return page;
  }
  // 先看配置(它已合并 环境变量 与 xunjian_config.local.js)，再用注册表兜底
  const user = cfg.anhengCloud.user || envVar('ANHENG_CLOUD_USER');
  const pass = cfg.anhengCloud.pass || envVar('ANHENG_CLOUD_PASSWORD');
  if (!user || !pass) {
    throw new Error('缺少安恒云控制台凭据：设环境变量 ANHENG_CLOUD_USER / ANHENG_CLOUD_PASSWORD，'
      + '或写进 xunjian_config.local.js 的 anhengCloud 段');
  }
  lib.log('安恒云: 会话失效, 用凭据重新登录');
  await page.locator('input[type=text], input[type=username]').first().fill(user).catch(() => {});
  await page.locator('input[type=password]').first().fill(pass).catch(() => {});
  await page.getByRole('button').filter({ hasText: /登\s*录|登\s*陆/ }).first().click({ timeout: 8000 }).catch(async () => {
    await page.locator('button[type=submit], .login-btn, [class*=login] button').first().click({ timeout: 5000 }).catch(() => {});
  });
  await page.waitForTimeout(6000);
  const ok = await page.evaluate(() => !/login\.html/.test(location.href)).catch(() => false);
  if (!ok) throw new Error('安恒云控制台登录失败(URL 仍在 login.html)');
  await lib.saveSession(page, ctx, SESSION).catch(() => {});
  lib.log('安恒云: 登录成功, 已保存会话');
  await page.goto(CONSOLE_LIST, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return page;
}

// ---------- 控制台「专享型产品」列表 ----------
// 默认停在 SaaS型产品 页签, 必须先点「专享型产品」(是页签不是路由, URL 不变)
async function selectDedicatedTab(page) {
  await page.evaluate(() => {
    const c = [];
    for (const el of document.querySelectorAll('li,div,span,a,button')) {
      if ((el.innerText || '').trim() !== '专享型产品') continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) c.push({ a: r.width * r.height, el });
    }
    c.sort((x, y) => x.a - y.a);
    if (c.length) c[0].el.click();
  }).catch(() => {});
  await page.waitForTimeout(3500);
}

async function scrapeProductList(page) {
  return page.evaluate(() => {
    const rows = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim());
      if (cells.length < 4) continue;
      const joined = cells.join('|');
      if (!/专享|实例|-/.test(joined)) continue;
      rows.push(cells);
    }
    return rows;
  }).catch(() => []);
}

// ---------- 打开某个产品的配置页(新标签页, 已带 SSO 登录态) ----------
async function openProduct(ctx, consolePage, want) {
  const p = ctx.waitForEvent('page', { timeout: 30000 }).catch(() => null);
  const ok = await consolePage
    .locator('tr', { hasText: want })
    .locator('text=配置')
    .first()
    .click({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) return null;
  const np = await p;
  if (!np) return null;
  await np.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await np.waitForTimeout(6000);
  return np;
}

// 从标签页自己的 URL 推出接口基址。
// 【为什么不能硬编码】同一个产品在不同实例上路径不一样: 数据库审计走 /tgwsahdatabaseaudit84tgwe/,
// 而数据库安全网关直接是 https://host:10050/(没有 tgws 前缀)。用页面自己的 URL 推最稳。
function pageBase(np) {
  const u = new URL(np.url());
  const seg = u.pathname.split('/')[1] || '';
  const dir = /^tgws/i.test(seg) ? `/${seg}/` : '/';
  return { origin: u.origin, dir, base: u.origin + dir };
}

// 抓页面【自己发的】某个请求的响应体。
// 【为什么不能自己 fetch】数据加解密-32 的接口要 Authorization: Bearer <JWT>, 而这个 JWT 只存在
// SPA 内存里(sessionStorage 只有 workInfo/userInfo, localStorage 是空的), 会话恢复后自己拼不出来 ——
// 直接 inPage('/hsmmngbackend/index/basicInfo') 会拿到
// {"msg":"Full authentication is required to access this resource","code":500}(2026-09-21 实测)。
// 绕法: 挂 response 钩子再 reload, 让页面带着它自己的头去请求, 我们从响应里读。
function captureResponse(np, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const h = async (res) => {
      if (done || !pattern.test(res.url())) return;
      try {
        const t = await res.text();
        done = true;
        let j = null;
        try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.status(), text: t, json: j });
      } catch (e) {}
    };
    np.on('response', h);
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 20000);
  });
}

// 页面内 fetch(带 cookie)
async function inPage(np, url) {
  return np.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      const t = await r.text();
      let j = null;
      try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, text: t, json: j };
    } catch (e) {
      return { status: 0, text: 'ERR ' + String(e.message || e), json: null };
    }
  }, url);
}

const qs = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// 采样点 → 7 天按日 avg/max。
// 注意 avg 与 max 要【分开分桶】: 历史接口每小时点自带 {avg,max}, 日报里的"日均"应是小时均值的均值,
// 而"日峰值"应是小时峰值里的最大 —— 混着算会把峰值拉平。
function dailyFrom(points) {
  const sa = points.map((p) => ({ timeMs: p.t, value: p.avg })).filter((s) => !isNaN(s.value));
  const sm = points.map((p) => ({ timeMs: p.t, value: p.max })).filter((s) => !isNaN(s.value));
  const A = lib.bucketByDay(sa, { endMs: Date.now() });
  const M = lib.bucketByDay(sm, { endMs: Date.now() });
  if (!A.avg.length) return null;
  return { days: A.days, avg: A.avg, max: M.max.length ? M.max : A.max };
}

// 小时级采样序列(只有 value) → 7 天按日
function toDaily(samples) {
  const b = lib.bucketByDay(samples, { endMs: Date.now() });
  return { days: b.days, avg: b.avg, max: b.max };
}

function weeklyAvgOf(daily) {
  if (!daily || !daily.avg || !daily.avg.length) return null;
  const m = (a) => lib.round1(a.reduce((x, y) => x + y, 0) / a.length);
  return m(daily.avg);
}

// 只有实时值的产品: 单点序列 + live 标记。
// 【不要再复制 7 份】用户 2026-09-21 明确"只要实时值" —— 复制 7 份会让峰值列看起来像一条
// 真实平稳曲线, 汇报时会被误读成"7 天都这么稳"。单点数组平均后就是当前值, 报表口径清楚。
function liveSeries(v) {
  return { days: [], avg: [v], max: [v], live: true };
}

function pct(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return s.includes('%') ? lib.round1(n) : lib.round1(n * 100);
}

// ============================================================
// 各产品适配器
// 返回 { version, source, note, series, licenseEnd?, aptMetrics? }
//   series 为 null 表示该产品确实没有资源数据(留空出表, 不编造)
//   series = { cpu, mem, disk }, 每个是 {days, avg, max, live?} 或 null
// ============================================================

// 数据库审计 / 数据库安全网关: 同一套 webapi, 只是 family 和版本号不同
//   GET /webapi/<family>/<ver>/GetAllSystemResourceByTimeRange.json?data={StartTime,EndTime,Interval,ResourceType}
//   GET /webapi/<family>/<ver>/DescribeApplication.json → Version(产品版本)
async function dbResource(np, { family, apiVer, label }) {
  const { origin, dir } = pageBase(np);
  const out = { source: `${label} GET /webapi/${family}/${apiVer}/GetAllSystemResourceByTimeRange.json (7天,小时级)`, note: '' };
  const call = async (name, data) => {
    const url = `${origin}${dir}webapi/${family}/${apiVer}/${name}.json?` +
      qs({ data: JSON.stringify(data), regionId: '', secToken: '', requestId: String(Date.now()) });
    return inPage(np, url);
  };
  const now = Date.now();
  const start = now - 7 * 86400000;
  const series = {};
  const detail = [];
  for (const [key, rt] of [['cpu', 'system_cpu_usage'], ['mem', 'system_memory_usage'], ['disk', 'disk_space_usage']]) {
    let r = await call('GetAllSystemResourceByTimeRange', { StartTime: start, EndTime: now, Interval: '1h', ResourceType: rt, InstanceId: '' });
    let arr = (r.json && r.json.data && r.json.data.data) || [];
    // 老固件把磁盘写成 disk_usage, 新固件是 disk_space_usage —— 兜一下, 别因为字段改名就丢磁盘
    if (!arr.length && key === 'disk') {
      r = await call('GetAllSystemResourceByTimeRange', { StartTime: start, EndTime: now, Interval: '1h', ResourceType: 'disk_usage', InstanceId: '' });
      arr = (r.json && r.json.data && r.json.data.data) || [];
    }
    const pts = arr
      .map((x) => ({ t: x.time, avg: parseFloat(x.avg), max: x.max == null ? parseFloat(x.avg) : parseFloat(x.max) }))
      .filter((p) => !isNaN(p.avg));
    const d = pts.length ? dailyFrom(pts) : null;
    series[key] = d;
    detail.push(`${key}=${d ? d.avg.length + '天/' + pts.length + '点' : '无'}`);
    if (key === 'cpu' && !d) {
      out.error = `GetAllSystemResourceByTimeRange 无数据(${r.status}): ` + String(r.text || '').slice(0, 200);
      return out;
    }
  }
  out.note = detail.join(' ') + '; 历史接口原始点(小时级)';
  // 版本: DescribeApplication 的 Version(如 V4.0R75C00SPC001-ARM-XC)
  const a = await call('DescribeApplication', { locale: 'zh_CN', InstanceId: '' });
  const ad = (a.json && a.json.data) || {};
  if (looksLikeVersion(ad.Version)) out.version = String(ad.Version).trim();
  if (ad.ExpireTime) out.licenseEnd = String(ad.ExpireTime).slice(0, 10);
  return { ...out, series };
}

// 点页面上最小的那个文本精确匹配的可点元素(菜单项常常嵌套好几层 div/span)
async function clickText(np, text) {
  return np.evaluate((t) => {
    const c = [];
    for (const el of document.querySelectorAll('li,a,div,span,button')) {
      if ((el.innerText || '').trim() !== t) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      c.push({ a: r.width * r.height, el });
    }
    c.sort((p, q) => p.a - q.a);
    if (!c.length) return false;
    c[0].el.click();
    return true;
  }, text).catch(() => false);
}

// API风险监测系统-47 (AAS): 腾讯云风格接口, 请求要 secToken 签名。
// 【签名怎么来的】secToken = <4位hex签名 sig><D × sig>;  sig = sha256(`${D}:${data}:${requestId}`).substring(4,8)。
//   D = 55570(2026-09-21 两次独立观测反解一致), 但【不硬编码】—— 每次从页面自己发的那个请求里
//   观测 secToken 反解出 D, 先用观测到的 data/requestId 自检(算出来一致才敢用), 再用 7 天窗口重签。
//   自检不过就用页面自己那一份 10 分钟数据当实时值, 绝不瞎签。
// 【为什么要先点菜单】这个请求只在 系统管理→系统维护→资源使用 页面才发, 不点就没有可观测的样本。
// 响应结构: data.systemResourceItems[] → { systemResourceItemKey, systemResourceItemValues[] }
//   key: cpu_usage_rate / memory_usage_rate / swap_usage_rate / disk_usage_rate / disk_*_speed ...
//   value: { systemResourceHistoryClock(unix秒), systemResourceHistoryValueAvg, ...ValueMax }
//   7 天窗口返回 85 点(约 2 小时一个点)。
async function aas47(np) {
  const { origin, dir } = pageBase(np);
  const out = { source: 'GET /webapi/aas/5.0/DescribeSystemResourceItem.json (7天)', note: '' };
  let obsUrl = null;
  np.on('request', (rq) => {
    const u = rq.url();
    if (!obsUrl && /DescribeSystemResourceItem/.test(u)) obsUrl = u;
  });
  // 走到资源使用页, 逼页面发出那个带签名的请求
  for (const s of ['系统管理', '系统维护', '资源使用']) {
    await clickText(np, s);
    await np.waitForTimeout(4000);
  }
  for (let i = 0; i < 20 && !obsUrl; i++) await np.waitForTimeout(1000);
  if (!obsUrl) return { ...out, error: '未观测到 DescribeSystemResourceItem(菜单没走到资源使用页?)' };

  const u = new URL(obsUrl);
  const data = u.searchParams.get('data') || '';
  const rid = u.searchParams.get('requestId') || '';
  const sec = u.searchParams.get('secToken') || '';
  let D = '';
  let ok = false;
  try {
    const sig = sec.slice(0, 4);
    const rest = BigInt('0x' + sec.slice(4));
    const sigN = BigInt('0x' + sig);
    if (sigN > 0n) D = (rest / sigN).toString();
    const mine = require('crypto').createHash('sha256').update(`${D}:${data}:${rid}`).digest('hex').substring(4, 8);
    ok = mine === sig;
  } catch (e) { ok = false; }
  if (!ok) return { ...out, error: `secToken 签名反解自检未通过(sec=${sec}), 不敢重签 → 放弃本实例` };

  const nowSec = Math.floor(Date.now() / 1000);
  const r = await np.evaluate(async ({ origin, dir, Dn, startSec, endSec }) => {
    const sha = async (s) => {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    const D = Number(Dn);
    const body = JSON.stringify({ startTime: startSec, endTime: endSec });
    const rid2 = String(Date.now());
    const sig = (await sha(`${D}:${body}:${rid2}`)).substring(4, 8);
    const secT = sig + (D * (parseInt(sig, 16) || 1)).toString(16);
    const url = `${origin}${dir}webapi/aas/5.0/DescribeSystemResourceItem.json?requestId=${rid2}&data=${encodeURIComponent(body)}&regionId=&secToken=${secT}`;
    try {
      const res = await fetch(url, { credentials: 'include' });
      const t = await res.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: res.status, text: t.slice(0, 2000), json: j };
    } catch (e) { return { status: 0, text: String(e.message || e), json: null }; }
  }, { origin, dir, Dn: D, startSec: nowSec - 7 * 86400, endSec: nowSec }).catch((e) => ({ status: 0, text: String(e.message || e), json: null }));

  const items = (r.json && r.json.data && r.json.data.systemResourceItems) || [];
  if (!items.length) return { ...out, error: `7 天重签请求无数据(${r.status}): ` + String(r.text).slice(0, 200) };

  const series = {};
  const detail = [];
  const WANT = { cpu_usage_rate: 'cpu', memory_usage_rate: 'mem', disk_usage_rate: 'disk' };
  for (const it of items) {
    const k = WANT[it.systemResourceItemKey];
    if (!k) continue;
    const pts = (it.systemResourceItemValues || [])
      .map((v) => ({
        t: Number(v.systemResourceHistoryClock) * 1000,
        avg: parseFloat(v.systemResourceHistoryValueAvg),
        max: v.systemResourceHistoryValueMax == null ? parseFloat(v.systemResourceHistoryValueAvg) : parseFloat(v.systemResourceHistoryValueMax),
      }))
      .filter((p) => p.t && !isNaN(p.avg));
    series[k] = pts.length ? dailyFrom(pts) : null;
    detail.push(`${k}=${series[k] ? series[k].avg.length + '天/' + pts.length + '点' : '无'}`);
  }
  if (!series.cpu || !series.mem || !series.disk) {
    return { ...out, error: 'systemResourceItems 缺 cpu/memory/disk 任一项: ' + detail.join(' ') };
  }
  for (const k of ['cpu', 'mem', 'disk']) if (!series[k]) series[k] = null;
  out.note = detail.join(' ') + `; 签名 D 自检通过(每 2 小时一点)`;
  // 版本: AAS 没有 DescribeApplication 那套同源接口, 这里【不猜也不编】——
  //   上游模板里 productVersion 填的是产品名"恒脑API风险监测系统"(被 looksLikeVersion 挡掉显示为 —),
  //   留空比把产品名当版本号上报强。
  return { ...out, series };
}

// APT攻击预警-36: 系统 → 系统资源。历史接口 system/status/line 返回 169 个小时点(正好 7 天)
async function apt36(np) {
  const { base } = pageBase(np);
  const out = { source: 'GET ' + base.replace(/^https?:\/\/[^/]+/, '') + 'system/status/line (7天,小时级)', note: '' };
  const line = await inPage(np, base + 'system/status/line?_t=' + Date.now());
  const d = (line.json && line.json.data) || {};
  const arr = d.cpuused;
  if (!Array.isArray(arr) || !arr.length) {
    return { ...out, error: 'system/status/line 无 cpuused 数组: ' + String(line.text).slice(0, 200) };
  }
  // xAxis 是 "MM-DD HH" 没有年份; 小时级序列末点=现在, 直接按 1h 反推时间轴,
  // 比解析不带年份的字符串再猜跨年稳(2026-09-21 实测 169 点恰好覆盖 7×24h)
  const n = arr.length;
  const nowMs = Date.now();
  const mk = (a) => a.map((v, i) => ({ timeMs: nowMs - (n - 1 - i) * 3600000, value: parseFloat(v) })).filter((s) => !isNaN(s.value));
  const cpu = toDaily(mk(arr));
  const mem = toDaily(mk(d.memuused || []));
  const disk = toDaily(mk(d.syshdused || []));
  const dataHd = Array.isArray(d.datahdused) && d.datahdused.length ? toDaily(mk(d.datahdused)) : null;
  if (!mem.avg.length || !disk.avg.length) return { ...out, error: 'memuused/syshdused 数组缺失' };
  out.note = `磁盘取【系统盘】${disk.avg[disk.avg.length - 1]}%` +
    (dataHd ? `; 数据盘 ${dataHd.avg[dataHd.avg.length - 1]}%` : '') +
    `; 小时级 ${n} 点`;
  const m = await apt36Metrics(np, base, out);
  return { ...out, series: { cpu, mem, disk } };
}

// APT 扩展指标(需求3): 策略库版本 / 告警情况(本日+近一周) / 流量峰值 —— 云上 APT-36 也要有
async function apt36Metrics(np, base, out) {
  const token = await np.evaluate(() => {
    const raw = localStorage.getItem('echo_token');
    if (!raw) return '';
    try {
      const p = JSON.parse(raw);
      if (typeof p === 'string') return p;
      if (p && typeof p.token === 'string') return p.token;
    } catch (e) {}
    return raw;
  }).catch(() => '');
  const api = async (p) => np.evaluate(async ({ url, token }) => {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, credentials: 'include' });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, text: t.slice(0, 4000), json: j };
    } catch (e) { return { status: 0, text: String(e.message || e), json: null }; }
  }, { url: p, token }).catch(() => ({ json: null, text: '' }));
  const dataOf = (r) => (r && r.json && r.json.data !== undefined ? r.json.data : null);

  const m = {};
  const cv = await api(base + 'system/checkOnlineVersion');
  const dv = dataOf(cv) || {};
  m.platformVersion = dv.masterVersion || dv.version || '';
  m.versionCloudOk = Number(dv.code) === 0 || !dv.code;

  const cs = await api(base + 'system/checkOnlineStrategy');
  const ds = dataOf(cs) || {};
  m.strategyVersion = ds.currentVersion || '';
  m.strategyCloudOk = Number(ds.code) === 0 || !ds.code;

  // 告警: timeAgo=h24 → 本日(逐小时 25 点); timeAgo=d7 → 每半天 1 点共 16 点, 取末尾 14 点=最近 7 个整天
  const risk = async (timeAgo) => {
    const r = await api(base + `navigate/getRiskTrend?timeAgo=${timeAgo}`);
    const d = dataOf(r);
    if (!d || !Array.isArray(d.total)) return { n: null, pts: 0 };
    const a = d.total.map(Number).filter(Number.isFinite);
    const use = timeAgo === 'd7' ? a.slice(-14) : a;
    return { n: use.reduce((x, y) => x + y, 0), pts: use.length };
  };
  const h24 = await risk('h24'); const d7 = await risk('d7');
  m.alarmToday = h24.n; m.alarmTodayPts = h24.pts;
  m.alarmWeek = d7.n; m.alarmWeekPts = d7.pts;

  // 流量: 只有 50 秒实时窗(无历史接口) → 跨轮次累积当日峰值, 与本地 LC1/LC2 同一算法
  const fl = await api(base + 'netflowTPS?_t=' + Date.now());
  const df = dataOf(fl);
  let yvMax = 0;
  if (Array.isArray(df)) for (const p of df) { const v = Number(p.yv); if (Number.isFinite(v) && v > yvMax) yvMax = v; }
  const acc = accumulateFlowPeak('cloud_36', yvMax);
  m.flowPeakBps = acc.peakBps;
  m.flowPeakGbps = acc.peakBps * 8 / 1e9;
  m.flowSamples = acc.samples;
  m.flowPeakDate = acc.date;

  if (m.platformVersion && looksLikeVersion(m.platformVersion)) out.version = m.platformVersion;
  out.note += `; 策略库 ${m.strategyVersion || '—'} 本日告警 ${m.alarmToday == null ? '—' : m.alarmToday} 近7天 ${m.alarmWeek == null ? '—' : m.alarmWeek}`;
  out.aptMetrics = m;
  return m;
}

// 流量峰值跨轮累积(与 collect_apt.js 同一口径: yv 是字节/秒, ×8 得比特/秒)
function accumulateFlowPeak(key, yvMax) {
  const today = new Date().toISOString().slice(0, 10);
  let st = {};
  try { st = lib.readJson(FLOW_PEAK) || {}; } catch (e) { st = {}; }
  const prev = st[key];
  const cur = prev && prev.date === today && Number(prev.peakBps) > 0
    ? Math.max(Number(prev.peakBps), Number(yvMax) || 0)
    : (Number(yvMax) || 0);
  st[key] = { date: today, peakBps: cur, samples: ((prev && prev.date === today) ? (prev.samples || 0) : 0) + 1 };
  try { lib.writeJson(FLOW_PEAK, st); } catch (e) {}
  return st[key];
}

// 下一代防火墙-19: 概况界面。接口要 api_key=ST-<casTicket>, 从页面自己发的请求里捞
async function fw19(np) {
  const { base } = pageBase(np);
  const out = { source: 'GET /api/system-status, /api/host-info (实时值)', note: '' };
  let key = '';
  np.on('request', (rq) => {
    const m = rq.url().match(/api_key=(ST-[0-9a-f]+)/);
    if (m) key = m[1];
  });
  await np.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await np.waitForTimeout(8000);
  if (!key) {
    const u = await inPage(np, base + 'api/host-info?lang=cn');
    return { ...out, error: '未捕获到 api_key(ST 票据); host-info 直连返回 ' + u.status };
  }
  const q = 'lang=cn&api_key=' + key;
  const st = await inPage(np, base + `api/system-status?${q}`);
  const d = (st.json || {});
  const cpu = d.cpu && d.cpu.usage != null ? parseFloat(d.cpu.usage) : null;
  const mem = d.memory && d.memory.usage != null ? parseFloat(d.memory.usage) : null;
  const hd = d.harddisk && d.harddisk.usage != null ? parseFloat(d.harddisk.usage) : null;
  if (cpu == null || mem == null || hd == null) {
    return { ...out, error: 'system-status 缺字段: ' + String(st.text).slice(0, 250) };
  }
  const hi = await inPage(np, base + `api/host-info?${q}`);
  const h = ((hi.json || {}).data || [])[0] || {};
  if (looksLikeVersion(h.fw_version)) out.version = String(h.fw_version).trim();
  const libs = ['app_version', 'ips_version', 'av_version', 'url_version'].filter((k) => h[k]);
  out.note = '概况实时值(该产品未提供历史资源接口, 峰值=当前值)' +
    (libs.length ? '; 库版本 ' + libs.map((k) => k.replace('_version', '') + '=' + h[k]).join(' ') : '') +
    (h.uptime ? '; 运行 ' + h.uptime : '');
  return { ...out, series: { cpu: liveSeries(cpu), mem: liveSeries(mem), disk: liveSeries(hd) } };
}

// 日志审计-5: 首页接口给实时值; 性能监控页是 JSP(getApmAssetStatus 返回 HTML), 没有 JSON 历史接口
async function soc5(np) {
  const { base } = pageBase(np);
  const out = { source: 'GET /api/home/get4Block (实时值)', note: '' };
  const r = await inPage(np, base + 'api/home/get4Block?_v=' + Math.random());
  const d = (r.json && r.json.data) || {};
  const ss = d.systemStatus || {};
  const cpu = parseFloat(String(ss.cpu || '').replace('%', ''));
  const mem = parseFloat(String(ss.mem || '').replace('%', ''));
  const ls = d.logStoreUsed || {};
  const used = parseFloat(String(ls.used || '').replace(/[^\d.]/g, ''));
  const total = parseFloat(String(ls.diskTotal || '').replace(/[^\d.]/g, ''));
  if (isNaN(cpu) || isNaN(mem)) return { ...out, error: 'get4Block 缺 cpu/mem: ' + String(r.text).slice(0, 250) };
  const disk = total > 0 ? lib.round1((used / total) * 100) : null;
  if (disk == null) return { ...out, error: 'get4Block 缺 logStoreUsed 容量' };
  out.note = `实时值(性能监控是 JSP 页, 无 JSON 历史接口; 峰值=当前值); 日志盘 ${used}G/${total}G` +
    (ls.keepDay ? `; 保留 ${ls.keepDay} 天` : '');
  // 授权信息(顺带): /sys?mode=license&format=json 实体是个 JSON 字符串
  const lic = await inPage(np, base + 'sys?mode=license&format=json');
  try {
    const ent = JSON.parse((lic.json || {}).entity || '{}');
    if (ent.end) out.licenseEnd = String(ent.end).replace(/年|月/g, '-').replace(/日/g, '');
  } catch (e) {}
  // 版本: 先关掉「已在多台电脑登录」弹窗(它会挡住菜单), 再点 系统→系统升级 看当前版本。
  // 该产品没有给版本的 JSON 接口(试过 /sys?mode=version|about|sysinfo|info 全 404, 标题只有产品名)。
  await np.evaluate(() => {
    for (const el of document.querySelectorAll('button,a,span,div')) {
      const t = (el.innerText || '').trim();
      if (t !== '忽略' && t !== '关闭') continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) { el.click(); return; }
    }
  }).catch(() => {});
  await np.waitForTimeout(2000);
  const clickByText = (x) => np.evaluate((t) => {
    for (const el of document.querySelectorAll('a,li,span,div')) {
      if ((el.innerText || '').trim() !== t) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      el.click(); return true;
    }
    return false;
  }, x).catch(() => false);
  await clickByText('系统');
  await np.waitForTimeout(4000);
  await clickByText('系统升级');
  await np.waitForTimeout(6000);
  const ptxt = await np.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '');
  const pv = String(ptxt).match(/(V\d+\.\d+R?\d+[A-Z]*\d*[\w.-]*)/);
  if (pv && looksLikeVersion(pv[1])) out.version = pv[1];
  else out.note += '; 版本未取到';
  return { ...out, series: { cpu: liveSeries(cpu), mem: liveSeries(mem), disk: liveSeries(disk) } };
}

// 数据加解密服务-32: 首页 basicInfo 给内存/磁盘; CPU 历史接口 cpuEcharts 返回空数组(无数据)
async function hsmmng32(np) {
  const { base } = pageBase(np);
  const out = { source: 'GET ' + base.replace(/^https?:\/\/[^/]+/, '') + 'index/basicInfo (页面自身请求, 带 Bearer; 实时值)', note: '' };
  // 见 captureResponse 的注释: 这个接口自己有鉴权头, 必须借页面自己的请求
  const cap = captureResponse(np, /index\/basicInfo/, 25000);
  await np.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const r = (await cap) || { text: '(未捕获到 basicInfo 响应)', json: null };
  const d = (r.json && r.json.data) || {};
  // memUsedRate 是 0~1 的比值("0.66"), diskUsedRate 是带 % 的字符串("58%") —— 两种都要兼容
  const mem = pct(d.memUsedRate);
  const disk = pct(d.diskUsedRate);
  if (mem == null || disk == null) return { ...out, error: 'basicInfo 缺 memUsedRate/diskUsedRate: ' + String(r.text).slice(0, 250) };
  out.note = `实时值; 内存 ${d.memUsed || '?'}/${d.memTotal || '?'} 磁盘 ${d.diskUsed || '?'}/${d.diskTotal || '?'}` +
    `; CPU 无数据(cpuEcharts 返回空)` +
    (d.sysaMaintenanceCutOffTime ? `; 维保至 ${d.sysaMaintenanceCutOffTime}` : '');
  // 版本: versionInfo 后端长期 502(nginx 到上游不通), 试一次, 取到就用
  const v = await inPage(np, base + 'api/sys/versionInfo');
  const vm = String(v.text || '').match(/(V\d+\.\d+[A-Z]*\d*[\w.-]*)/);
  if (vm && looksLikeVersion(vm[1])) out.version = vm[1];
  else out.note += '; 版本接口不可用(502)';
  // CPU 留空: 只出 内存/磁盘 两条
  return { ...out, series: { cpu: null, mem: liveSeries(mem), disk: liveSeries(disk) } };
}

// 主机安全-4: 明御终端安全及防病毒系统。平台【确实没有】系统资源接口 ——
// 2026-09-21 复核(登录方式已确认无误, 是经控制台「配置」进来的 SSO 标签页, 页面正常显示
// 防护中31/离线34 等数据): 全页 XHR 共 41 个, 全是 dash_board/* 的终端计数, 没有一个资源类接口;
// 另外单独试过 /system/info /system/resource /system/status /systemInfo /resource /system/base_info
// /system/disk /monitor/system /dashboard/system /sysinfo 等 13 个候选路径, 全部 404。
// 本机同款产品(collect_hs.js)同样只采版本与库版本, 从不采 CPU/内存/磁盘。
async function edr4(np) {
  const { base } = pageBase(np);
  const out = { source: 'GET ' + base.replace(/^https?:\/\/[^/]+/, '') + 'settings', note: '' };
  const s = await inPage(np, base + 'settings');
  const v = s.json && s.json.setting && s.json.setting.auth && s.json.setting.auth.admin && s.json.setting.auth.admin.version;
  if (looksLikeVersion(v)) out.version = String(v).trim();
  const ns = await inPage(np, base + 'dash_board/node_state');
  const nd = (ns.json && ns.json.data) || {};
  const parts = Object.keys(nd).map((k) => `${k}${nd[k]}`);
  out.note = '该产品未提供系统资源接口(全页 41 个 XHR 无资源类 + 13 个候选路径均 404), 资源列留空' +
    (parts.length ? '; 终端状态 ' + parts.join(' ') : '');
  return { ...out, series: null };
}

// 数据分类分级安全管理-61 (AiSort): 纯业务应用, 无系统资源页
async function aisort61(np) {
  const { base } = pageBase(np);
  const out = { source: 'GET /asset/license/info', note: '' };
  const r = await inPage(np, base + 'asset/license/info').catch(() => null);
  const d = (r && r.json && r.json.data) || {};
  // 用户 2026-09-21: 资源利用率【暂时写"web端无数据"】
  out.note = 'web端无数据';
  if (d.other && d.other.agentNum != null) out.note += `; 代理数 ${d.other.agentNum}`;
  return { ...out, series: null };
}

// Web应用防火墙-3: JSP 应用, 系统概况页的 rpc-situation 给实时值(干净 JSON)。
// 【历史数据页没有可用的取数接口】2026-09-21 实测: 历史页的查询按钮走 history.js,
// 页面 HTML 与 app.waf.js 里都搜不到 hardware_usage / rpc-history-chart 的请求构造;
// 直接按旧记录的 main.m?a=rpc-history-chart&chart=hardware_usage 调用返回
// error_0x120401(鉴权口径不符) 或 JS 跳转回 main.m; 也试过驱动 UI 填时间+点查询, 请求根本没发出。
// → 按"只有实时值"处理(与日志审计/加解密/防火墙-19 同口径)。
async function waf3(np) {
  const { origin, dir } = pageBase(np);
  const out = { source: 'GET /main.m?a=rpc-situation (实时值)', note: '' };
  const r = await inPage(np, `${origin}${dir}main.m?a=rpc-situation&timestamp=${Date.now()}`);
  let arr = null;
  try {
    const t = String(r.text || '').trim();
    arr = JSON.parse(t);
  } catch (e) { arr = null; }
  const d = Array.isArray(arr) ? arr[0] : null;
  if (!d) return { ...out, error: 'rpc-situation 返回非预期: ' + String(r.text).slice(0, 250) };
  const cpu = d.cpu_usage == null ? null : lib.round1(parseFloat(d.cpu_usage));
  // mem_usage "1821396/8164332" (KB) → 百分比
  const memP = String(d.mem_usage || '').split('/');
  const mem = memP.length === 2 && parseFloat(memP[1]) > 0 ? lib.round1((parseFloat(memP[0]) / parseFloat(memP[1])) * 100) : null;
  // disk_usage "root/4555/21691|data/352958/522222" → 取系统分区(root)
  let disk = null; let diskNote = '';
  for (const seg of String(d.disk_usage || '').split('|')) {
    const p = seg.split('/');
    if (p.length === 3 && p[0] === 'root' && parseFloat(p[2]) > 0) disk = lib.round1((parseFloat(p[1]) / parseFloat(p[2])) * 100);
    if (p.length === 3 && p[0] === 'data' && parseFloat(p[2]) > 0) diskNote = `数据分区 ${lib.round1((parseFloat(p[1]) / parseFloat(p[2])) * 100)}%`;
  }
  if (cpu == null || mem == null || disk == null) return { ...out, error: 'rpc-situation 字段解析失败: ' + String(r.text).slice(0, 250) };
  out.note = `实时值(历史数据页无可用取数接口, 峰值=当前值); 系统分区 ${disk}%` +
    (diskNote ? `; ${diskNote}` : '') +
    (d.uptime ? `; 运行 ${d.uptime}` : '') +
    (d.system_webapps != null ? `; 保护站点 ${d.system_webapps}` : '');
  // 版本号在 系统概况 页的文本里(版本号 WAF-V3.0R47C59), rpc-situation 里没有
  const pg = await inPage(np, `${origin}${dir}main.m?a=situation`);
  const vm = String(pg.text || '').match(/版本号[\s\S]{0,80}?(WAF-V[\w.\-]+)/);
  if (vm && looksLikeVersion(vm[1])) out.version = vm[1];
  return { ...out, series: { cpu: liveSeries(cpu), mem: liveSeries(mem), disk: liveSeries(disk) } };
}

// ============================================================
// 13 个专享实例(全覆盖)。name 必须与控制台行文本一致, 用来定位「配置」按钮
// ============================================================
const TARGETS = [
  { instanceId: 84, name: '数据库审计（专享）-84', fn: (np) => dbResource(np, { family: 'dbaudit', apiVer: '4.0.6', label: '数据库审计' }) },
  { instanceId: 66, name: '数据库审计（专享）-66', fn: (np) => dbResource(np, { family: 'dbaudit', apiVer: '4.0.6', label: '数据库审计' }) },
  { instanceId: 15, name: '数据库审计（专享）-15', fn: (np) => dbResource(np, { family: 'dbaudit', apiVer: '4.0.6', label: '数据库审计' }) },
  { instanceId: 80, name: '数据库安全网关（专享）-80', fn: (np) => dbResource(np, { family: 'gateway', apiVer: '2.0.33', label: '数据库安全网关' }) },
  { instanceId: 79, name: '数据库安全网关（专享）-79', fn: (np) => dbResource(np, { family: 'gateway', apiVer: '2.0.33', label: '数据库安全网关' }) },
  { instanceId: 3, name: 'Web应用防火墙（专享）-3', fn: waf3 },
  { instanceId: 36, name: 'APT攻击预警（专享）-36', fn: apt36 },
  { instanceId: 19, name: '下一代防火墙（专享-信创）-19', fn: fw19 },
  { instanceId: 5, name: '日志审计（专享）-5', fn: soc5 },
  { instanceId: 32, name: '数据加解密服务-32', fn: hsmmng32 },
  { instanceId: 47, name: 'API风险监测系统-47', fn: aas47 },
  { instanceId: 4, name: '主机安全（专享）-4', fn: edr4 },
  { instanceId: 61, name: '数据分类分级安全管理（专享）-61', fn: aisort61 },
];

// ============================================================
// 主流程: 登录控制台 → 逐实例开配置页 → 采数 → 合并回 anheng_collected.json
// 由 xunjian_all.js 调用(每次巡检都跑), 也可单独 `node anheng_cloud_collect.js`
// ============================================================
async function collect(ctx, { only } = {}) {
  const db = lib.readJson(OUT);
  if (!db || !Array.isArray(db.instances)) throw new Error('anheng_collected.json 不存在或格式不对');
  const targets = only ? TARGETS.filter((t) => only.includes(Number(t.instanceId))) : TARGETS;
  const startedAt = new Date().toISOString();
  const report = [];
  const failed = [];
  const consolePage = await loginConsole(ctx);
  await selectDedicatedTab(consolePage);
  const list = await scrapeProductList(consolePage);
  lib.log(`安恒云: 专享型产品表 ${list.length} 行, 本次采集 ${targets.length} 个实例`);
  // 控制台行里的「到期时间」是权威的授权到期(列序: 产品名称/团队/所在中转/开通时间/到期时间/规格/状态/操作)
  const licByRow = {};
  for (const cells of list) {
    const nameCell = cells.find((c) => /（专享）|专享|-/.test(c)) || cells[0];
    const dates = cells.filter((c) => /^\d{4}-\d{2}-\d{2}/.test(c));
    if (nameCell && dates.length) licByRow[nameCell.includes('专享') ? nameCell : cells[0]] = dates[dates.length - 1].slice(0, 10);
  }

  for (const t of targets) {
    const inst = db.instances.find((x) => Number(x.instanceId) === t.instanceId);
    if (!inst) { lib.log(`  !! 实例 ${t.instanceId} 不在 anheng_collected.json`); continue; }
    lib.log(`--- ${t.name}`);
    const np = await openProduct(ctx, consolePage, t.name);
    if (!np) {
      lib.log('  打不开配置页, 跳过');
      report.push({ name: t.name, ok: false, why: '打不开配置页' });
      failed.push({ inst, why: '打不开配置页' });
      continue;
    }
    try {
      const res = await lib.withTimeout(t.fn(np), 120000, t.name);
      if (res.error) {
        lib.log(`  采集失败: ${String(res.error).slice(0, 160)}`);
        report.push({ name: t.name, ok: false, why: String(res.error).slice(0, 160) });
        failed.push({ inst, why: String(res.error).slice(0, 160) });
      } else {
        if (res.version) inst.productVersion = res.version;
        // 产品自己的授权接口比控制台表更细(给了开始/到期/客户), 有就用它
        if (res.licenseEnd) {
          inst.license = inst.license || {};
          inst.license.expireDate = res.licenseEnd;
          inst.license.expireTime = res.licenseEnd;
          inst.license.source = ((inst.license.source || '') + ' + 产品内许可接口').trim();
        }
        inst.resourceApi = res.source;
        if (res.series) {
          const S = res.series;
          const daily = {
            days: ((S.cpu && S.cpu.days && S.cpu.days.length ? S.cpu.days : null) ||
              (S.mem && S.mem.days && S.mem.days.length ? S.mem.days : null) ||
              (S.disk && S.disk.days && S.disk.days.length ? S.disk.days : null) || []),
          };
          for (const k of ['cpu', 'mem', 'disk']) {
            const ser = S[k];
            if (!ser) { daily[k] = null; continue; }
            daily[k] = { avg: ser.avg, max: ser.max };
            if (ser.live) daily[k].live = true;
          }
          inst.daily = daily;
          const wa = {};
          for (const k of ['cpu', 'mem', 'disk']) wa[k] = weeklyAvgOf(daily[k]);
          inst.weeklyAvg = wa;
        } else if (res.series === null) {
          // 产品确认没有资源接口 → 清掉可能残留的旧曲线, 免得表里出现"来路不明的旧数据"
          inst.daily = { days: [] };
          inst.weeklyAvg = { cpu: null, mem: null, disk: null };
        }
        inst.notes = res.note || '';
        // 【实时性】每次采集都盖新时间戳 —— 这个字段是"本次采到了"的唯一凭据
        inst.resourceCollectedAt = new Date().toISOString();
        if (res.aptMetrics) inst.aptMetrics = res.aptMetrics;
        // "曲线=N点"取【任一有数据的指标】, 不能只看 cpu —— 加解密-32 只有内存/磁盘,
        // 拿 cpu 计数会打出"曲线=0点"的假象(实际采到了 内存/磁盘 两个实时值)。
        let nDays = 0;
        for (const k of ['cpu', 'mem', 'disk']) {
          const s = inst.daily && inst.daily[k];
          if (s && Array.isArray(s.avg) && s.avg.length) nDays = Math.max(nDays, s.avg.length);
        }
        lib.log(`  OK 版本=${res.version || '(未取到)'} 曲线=${nDays}点 ${res.note}`);
        report.push({ name: t.name, ok: true, version: res.version || '', days: nDays, note: res.note });
      }
    } catch (e) {
      lib.log(`  异常: ${String(e.message || e).slice(0, 160)}`);
      report.push({ name: t.name, ok: false, why: String(e.message || e).slice(0, 160) });
      failed.push({ inst, why: String(e.message || e).slice(0, 160) });
    }
    await np.close().catch(() => {});
    await consolePage.bringToFront().catch(() => {});
    await consolePage.waitForTimeout(1500);
  }

  // 控制台表的到期时间回填到 license
  for (const inst of db.instances) {
    const hit = Object.keys(licByRow).find((k) => k === inst.name || k.includes(String(inst.instanceId)));
    if (hit && inst.license) {
      inst.license.expireDate = licByRow[hit];
      inst.license.expireTime = licByRow[hit];
      inst.license.source = (inst.license.source || '') + ' + console 专享型产品表';
    }
  }

  // 【不允许旧数据装新】本次采集失败的实例: 保留旧值, 但在 notes 里显式写明失败与数据日期,
  // 并且【不动 resourceCollectedAt】—— 让 collect_anheng.js 的过期判断能把它标成超时。
  for (const f of failed) {
    const old = f.inst.resourceCollectedAt ? String(f.inst.resourceCollectedAt).slice(0, 10) : '未知日期';
    const tag = `本次采集失败(${f.why.slice(0, 60)}); 下表为 ${old} 旧数据`;
    f.inst.notes = f.inst.notes && f.inst.notes.includes('本次采集失败')
      ? f.inst.notes
      : (f.inst.notes ? f.inst.notes + '; ' : '') + tag;
  }

  db.resourceCollectedAt = new Date().toISOString();
  db.collectedAt = new Date().toISOString();
  db.source = `安恒云专享型产品实例 - 每次巡检实时采集(${startedAt.slice(0, 10)}); 13 个实例全覆盖`;
  lib.writeJson(OUT, db);

  console.log('\n===== 安恒云采集结果 =====');
  for (const r of report) {
    console.log(r.ok ? `  [OK]   ${r.name}  版本=${r.version || '—'} 曲线=${r.days}点  ${r.note}` : `  [FAIL] ${r.name}  ${r.why}`);
  }
  const okN = report.filter((r) => r.ok).length;
  console.log(`  共 ${report.length} 个目标, 成功 ${okN}`);
  return { report, ok: okN, total: report.length };
}

module.exports = {
  collect, loginConsole, openProduct, selectDedicatedTab, scrapeProductList,
  captureResponse, inPage, pageBase, TARGETS, OUT,
};

// 单独运行: node anheng_cloud_collect.js [--only 84,19,...]
if (require.main === module) {
  (async () => {
    const onlyIdx = process.argv.indexOf('--only');
    const only = onlyIdx > -1 && process.argv[onlyIdx + 1]
      ? process.argv[onlyIdx + 1].split(',').map((x) => Number(x.trim())).filter((x) => x)
      : null;
    const browser = await lib.launchBrowser(cfg);
    const ctx = await lib.newContext(browser);
    try {
      await collect(ctx, { only });
    } catch (e) {
      console.error('FATAL ' + String(e.message || e));
      process.exitCode = 1;
    } finally {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  })();
}
