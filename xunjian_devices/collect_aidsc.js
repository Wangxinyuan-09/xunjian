// AiDSC 数据安全管控平台 — DOM 登录(2026-09 起需验证码) + 腾讯云风格签名调用 DescribeMonitorData 7天
// 签名算法逆向自 ds_js_index.js: transmissionKey base64→hex, VFe=hex[0:130], D=parseInt(VFe[4:12],16)
//   sig=SHA256(D:data:requestId)[4:8]; secToken=sig+hex(D*int(sig,16))
// 验证码 OCR 不可靠(2026-09-04 实测 t756 等服务端拒绝) → 会话复用为主: aidsc_session.json(手动 aidsc_pick.js 登录一次)
const crypto = require('crypto');
const path = require('path');
const lib = require('../xunjian_lib');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function isLoggedIn(page) {
  return page.evaluate(() => {
    const url = location.href;
    const body = (document.body.innerText || '');
    return !/login/i.test(url) && !/欢迎登录|请输入验证码/i.test(body) && !document.getElementById('form_item_captcha');
  }).catch(() => false);
}

async function login(page, dcfg, code) {
  await page.evaluate(({ user, pass, code }) => {
    const setVal = (el, val) => {
      if (!el) return false;
      const proto = HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    setVal(document.getElementById('form_item_username'), user);
    setVal(document.getElementById('form_item_password'), pass);
    if (code) setVal(document.getElementById('form_item_captcha'), code);
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim().indexOf('登') >= 0);
    if (btn) btn.click();
  }, { user: dcfg.user, pass: dcfg.pass, code });
  await page.waitForTimeout(7000);
}

async function getCaptchaSrc(page) {
  return page.evaluate(() => {
    let src = null;
    document.querySelectorAll('img').forEach((im) => {
      if (!src && im.src && im.src.indexOf('data:image') === 0) src = im.src;
    });
    return src;
  });
}

// 会话失效时用验证码 OCR 尝试重新登录（成功率低，仅自愈兜底）
async function ocrLogin(page, ctx, dcfg, sessionFile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const src = await getCaptchaSrc(page);
    if (!src) break;
    const buf = lib.b64Buffer(src);
    const cfg0 = require('../xunjian_config');
    const cands = [...new Set([
      ...await lib.ocr(dcfg.ocr, buf, cfg0), ...await lib.ocr('ddd', buf, cfg0),
      ...await lib.ocr('bastion', buf, cfg0), ...await lib.ocr('enhanced', buf, cfg0),
    ])].filter((c) => /^[0-9a-zA-Z]{4}$/.test(c));
    if (!cands.length) { await page.waitForTimeout(600); continue; }
    for (const code of cands) {
      await login(page, dcfg, code);
      if (await isLoggedIn(page)) {
        await lib.saveSession(page, ctx, sessionFile).catch(() => {});
        lib.log('AiDSC: 验证码OCR登录成功，已刷新会话');
        return true;
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  return false;
}

async function loadD(page) {
  return page.evaluate(() => {
    const c = window.DBAPPSECURITY_DSAPP_CONFIG;
    return c ? (c.transmissionKey || '') : '';
  }).then((tk) => {
    if (!tk) throw new Error('无 transmissionKey');
    const hex = Buffer.from(tk, 'base64').toString('hex');
    const VFe = hex.substring(0, 130);
    return parseInt(VFe.substring(4, 12), 16);
  });
}

function secToken(data, rid, D) {
  const sig = sha256hex(`${D}:${data}:${rid}`).substring(4, 8);
  return sig + (D * (parseInt(sig, 16) || 1)).toString(16);
}

const TYPES = ['cpu_usage_percent_all', 'mem_usage_percent', 'disk_usage_percent'];

// 【右上角「安全管理员」→ 关于】取版本号(需求2)。
// 菜单是 hover 触发的: user-menu-wrapper 里的 .sub-menu-item 未展开时宽高为 0,
// 必须鼠标真实移动到用户名上, 等 "关于" 显形后再点(2026-09-20 实测)。
async function versionFromAbout(page, userText) {
  const pt = await page.evaluate((want) => {
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.top > 90) continue;
      if (r.left < window.innerWidth * 0.6) continue;
      if ((el.innerText || '').trim() !== want) continue;
      if (!best || r.left > best.x) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return best;
  }, userText);
  if (!pt) return '';
  await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(1300);
  const a = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.sub-menu-item,.user-popover-menu-item-content')) {
      if ((el.innerText || '').trim() !== '关于') continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return null;
  });
  if (!a) return '';
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(500);
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(3000);
  const txt = await page.evaluate(() => (document.body.innerText || '').slice(-1200));
  const m = txt.match(/软件版本[：:]\s*([^\s|]+)/);
  return m ? m[1].trim() : '';
}


