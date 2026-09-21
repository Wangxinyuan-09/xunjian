// LT堡垒机(安恒 明御运维审计与风险控制系统, 7443) — 复用 ltb_session.json 会话(无验证码)
// 资源: /pamapi/monitor/v1/system?metrics=CPU,MEMORY,DISK_ROOT,DISK_DATA,DISK_SESSION (设备自身 cpu/内存/分区空间 实时百分比, 90点/15分钟滚动缓冲, 取最后一点)
// 授权: /pamapi/maintain/v1/license:get_license_info
// 只读: 直连 pamapi, 不建 xterm / 不执行 shell
const lib = require('../xunjian_lib');
const path = require('path');
const fs = require('fs');

const AUTH_MARKER = 'DAS_USM_ROUTER_AUTH_';
const RES_METRICS = 'CPU,MEMORY,DISK_ROOT,DISK_DATA,DISK_SESSION';

// 从会话文件读原始 token(有效), localStorage 会被前端登录页启动时轮换为无效占位值
function fileAuth(sessFile) {
  try {
    const s = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    for (const k of Object.keys(s.ls || {})) if (k.indexOf(AUTH_MARKER) >= 0) return s.ls[k];
  } catch (e) {}
  return null;
}

async function collect(ctx, dcfg, cfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const page = await ctx.newPage();
  const host = `https://${dcfg.host}:${dcfg.port || 7443}`;
  try {
    // 1. 恢复已保存会话 + 落在目标 origin (addInitScript 注入 localStorage)
    const sessFile = path.join(__dirname, '..', 'ltb_session.json');
    const restored = await lib.restoreSession(page, ctx, sessFile);
    const fileToken = fileAuth(sessFile);
    if (!restored || !fileToken) { r.error = `缺少有效会话文件 ${sessFile}(需先手动登录 ltb_pick.js 保存)`; return r; }
    await page.goto(`${host}/index/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // 2. 页面内直连只读 pamapi; token 候选: 会话文件原始值优先, localStorage 现值兜底
    const data = await page.evaluate(async ({ AUTH_MARKER, RES_METRICS, fileToken }) => {
      const lsTokens = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(AUTH_MARKER) >= 0) lsTokens.push(localStorage.getItem(k));
      }
      const tokens = [fileToken].concat(lsTokens).filter(Boolean);
      const getJson = async (p, hdrs) => {
        try { const res = await fetch(p, { method: 'GET', headers: hdrs }); return await res.json(); } catch (e) { return null; }
      };
      let lic = null, sys = null, mon = null;
      for (const tok of tokens) {
        const hdrs = { authorization: tok, 'content-type': 'application/json', lang: 'ZH_CN' };
        lic = await getJson('/pamapi/maintain/v1/license:get_license_info', hdrs);
        sys = await getJson('/pamapi/maintain/v1/system:info', hdrs);
        mon = await getJson('/pamapi/monitor/v1/system?metrics=' + RES_METRICS, hdrs);
        if (lic && lic.code === 'OK' && mon && mon.code === 'OK') break; // 某 token 全通即停
      }
      return { auth: !!fileToken, lic, sys, mon };
    }, { AUTH_MARKER, RES_METRICS, fileToken });

    if (!data.auth) { r.error = '会话文件无 ' + AUTH_MARKER + ' token'; return r; }
    if (!data.lic || data.lic.code !== 'OK' || !data.mon || data.mon.code !== 'OK') {
      // 仍未通过(如 token 已过期): 报错以便重新 ltb_pick.js 手动登录
      r.error = `pamapi 鉴权失败(lic=${data.lic && data.lic.code} mon=${data.mon && data.mon.code})，会话可能过期，需重跑 ltb_pick.js 登录`;
      return r;
    }

    // 3. 授权情况
    let licenseTxt = null;
    const L = data.lic && data.lic.code === 'OK' ? data.lic.data : null;
    if (L && L.customerName) {
      licenseTxt = `客户:${L.customerName}; licenseType=${L.licenseType}; 授权到期:${L.expireTime || '未知'}; 维保至:${L.maintainTime || L.expireTime || '未知'}; serviceCode:${L.serviceCode || ''}; 资产/并发授权:${L.assetCount}/${L.connectionCount}`.replace(/\s+/g, ' ');
    }

    // 4. 设备自身资源(cpu/内存/磁盘 实时百分比, 取缓冲最后一点)
    let cpu = null, mem = null, disk = null;
    const MM = data.mon && data.mon.code === 'OK' && data.mon.data ? data.mon.data.metrics : null;
    if (Array.isArray(MM)) {
      const lastVal = (m) => {
        const arr = m && m.values;
        if (!Array.isArray(arr) || !arr.length) return null;
        const v = arr[arr.length - 1];
        return v && typeof v.value === 'number' && !isNaN(v.value) ? v.value : null;
      };
      for (const m of MM) {
        const n = String(m && m.name || '').toUpperCase();
        if (n === 'CPU') cpu = lastVal(m);
        else if (n === 'MEMORY') mem = lastVal(m);
        else if (n === 'DISK_ROOT' && disk == null) disk = lastVal(m);
        else if (n === 'DISK_DATA' && disk == null) disk = lastVal(m);
        else if (n === 'DISK_SESSION' && disk == null) disk = lastVal(m);
      }
      if (cpu != null) cpu = Math.round(cpu * 10) / 10;
      if (mem != null) mem = Math.round(mem * 10) / 10;
      if (disk != null) disk = Math.round(disk * 10) / 10;
    }

    // 5. 出表
    const version = data.sys && data.sys.code === 'OK' ? (data.sys.data && data.sys.data.version) : null;
    // 版本号原本只拼在 remarks 文本里, 这里提成结构化字段供报表取用(需求: 所有产品都要有版本号)
    if (version) r.productVersion = version;
    r.metrics = {};
    if (licenseTxt) r.metrics['授权情况'] = licenseTxt;
    if (cpu != null || mem != null || disk != null) {
      if (cpu != null && mem != null && disk != null) {
        lib.fillOk(r, {
          cpu, mem, disk,
          remarks: `LT堡垒机(${data.sys && data.sys.code === 'OK' ? '明御运维审计 ' + (version || '') : host}) /pamapi/monitor/v1/system 设备自身实时快照(CPU/MEMORY/分区空间%), 取15分钟滚动缓冲最后一点`,
          source: 'pamapi monitor/v1/system',
          collectionMode: 'bastion', hasWebChart: 'no',
        });
      } else {
        // 部分指标缺失, 不伪造 0, 仅授权出表
        r.ok = true; r.days = null;
        r.remarks = `资源部分缺失(cpu=${cpu} mem=${mem} disk=${disk})，仅授权出表`;
        r.source = 'pamapi monitor/v1/system';
      }
    } else if (licenseTxt) {
      r.ok = true; r.days = null;
      r.remarks = '设备自身资源监控接口无数据，仅授权出表';
      r.source = 'pamapi maintain/v1/license:get_license_info';
    } else {
      r.error = '资源与授权接口均未返回可用数据(mon=' + (data.mon && data.mon.code) + ' lic=' + (data.lic && data.lic.code) + ')';
      return r;
    }
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
