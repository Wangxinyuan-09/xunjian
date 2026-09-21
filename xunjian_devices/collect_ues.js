// UES 办公智盾(53443) — 运营指标采集（版本/授权/日志/终端在线），会话复用优先
// 指标口径均为平台 Web 真实 JSON 接口（2026-09-04 实测）：
//   平台版本 /settings/product/version
//   客户端/病毒库/漏洞库 /terminals/query (客户端主流 mainVersion/virusVersion/vulLibVersion)
//   违规外联日志 /hosts/logs logTypes=[ma_netcontrol_invalid_connect]  totalRow
//   USB移动存储日志 /desktopManage/usbStorageLog/query                totalRow
//   授权 /licManage/license/info
//   终端在线/总数/离线 /indexStats/getTerminalStatus?centerGuid=
const path = require('path');
const lib = require('../xunjian_lib');

async function loggedInCheck(page) {
  return page.evaluate(() => {
    const url = location.href;
    const body = (document.body.innerText || '');
    return (!/login/i.test(url) && !body.includes('欢迎登录')) || body.includes('安全概览');
  }).catch(() => false);
}

// 已登录上下文中一次性采集全部指标；windows 为时间窗串
async function gather(page, win) {
  return page.evaluate(async (w) => {
    const jget = async (u) => {
      try { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return { st: r.status, j: await r.json().catch(() => null) }; }
      catch (e) { return { err: String(e).slice(0, 80) }; }
    };
    const jpost = async (u, body) => {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
        return { st: r.status, j: await r.json().catch(() => null) };
      } catch (e) { return { err: String(e).slice(0, 80) }; }
    };
    const d = (x) => (x && x.data) || {};
    const out = {};

    const ver = await jget('/settings/product/version');
    out.platform = d(ver.j).productVersion || null;
    out.productOut = d(ver.j).productOutVersion || null;

    const lic = await jget('/licManage/license/info');
    const l = d(lic.j);
    out.license = l.authorize ? { authorize: l.authorize, type: l.authorizeType, useTime: l.useTime, endTime: l.endTime, serviceCode: l.serviceCode } : null;

    const term = await jget('/indexStats/getTerminalStatus?centerGuid=');
    const t = d(term.j);
    out.terminals = (t.totalNum != null) ? { total: t.totalNum, online: t.online, offline: t.offline } : null;

    // 终端客户端/病毒库/漏洞库版本（分页取全量，统计主流）
    const tq = await jpost('/terminals/query?curPage=1&pageSize=500', {});
    const list = (d(tq.j).list) || [];
    out.totalTerminals = (d(tq.j).totalRow != null) ? d(tq.j).totalRow : list.length;
    out.versionDist = { main: {}, virus: {}, vuln: {} };
    for (const it of list) {
      if (it.mainVersion) out.versionDist.main[it.mainVersion] = (out.versionDist.main[it.mainVersion] || 0) + 1;
      if (it.virusVersion) out.versionDist.virus[it.virusVersion] = (out.versionDist.virus[it.virusVersion] || 0) + 1;
      if (it.vulLibVersion) out.versionDist.vuln[it.vulLibVersion] = (out.versionDist.vuln[it.vulLibVersion] || 0) + 1;
    }

    // 违规外联（主机审计口径，logType 字面量=违规外联）
    const viol = async (winName) => {
      const r = await jpost('/hosts/logs?curPage=1&pageSize=1', { logTimestamp: w[winName], terminalName: '', logTypes: ['ma_netcontrol_invalid_connect'] });
      const tot = d(r.j).totalRow;
      return tot != null ? tot : (r.st ? ('接口' + r.st) : null);
    };
    out.violationToday = await viol('today');
    out.violationWeek = await viol('week');

    // USB移动存储日志
    const usb = async (winName) => {
      const r = await jpost('/desktopManage/usbStorageLog/query?curPage=1&pageSize=1', { logTimestamp: w[winName], terminalName: '', ip: '', levels: [], logTypes: [], content: '' });
      const tot = d(r.j).totalRow;
      return tot != null ? tot : (r.st ? ('接口' + r.st) : null);
    };
    out.usbToday = await usb('today');
    out.usbWeek = await usb('week');

    return out;
  }, win);
}