async function collect(ctx, dcfg, cfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const page = await ctx.newPage();
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const sessionFile = path.join(cfg ? cfg.root : __dirname + '/..', 'aidsc_session.json');
  try {
    await lib.restoreSession(page, ctx, sessionFile);
    await page.goto(`${host}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      // 无会话或已失效 → 验证码 OCR 登录（不可靠，失败给出手动登录提示）
      loggedIn = await ocrLogin(page, ctx, dcfg, sessionFile);
      if (!loggedIn) {
        r.error = 'AiDSC 登录失败：验证码OCR未过或会话过期。请先 node aidsc_pick.js 手动登录一次刷新 aidsc_session.json';
        return r;
      }
      lib.log('AiDSC: 登录成功');
    } else {
      lib.log('AiDSC: 复用已保存会话 (免验证码)');
    }
    const D = await lib.withTimeout(loadD(page), 10000, 'aidsc loadD');
    lib.log(`aidsc D=${D}`);

    const now = Date.now();
    const start = now - 8 * 86400000;
    const series = {};
    for (const t of TYPES) {
      const data = JSON.stringify({ monitorDataType: t, monitorDataStart: start, monitorDataEnd: now, monitorDataStep: 60000 });
      const rid = crypto.randomUUID();
      const sec = secToken(data, rid, D);
      const url = `${host}/webapi/aidsc/3.0/DescribeMonitorData.json?requestId=${rid}&data=${encodeURIComponent(data)}&regionId=&secToken=${sec}&instanceId=`;
      const resp = await ctx.request.get(url);
      const j = await resp.json();
      const md = (j.data && j.data.monitorDatas) || [];
      const vals = (md[0] && md[0].monitorDataValues) || [];
      series[t] = vals
        .map((v) => ({ timeMs: Number(v.acqTime), value: parseFloat(v.acqValue) }))
        .filter((s) => s.timeMs && !isNaN(s.value));
      if (!series[t].length) {
        r.error = `DescribeMonitorData(${t}) 无数据: ` + JSON.stringify(j).slice(0, 200);
        return r;
      }
    }

    const bucket = (s) => lib.bucketByDay(s, { endMs: Date.now() });
    const cpu = bucket(series.cpu_usage_percent_all);
    const mem = bucket(series.mem_usage_percent);
    const disk = bucket(series.disk_usage_percent);

    // 版本号(需求2) —— 走右上角「安全管理员 → 关于」弹窗, 失败不影响主指标。
    // 【DescribeLicense 取不到版本】: 2026-09-20 实测其出参只有 productName/productSN/productModel,
    // licenseSdkVersion 是【空串】, 没有任何版本字段。同 APIG(两家返回结构一致)。
    let ver = '';
    try {
      ver = await versionFromAbout(page, '安全管理员');
      if (ver) lib.log('aidsc 关于弹窗取到版本号: ' + ver);
      else lib.log('aidsc 关于弹窗未取到版本号');
    } catch (e) {
      lib.log('aidsc 关于弹窗异常: ' + String(e.message || e).slice(0, 150));
    }
    if (ver) r.productVersion = ver;

    lib.fillOk(r, {
      cpu: cpu.avg, mem: mem.avg, disk: disk.avg,
      days: cpu.days,
      remarks: `AiDSC数据安全管控平台(${host}) 7天DescribeMonitorData接口采集(签名 secToken)` + (ver ? ` | 版本 ${ver}` : ''),
      source: 'aidsc DescribeMonitorData',
    });
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
