// 迪普 API 安全网关（apig）— headless 无验证码，签名 API 采集
// 复用 apig_xunjian_node.js 的签名与分桶逻辑
const crypto = require('crypto');
const lib = require('../xunjian_lib');

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// 从页面解码 transmissionKey → D
async function loadD(page) {
  return page.evaluate(() => {
    const tk = window.transmissionKey || '';
    const raw = atob(tk);
    const bytes = [];
    for (let i = 0; i < raw.length; i++) bytes.push(raw.charCodeAt(i));
    const a = bytes.pop() || 0;
    const key = 'dbonePasswd';
    const out = bytes.map((b, i) => (256 + b - (a - key.charCodeAt(i % key.length))) % 256);
    const s = String.fromCharCode(...out);
    return s.split('&')[0];
  }).then((N) => parseInt(N.substring(4, 8), 16));
}

function secToken(data, rid, D) {
  const sig = sha256hex(`${D}:${data}:${rid}`).substring(4, 8);
  return sig + (D * (parseInt(sig, 16) || 1)).toString(16);
}

function qs(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// 【右上角 admin → 关于本系统】取版本号(需求2)。
// 2026-09-20 实测: 点右上角头像触发下拉, 菜单项为 我的信息/退出/关于本系统;
// 点「关于本系统」弹出: 产品名称/产品型号/软件版本/设备序列号/设备厂商。
// 软件版本形如 "APIG-V3.0R26C00-aarch64"。
async function versionFromAbout(page) {
  // 下拉挂在头像上(class 含 avatar), 且是 click 触发(不像漏扫/AiDSC 要 hover)
  const pt = await page.evaluate(() => {
    for (const sel of ['[class*="avatar"]', '[class*="user"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.top > 90 || r.left < window.innerWidth * 0.6) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  if (!pt) return '';
  // 优先用 Playwright 的定位点击(探针验证过), 失败再退回坐标点击
  const opened = await page.locator('[class*="avatar"]').first().click({ timeout: 4000 }).then(() => true).catch(() => false);
  if (!opened) { await page.mouse.move(pt.x, pt.y); await page.mouse.click(pt.x, pt.y); }
  await page.waitForTimeout(1800);
  // 【必须挑最小的那个节点】—— 2026-09-21 逐个节点实测: 菜单里从容器 li/div 到叶子 span 有 8 个节点
  // 的 innerText 都含「关于本系统」, 只有【叶子 span(i=7, 60x14)】点下去才弹窗。
  // 旧代码按 li,a,div,span 的文档序取【第一个】, 命中的是外层容器 li —— JS .click() 派发在容器上
  // 只向上冒泡, 触发不到菜单项自身的 handler, 所以日志里菜单明明开着却读不到弹窗。
  // 选法: 文本必须【恰好等于】「关于本系统」, 且在可见节点里取面积最小的(即最深的叶子)。
  const a = await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() !== '关于本系统') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const area = r.width * r.height;
      if (!best || area < best.area) best = { area, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return best;
  });
  if (!a) return '';
  // 叶子 span 上的 JS 点击会冒泡到菜单项的 handler —— 探针里验证可行的就是 JS 点击(2026-09-21)
  await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() !== '关于本系统') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const area = r.width * r.height;
      if (!best || area < best.area) best = { area, el };
    }
    if (best) best.el.click();
  });
  await page.waitForTimeout(2500);
  const txt = await page.evaluate(() => (document.body.innerText || '').slice(-1200));
  // 弹窗渲染成 "软件版本\nAPIG-V3.0R26C00-aarch64"(中间是换行不是空格), \s* 已覆盖
  const m = txt.match(/软件版本\s*([^\s\n]+)/);
  return m ? m[1].trim() : '';
}

