// 终端安全 安恒明御EDR(27443) — 运营指标采集（版本/防护日志/授权），会话复用优先
// 2026-09-07 复核的账号分工（hs-json-resp.json / edr_fields_map.json / 实测）：
//   manger(普通管理员,tenantManager=manger) → 客户端版本findNode、授权user_license、防护日志log_get、终端deployment  全 200
//   admin(超管,tenantManager=admin) → 客户端版本/终端/健康分 能读，但授权user_license/防护日志log_get 403
//   hs_admin_session.json 超管专用 → 病毒库/漏洞库版本 /file/upgrade/info, /file/get_version（若存在）
// 故 hs_session.json 用 manger 账号一次读全核心四项；病毒库/漏洞库另需 hs_admin_session.json。
// 平台软件版本 /settings 用「登录页匿名」取（登录后 manger/admin 调反而 403，见 anonPlatformVersion）
const path = require('path');
const fs = require('fs');
const lib = require('../xunjian_lib');

async function loggedInCheck(page) {
  return page.evaluate(() => !/login/.test(location.href)).catch(() => false);
}

// 在给定 page 上(先 hook request)打开 dashboard 一次，捕获 app 真实 Authorization 头
async function loadAndCaptureAuth(browser, dcfg, sessionFile) {
  const ctx = await lib.newContext(browser);
  try {
    const page = await ctx.newPage();
    await lib.restoreSession(page, ctx, sessionFile);
    let auth = '';
    const onReq = (req) => { if (!auth && req.headers()['authorization']) auth = req.headers()['authorization']; };
    page.on('request', onReq);
    await page.goto(`https://${dcfg.host}:${dcfg.port}/#/home/complex-dashboard`, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    const t0 = Date.now();
    while (!auth && Date.now() - t0 < 15000) { await page.waitForTimeout(400); }
    page.off('request', onReq);
    return { ctx, page, auth };
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
}

// admin 会话：客户端版本/终端分布（findNode, deployment）— admin(超管) 实测 200
async function gatherAdminCore(page, auth) {
  return page.evaluate(async ({ auth }) => {
    const H = { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };
    const get = async (u) => { try { const r = await fetch(u, { headers: H }); return { st: r.status, j: await r.json().catch(() => null) }; } catch (e) { return { err: String(e).slice(0, 80) }; } };
    const d = (x) => (x && x.data) || {};
    const out = { clientVersionDist: {}, totalTerminals: 0 };

    let offset = 0, totalSeen = 0;
    for (;;) {
      const q = await get(`/asset_overview/node/findNode?limit=200&offset=${offset}&order=&sort=&key=`);
      const list = (d(q.j).list) || [];
      totalSeen += list.length;
      for (const it of list) if (it.version) out.clientVersionDist[it.version] = (out.clientVersionDist[it.version] || 0) + 1;
      if (!list.length || list.length < 200) break;
      offset += list.length;
      if (offset > 5000) break;
    }
    out.totalTerminals = totalSeen;

    // 终端部署计数（作为在线/总数/离线的参考）
    const dep = await get('/dashboard/deployment_status');
    const dj = d(dep.j);
    if (dj.deployedCount != null) { out.deployed = dj.deployedCount; out.undeployed = dj.undeployCount; }
    return out;
  }, { auth });
}

// manger 会话：授权情况 + 近7天防护日志（manger 实测 200，admin 同接口 403）
async function gatherManger(page, auth, winStart, winEnd) {
  return page.evaluate(async ({ auth, winStart, winEnd }) => {
    const H = { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };
    const get = async (u) => { try { const r = await fetch(u, { headers: H }); return { st: r.status, j: await r.json().catch(() => null) }; } catch (e) { return { err: String(e).slice(0, 80) }; } };
    const post = async (u, b) => { try { const r = await fetch(u, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }); return { st: r.status, j: await r.json().catch(() => null) }; } catch (e) { return { err: String(e).slice(0, 80) }; } };
    const d = (x) => (x && x.data) || {};
    const out = {};

    const lic = await get('/user_license/list_licenses?offset=0');
    out.licStatus = lic.st || 0; // 401/403 = manger 会话已失效(此前会被平台版本匿名兜底掩盖成 ✅)
    out.licenses = d(lic.j).list || [];

    const lg = await post('/log/get_log', { order: '', sort: '', limit: 1, offset: 0, key: '', nodeId: '', eventIds: [], standardTimestamp: [winStart, winEnd], risks: [], groupId: '' });
    out.weekProtectLogs = d(lg.j).total != null ? d(lg.j).total : null;

    return out;
  }, { auth, winStart, winEnd });
}

// 超管会话补 平台当前/病毒库/漏洞库 版本（2026-09-07 实测）
//   /file/list  → data.library[]  各库版本: 病毒库 av_update, 系统漏洞库 vul_update
//   /upgrade/get_upgrade_progress → data.current_version 平台当前版本(如 3.13.20.0)
//   /file/upgrade/info → 升级服务器在线信息(online/proxy/ip), 不含版本
async function gatherAdmin(page, auth) {
  return page.evaluate(async (auth) => {
    const H = { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };
    const get = async (u) => { try { const r = await fetch(u, { headers: H }); return { st: r.status, j: await r.json().catch(() => null) }; } catch (e) { return { err: String(e).slice(0, 80) }; } };
    const d = (x) => (x && x.data) || {};
    const out = { libs: {}, server: null, currentVersion: null };
    // 平台当前版本
    const gp = await get('/upgrade/get_upgrade_progress');
    out.currentVersion = d(gp.j).current_version || null;
    // 各库版本（updateType 为字段标识, version 为版本号, content 为名称）
    const fl = await get('/file/list');
    const libs = d(fl.j).library || [];
    for (const it of libs) out.libs[it.updateType] = it.version;
    // 升级服务器在线信息（备用）
    const ui = await get('/file/upgrade/info');
    out.server = d(ui.j);
    return out;
  }, auth);
}

// 平台版本取自登录页公开配置(无需登录；登录后 manger 调 /settings 反而 403)
async function anonPlatformVersion(browser, host) {
  const ctx = await lib.newContext(browser);
  try {
    const page = await ctx.newPage();
    await page.goto(host + '/#/login', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const j = await page.evaluate(async () => { const r = await fetch('/settings'); return r.json().catch(() => null); }).catch(() => null);
    if (!j) return null;
    const s = j.setting || j; // /settings 外层包 setting{}
    const v = (s.auth && s.auth.admin && s.auth.admin.version) || null;
    return { version: v, badge: s.version || null };
  } finally { await ctx.close().catch(() => {}); }
}

function modeOf(dist) { let b = null, n = 0; for (const [k, v] of Object.entries(dist)) if (v > n) { n = v; b = k; } return b ? { value: b, count: n } : null; }
function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(offsetDay) { const d = new Date(); d.setDate(d.getDate() - offsetDay); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

async function collect(ctx, dcfg, cfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const root = cfg ? cfg.root : (__dirname + '/..');
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const sessCtxs = []; // 待关闭的所有会话上下文
  const openSess = async (file) => {
    const fp = path.join(root, file);
    if (!fs.existsSync(fp)) return null;
    const mc = await loadAndCaptureAuth(ctx.browser(), dcfg, fp);
    if (!mc.auth) { await mc.ctx.close().catch(() => {}); return null; }
    sessCtxs.push(mc.ctx);
    return mc;
  };
  try {
    const now = new Date();
    const endTs = `${dateStr(0)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const startTs = `${dateStr(6)} 00:00:00`; // 近7天(含今天)=6天前0点~现在

    // —— 主会话（manger）：客户端版本/终端 + 授权 + 近7天防护日志 ——
    // hs_session.json 现为 manger 账号（超管 admin 在授权/防护日志接口 403），一次读全
    const mc = await openSess('hs_session.json');
    if (!mc) { r.error = 'EDR 未取得 hs_session.json 令牌。请先 node hs_pick.js 手动登录一次刷新 hs_session.json'; return r; }
    const page = mc.page;
    lib.log('EDR: 复用 manger 会话 (免验证码)');
    const core = await lib.withTimeout(gatherAdminCore(page, mc.auth), 90000, 'edr core');
    const mg = await lib.withTimeout(gatherManger(page, mc.auth, startTs, endTs), 60000, 'edr metric');

    // 平台版本：登录页匿名 /settings（登录后 manger 调反 403）
    let pv = null, pvBadge = null;
    const an = await lib.withTimeout(anonPlatformVersion(ctx.browser(), host), 25000, 'edr anon settings').catch(() => null);
    if (an) { pv = an.version; pvBadge = an.badge; }

    const metrics = {};
    metrics['平台软件版本'] = pv ? `${pv}${pvBadge ? ' (角标' + pvBadge + ')' : ''}` : '—';
    const mClient = modeOf(core.clientVersionDist || {});
    metrics['客户端软件版本'] = mClient ? `${mClient.value}（${mClient.count}/${core.totalTerminals || '?'}台）` : '—';
    r.metricsExtra = {
      totalTerminals: core.totalTerminals,
      clientVersionDist: core.clientVersionDist,
      terminalDeploy: { deployed: core.deployed, undeployed: core.undeployed },
    };
    if (Array.isArray(mg.licenses) && mg.licenses.length) {
      const first = mg.licenses[0];
      const mnames = mg.licenses.map((l) => l.modelName).filter(Boolean);
      metrics['授权情况'] = `${first.authorize || '?'} ｜ ${mg.licenses.length}模块 ｜ 到期${first.endTime || '?'}`;
      r.metricsExtra.licenseList = mg.licenses;
      r.metricsExtra.licenseModules = mnames;
    } else {
      metrics['授权情况'] = '授权接口返回空';
    }
    if (mg.weekProtectLogs != null) { metrics['最近一周防护日志'] = mg.weekProtectLogs; }
    else { metrics['最近一周防护日志'] = '防护日志接口返回空/超时'; }

    // —— 超管会话：病毒库/漏洞库版本 + 权威平台当前版本 ——
    // 平台版本优先用超管 /upgrade/get_upgrade_progress 的 current_version（比匿名 /settings 更权威）
    let adminNote = '需超管权限';
    const ac = await openSess('hs_admin_session.json');
    if (ac) {
      try {
        const ga = await lib.withTimeout(gatherAdmin(ac.page, ac.auth), 30000, 'edr admin');
        const libs = (ga && ga.libs) || {};
        r.metricsExtra.adminLibs = libs;
        r.metricsExtra.adminServer = ga && ga.server;
        const avVer = libs['av_update'] || libs['病毒库'] || null;
        const vulVer = libs['vul_update'] || libs['系统漏洞库'] || null;
        if (avVer) metrics['病毒库版本'] = avVer;
        else metrics['病毒库版本'] = '（/file/list 未解析到病毒库版本）';
        if (vulVer) metrics['漏洞库版本'] = vulVer;
        else metrics['漏洞库版本'] = '（/file/list 未解析到漏洞库版本）';
        adminNote = '';
        // 平台当前版本（超管权威值），若拿到则覆盖匿名值
        if (ga && ga.currentVersion) {
          metrics['平台软件版本'] = `${ga.currentVersion}${pvBadge ? ' (角标' + pvBadge + ')' : ''}`;
          lib.log('EDR: 超管权威平台版本=' + ga.currentVersion);
        }
        lib.log('EDR: 超管 /file/list 病毒库=' + avVer + ' 漏洞库=' + vulVer);
      } catch (e) {
        adminNote = '超管补采异常: ' + String(e.message || e).slice(0, 120);
      }
    } else {
      metrics['病毒库版本'] = '需超管权限';
      metrics['漏洞库版本'] = '需超管权限';
    }
    if (!metrics['病毒库版本']) metrics['病毒库版本'] = adminNote;
    if (!metrics['漏洞库版本']) metrics['漏洞库版本'] = adminNote;

    // manger 会话失效(401/403): 平台版本是匿名取的会兜底成 ✅, 必须显式判失败, 否则空数据被当成采到
    const mgDead = mg && mg.licStatus && (mg.licStatus === 401 || mg.licStatus === 403);
    const hasCore = !!(pv || mClient);
    r.ok = hasCore && !mgDead;
    r.source = 'edr web 运营指标';
    r.remarks = buildRemark(metrics);
    r.metrics = metrics;
    if (mgDead) r.error = `终端安全会话已失效(授权接口 ${mg.licStatus})：授权/防护日志取不到，请重新登录 manger 账号`;
    else if (!hasCore) r.error = 'EDR 核心指标缺失，请检查会话';
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  } finally {
    for (const c of sessCtxs) await c.close().catch(() => {});
  }
}

function buildRemark(metrics) {
  const parts = [];
  for (const k of ['平台软件版本', '客户端软件版本', '授权情况']) if (metrics[k] && metrics[k] !== '—') parts.push(k + ':' + metrics[k]);
  parts.push(`近7天防护日志:${metrics['最近一周防护日志'] != null ? metrics['最近一周防护日志'] : '—'}`);
  parts.push('病毒库:' + (metrics['病毒库版本'] || '—'));
  parts.push('漏洞库:' + (metrics['漏洞库版本'] || '—'));
  return parts.join('; ');
}

module.exports = { collect };