function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtTime(d) { return fmtDate(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); }
function mode(dist) {
  let best = null, n = 0;
  for (const [k, v] of Object.entries(dist)) if (v > n) { n = v; best = k; }
  return best ? { value: best, count: n } : null;
}

async function collect(ctx, dcfg, cfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const page = await ctx.newPage();
  const sessionFile = path.join(cfg ? cfg.root : __dirname + '/..', 'ues_session.json');
  try {
    await lib.restoreSession(page, ctx, sessionFile);
    await page.goto(`https://${dcfg.host}:${dcfg.port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (!(await loggedInCheck(page))) {
      r.error = 'UES 未登录。请先 node ues_pick.js 手动登录一次刷新 ues_session.json';
      return r;
    }
    lib.log('UES: 复用已保存会话 (免验证码)');

    // 时间窗
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - (weekStart.getDay() === 0 ? 7 : weekStart.getDay()) + 1); // 周一 00:00
    const sevenAgo = new Date(startToday); sevenAgo.setDate(sevenAgo.getDate() - 7); // 7天前 00:00
    const win = {
      today: [fmtTime(startToday), fmtTime(now)],
      week: [fmtTime(weekStart), fmtTime(now)],
      sevenDay: [fmtTime(sevenAgo), fmtTime(todayEnd)],
    };
    const g = await lib.withTimeout(gather(page, win), 90000, 'ues metrics');
    if (g.err) { r.error = 'UES 指标采集异常: ' + g.err; return r; }

    const metrics = {};
    metrics['平台软件版本'] = g.platform ? `${g.platform} (${g.productOut || ''})`.trim() : '—';
    // 版本：取主流（多数终端）；无终端时置 —
    const mMain = mode(g.versionDist.main), mVirus = mode(g.versionDist.virus), mVuln = mode(g.versionDist.vuln);
    metrics['客户端软件版本'] = mMain ? `${mMain.value}（${mMain.count}/${g.totalTerminals || '?'}台）` : '—';
    metrics['病毒库版本'] = mVirus ? `${mVirus.value}（${mVirus.count}/${g.totalTerminals || '?'}台）` : '—';
    metrics['漏洞库版本'] = mVuln ? `${mVuln.value}（${mVuln.count}/${g.totalTerminals || '?'}台）` : '—';
    metrics['授权情况'] = g.license ? `${g.license.authorize} ｜ ${g.license.useTime} ｜ 到期${g.license.endTime}` : '—';
    metrics['违规外联日志(本日)'] = (g.violationToday != null) ? g.violationToday : '—';
    metrics['违规外联日志(近7天)'] = (g.violationWeek != null) ? g.violationWeek : '—';
    metrics['USB移动存储日志(本日)'] = (g.usbToday != null) ? g.usbToday : '—';
    metrics['USB移动存储日志(本周)'] = (g.usbWeek != null) ? g.usbWeek : '—';
    metrics['终端(在线/总数/离线)'] = g.terminals ? `${g.terminals.online} / ${g.terminals.total} / ${g.terminals.offline}` : '—';

    const hasCore = g.platform && g.terminals;
    r.ok = !!hasCore;
    r.source = 'ues web 运营指标';
    r.remarks = buildRemark(metrics, g);
    r.metrics = metrics;
    r.metricsExtra = {
      versionDist: g.versionDist, totalTerminals: g.totalTerminals || null,
      license: g.license, terminals: g.terminals,
    };
    if (!hasCore) r.error = 'UES 核心指标缺失(平台版本/终端状态)，请检查会话或页面';
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

function buildRemark(metrics, g) {
  const parts = [];
  const keys = ['平台软件版本', '客户端软件版本', '病毒库版本', '漏洞库版本', '授权情况'];
  for (const k of keys) if (metrics[k] && metrics[k] !== '—') parts.push(k + ':' + metrics[k]);
  if (g.terminals) parts.push(`终端在线 ${g.terminals.online}/${g.terminals.total}(离线${g.terminals.offline})`);
  parts.push(`违规外联日志 本日${metrics['违规外联日志(本日)']}/近7天${metrics['违规外联日志(近7天)']}`);
  parts.push(`USB日志 本日${metrics['USB移动存储日志(本日)']}/本周${metrics['USB移动存储日志(本周)']}`);
  return parts.join('; ');
}

module.exports = { collect };