async function apiCall(request, D, base, action, params) {
  const data = JSON.stringify(params);
  const rid = crypto.randomUUID();
  const sec = secToken(data, rid, D);
  const query = qs({ requestId: rid, data, regionId: '', secToken: sec, instanceId: 'self' });
  const url = `${base}/${action}.json`;
  const headers = {
    // 从 base 反推，不再写死地址
    Referer: `${new URL(base).origin}/apigView/overview`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json, text/plain, */*',
  };
  const resp = await request.get(url + '?' + query, { headers });
  const text = await resp.text();
  return JSON.parse(text);
}

async function collect(ctx, dcfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const page = await ctx.newPage();
  try {
    await page.goto(`${host}/`, { waitUntil: 'load', timeout: 60000 });
    const D = await lib.withTimeout(loadD(page), 10000, 'apig loadD');
    lib.log(`apig D=${D}`);

    // 登录（无验证码）
    await page.locator('input[type="text"], input[id*="user"], input[name="username"]').first().fill(dcfg.user);
    await page.locator('input[type="password"]').first().fill(dcfg.pass);
    await page.getByRole('button').filter({ hasText: /登\s*录/ }).first().click();
    await page.waitForTimeout(4000);
    if (!/overview/.test(page.url())) {
      r.error = '登录未成功，URL=' + page.url();
      return r;
    }

    // 7 天历史（秒级时间戳）
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 8 * 86400;
    const res = await apiCall(ctx.request, D, `${host}/webapi/apig/5.0`, 'DescribeSystemResourceItem', {
      startTime: startSec, endTime: nowSec,
    });
    const items = (res.data && res.data.systemResourceItems) || [];
    if (!items.length) { r.error = 'DescribeSystemResourceItem 无数据: ' + (res.message || ''); return r; }

    const keyMap = { cpu_usage_rate: 'cpu', memory_usage_rate: 'mem', disk_usage_rate: 'disk' };
    const series = {};
    for (const it of items) {
      const label = keyMap[it.systemResourceItemKey];
      if (!label) continue;
      const samples = (it.systemResourceItemValues || []).map((v) => ({
        timeMs: Number(v.systemResourceHistoryClock) * 1000,
        value: parseFloat(v.systemResourceHistoryValueAvg),
      }));
      series[label] = samples;
    }
    if (!series.cpu || !series.mem || !series.disk) {
      r.error = '缺少 cpu/mem/disk 序列: ' + items.map((i) => i.systemResourceItemKey).join(',');
      return r;
    }

    const bucket = (samples) => lib.bucketByDay(samples, { endMs: Date.now() });
    const cpu = bucket(series.cpu);
    const mem = bucket(series.mem);
    const disk = bucket(series.disk);

    // 峰值（valueMax 分桶）
    const peakBucket = (samples, getMax) => {
      const map = new Map();
      for (const it of items) {
        const label = keyMap[it.systemResourceItemKey];
        if (label !== getMax) continue;
        for (const v of it.systemResourceItemValues || []) {
          const t = Number(v.systemResourceHistoryClock) * 1000;
          map.set(t, parseFloat(v.systemResourceHistoryValueMax));
        }
      }
      return lib.bucketByDay([...map.entries()].map(([timeMs, value]) => ({ timeMs, value })), { endMs: Date.now() });
    };

    let remarks = `迪普API安全网关(${host}) 7天历史接口采集`;
    // 版本号(需求2) —— 走【右上角 admin → 关于本系统】弹窗。
    // 【DescribeLicense 取不到版本】: 2026-09-20 实测出参只有 productName/productSN/productModel,
    // licenseSdkVersion 是【空串】。此处仍调它, 但只为拿维保到期时间。
    let ver = '';
    try {
      const lic = await apiCall(ctx.request, D, `${host}/webapi/apig/5.0`, 'DescribeLicense', {});
      const dl = lic.data || {};
      if (dl.productExpireTime) remarks += `; 维保至 ${new Date(Number(dl.productExpireTime)).toISOString().slice(0, 10)}`;
    } catch (e) {}
    try {
      ver = await versionFromAbout(page);
      if (ver) lib.log('apig 关于本系统取到版本号: ' + ver);
      else lib.log('apig 关于本系统未取到版本号');
    } catch (e) {
      lib.log('apig 关于本系统异常: ' + String(e.message || e).slice(0, 150));
    }
    if (ver) r.productVersion = ver;

    lib.fillOk(r, {
      cpu: cpu.avg, mem: mem.avg, disk: disk.avg,
      cpuPeak: peakBucket(series.cpu, 'cpu').avg, memPeak: peakBucket(series.mem, 'mem').avg, diskPeak: peakBucket(series.disk, 'disk').avg,
      days: cpu.days, remarks: remarks + (ver ? ` | 版本 ${ver}` : ''), source: 'apig DescribeSystemResourceItem',
    });
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
