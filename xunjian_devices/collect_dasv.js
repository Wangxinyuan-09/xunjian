// DasV大屏(可视化平台, 19480) — 无硬件资源API, 只采集 授权情况 + 系统概况
// Vue前端 + NestJS后端, 无验证码. 登录=填2个input[text,password]+点"登录"按钮(自动登录)
// 成功后 localStorage.DasV-Edit_token 存JWT(值形如 "eyJ..." 带引号JSON串 → JSON.parse 取裸token)
// 采集 /v1/license /v1/env /v1/user (带 Authorization: Bearer <token>)
// 说明: 平台无 CPU/内存/磁盘 采集接口 → cpu/mem/disk 保持 null (不调 fillOk 以免强制为0)
const lib = require('../xunjian_lib');

const cnDate = (v) => {
  if (v == null || v === '') return '—';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return String(v).slice(0, 16);
};
const txt = (v) => (v == null || v === '' ? '—' : String(v));

async function loginAndWait(page, dcfg) {
  await page.goto(`http://${dcfg.host}:${dcfg.port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input', { timeout: 30000 }).catch(() => {});
  const ins = page.locator('input');
  if (await ins.count() < 2) throw new Error('登录页 input 少于2个');
  await ins.nth(0).fill(dcfg.user);
  await ins.nth(1).fill(dcfg.pass);
  const clicked = await page.evaluate(() => {
    const cand = [...document.querySelectorAll('button, input[type=button], input[type=submit], [role=button], .ant-btn')];
    const b = cand.find((x) => {
      const t = ((x.textContent || '') + ' ' + (x.value || '')).replace(/\s+/g, '');
      return t.includes('登') && t.includes('录');
    });
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) throw new Error('未找到登录按钮');
  // 等待 localStorage.DasV-Edit_token 出现(最长~25s), URL 离开 /login 为辅助
  for (let i = 0; i < 25; i++) {
    const token = await readToken(page);
    if (token) return token;
    const u = page.url();
    if (!/\/login/i.test(u)) {
      const t2 = await readToken(page);
      if (t2) return t2;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// DasV-Edit_token 原始值是 JSON 编码串(带引号) → JSON.parse 取裸JWT; 兼容对象/裸串
async function readToken(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('DasV-Edit_token');
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (typeof p === 'string' && p) return p;
      if (p && typeof p === 'object') {
        if (typeof p.token === 'string' && p.token) return p.token;
        if (typeof p.access_token === 'string' && p.access_token) return p.access_token;
      }
    } catch (e) { /* 非JSON则当裸token用 */ }
    return raw || null;
  }).catch(() => null);
}

// 三个确认的运营接口, 先带 Bearer; 若401回退不带头再试一次(会话cookie兜底)
async function fetchAll(page, token) {
  return page.evaluate(async (token) => {
    const call = async (p) => {
      for (const headers of [token ? { Authorization: 'Bearer ' + token } : {}, {}]) {
        try {
          const r = await fetch(p, { headers, credentials: 'include' });
          let body = null;
          const ct = (r.headers.get('content-type') || '');
          if (/json/i.test(ct)) { try { body = await r.json(); } catch (e) { body = null; } }
          else { body = await r.text().catch(() => ''); }
          if (r.status === 200) return { status: r.status, body };
          return { status: r.status, body };
        } catch (e) {
          return { status: 0, body: String(e.message || e) };
        }
      }
    };
    const lic = await call('/v1/license');
    const env = await call('/v1/env');
    const usr = await call('/v1/user');
    return { lic, env, usr };
  }, token);
}

async function collect(ctx, dcfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  let page = await ctx.newPage();
  try {
    // 偶发: 短时间内重复登录 DasV 可能不回填 DasV-Edit_token(2026-09-10 全量 sweep 首次失败、单跑成功)
    // → 隔 8s 换新页面重试一次; 仍失败才判错
    let token = await loginAndWait(page, dcfg);
    if (!token) {
      lib.log('DasV: 首次登录未取到 token, 8s 后换新页面重试');
      await page.close().catch(() => {});
      await new Promise((s) => setTimeout(s, 8000));
      page = await ctx.newPage();
      token = await loginAndWait(page, dcfg);
    }
    if (!token) {
      r.error = 'DasV大屏登录后未取得 DasV-Edit_token (登录流程有变? 已重试1次)';
      return r;
    }
    lib.log(`DasV: 登录成功, 已取token (${token.length}字符)`);

    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetchAll(page, token);
      const ok3 = res.lic && res.lic.status === 200 && res.env && res.env.status === 200 && res.usr && res.usr.status === 200;
      if (ok3) break;
      await page.waitForTimeout(1500);
    }
    const lic = res.lic, env = res.env, usr = res.usr;
    if (!lic || lic.status !== 200) {
      r.error = 'DasV /v1/license 采集失败: ' + JSON.stringify(lic).slice(0, 300);
      return r;
    }

    const ld = lic.body && lic.body.data;            // type/customer/expiredAt/macCode/state
    const lp = (ld && ld.data) || {};                // {name:'高级版应用', version:'premium', sn, licenseNo, maintenancePeriod(月)}
    const ed = env.body && env.body.data || {};      // deployType/licenseMode/deadline(天)/maintenanceDeadline(天)
    const ud = usr && usr.body && usr.body.data || {}; // username/role[]/lastLogin/remark

    const expired = cnDate(ld && ld.expiredAt);
    const maintExp = cnDate((ld && ld.maintenanceExpirationAt) || lp.maintenancePeriod); // ISO维护到期; 兜底不把"月数"当天数算
    const dl = (ed.deadline != null && ed.deadline !== '') ? `${txt(ed.deadline)}天` : '—'; // env deadline 是剩余天数
    const licName = lp.name || '—';

    const metrics = {};
    metrics['授权情况'] = `${licName}${lp.version ? '/' + lp.version : ''} 到期 ${expired} 剩余${dl}${ld && ld.customer ? ' ｜ 客户:' + ld.customer : ''}`;
    metrics['平台类型/版本'] = `${txt(ld && ld.type)} 部署:${txt(ed.deployType)} 模式:${txt(ed.licenseMode)}`;
    metrics['维护到期'] = (ld && ld.maintenanceExpirationAt) ? `${maintExp} (服务${txt(lp.maintenancePeriod)}个月)` : '—';
    const roleStr = Array.isArray(ud.role) ? ud.role.join('/') : txt(ud.role);
    metrics['登录用户'] = `${txt(ud.username)}${roleStr !== '—' ? ' (' + roleStr + ')' : ''}${ud.realname && ud.realname !== ud.username ? ' 真实名:' + ud.realname : ''}${ud.lastLogin ? ' 最近登录 ' + cnDate(ud.lastLogin) : ''}`;
    metrics['授权SN'] = `${txt(lp.sn)} 许可号:${txt(lp.licenseNo)} 机器码:${txt(ld && ld.macCode)}`;

    r.ok = true;
    r.cpuSeries = null;
    r.memSeries = null;
    r.diskSeries = null;
    r.days = null;
    r.collectionMode = 'web';
    r.hasWebChart = 'no';
    r.source = 'DasV /v1/license env user';
    r.remarks = `DasV大屏可视化平台(http://${dcfg.host}:${dcfg.port}) 无硬件资源API; 授权/系统概况采集成功${licName ? ' (' + licName + ')' : ''}`;
    r.metrics = metrics;
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { collect };
