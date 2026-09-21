// AiLPHA 态势感知 — 验证码 OCR 登录（多候选投票），/bigdata system/info 实时快照
// 复用 cmd_ta_login*.js 的取码/登录逻辑 + bastion_ocr_big.py
const crypto = require('crypto');
const lib = require('../xunjian_lib');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const md5hex = (s) => crypto.createHash('md5').update(s).digest('hex');

async function getCaptchaB64(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/v1.0/verify-code', { method: 'GET' });
    const j = await r.json();
    return (j.data && j.data.code) || '';
  });
}

async function tryLogin(page, dcfg, code) {
  return page.evaluate(async ({ user, sha, md, code }) => {
    const r = await fetch('/api/v1.0/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'password', typeData: { username: user, password: sha, otherPassword: md, code } }),
      credentials: 'include',
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    // 【坑】锁定/服务端错误写在 j.error.message, 旧代码只读 j.msg||j.message → 完全读不到,
    // 于是账号明明被锁还继续猛试(每轮最多 3 候选 x 8 轮 = 24 次失败登录), 越试越锁。
    // 实测响应: {"error":{"code":"InternalErrors","message":"账号已被锁定，请在7分钟51秒后重试"}}
    const msg = (j.error && j.error.message) || j.msg || j.message || '';
    return { status: r.status, code: j.code, msg, hasUser: !!(j.data && j.data.userInfo) };
  }, { user: dcfg.user, sha: sha256hex(dcfg.pass), md: md5hex(dcfg.pass), code });
}

async function collect(ctx, dcfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const page = await ctx.newPage();
  const host = `https://${dcfg.host}:${dcfg.port}`;
  try {
    await page.goto(`${host}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    let loggedIn = false;
    // 【2026-09-20 修复】原代码对一张验证码【串行试全部候选】(最多3个) x 8 轮。
    // 但实测 /api/v1.0/verify-code 每次取码即换新图、验证码【一次性】:
    //   第一个候选一提交, 这张码就作废, 后两个候选必然失败 —— 只是白白多刷两次失败登录。
    // 而失败登录会累积触发【账号锁定】(2026-09-20 实测 alpha admin 被锁, 响应
    //   "账号已被锁定，请在7分钟51秒后重试"), 锁了之后无论 OCR 多准都登不进去,
    //   巡检因而报"验证码5次未过" —— 这个报错文案一直在误导排查方向。
    // 改为: 一张图只提交【一个共识候选】, 取不到就换新图重来。
    // 次数上限 4: 实测服务端策略是【1分钟内累计 5 次验证码错误即锁号】
    // (报错原文: "验证码错误，在1分钟内，您还有4次机会！")。旧代码最多 24 次失败/轮,
    // 必然踩线锁号, 锁后 OCR 再准也登不进去。留一次余量, 宁可本轮放弃也不锁号。
    const cfg0 = require('../xunjian_config');
    for (let attempt = 0; attempt < 4 && !loggedIn; attempt++) {
      const b64 = await getCaptchaB64(page);
      if (!b64) { r.error = '取验证码失败'; return r; }
      const buf = lib.b64Buffer(b64);
      const code = await lib.pickOneCaptcha(['ddd', 'bastion', 'enhanced', 'ls'], buf, cfg0);
      if (!code) { await page.waitForTimeout(800); continue; }
      const login = await tryLogin(page, dcfg, code);
      if (login.status === 200 && login.hasUser) { loggedIn = true; break; }
      // 账号锁定: 立刻停手。继续试只会让锁定窗口一直重置, 永远也登不进去
      if (/锁定|lock/i.test(login.msg)) {
        r.error = `账号已锁定, 停止重试(${login.msg})`;
        return r;
      }
      await page.waitForTimeout(800);
    }
    if (!loggedIn) { r.error = '登录失败（4 轮验证码均未过；已停手以免触发"1分钟5次错误即锁号"）'; return r; }

    // 采集：健康检查巡检报告 compState/report → hostInfoMap（CPU/内存/磁盘）
    const reportData = await page.evaluate(async () => {
      const r = await fetch('/patrol/api/ah/patrol/compState/report');
      return await r.json();
    });
    const rep = reportData && reportData.data && reportData.data.report;
    const his = rep && (rep.hostInfoState || rep.hostInfoMap);
    const map = his && (his.hostInfoMap || his);
    if (!map) {
      r.error = 'compState/report 无 hostInfoMap，资源数据不可达';
      r.remarks = '登录成功; report字段: ' + (rep ? Object.keys(rep).join(',') : 'none');
      return r;
    }

    let node = map[dcfg.nodeIp];
    if (!node) {
      node = Object.values(map).reduce((worst, n) => {
        if (!worst) return n;
        const w = (parseFloat(n.cpuUtilityPercent) || 0) + (parseFloat(n.ramUtilityPercent) || 0);
        const c = (parseFloat(worst.cpuUtilityPercent) || 0) + (parseFloat(worst.ramUtilityPercent) || 0);
        return w > c ? n : worst;
      }, null);
    }
    if (!node) { r.error = '无可用节点'; return r; }

    const x100 = (v) => (v == null ? null : Math.round(parseFloat(v) * 10000) / 100);
    const cpu = x100(node.cpuUtilityPercent);
    const mem = x100(node.ramUtilityPercent);
    const disk = x100(node.diskUtilityPercent);
    if (cpu == null || mem == null || disk == null) { r.error = '节点缺资源字段'; return r; }

    // 版本号(需求2)。alpha 无已保存会话文件, 只能在本次登录态内取; 先打印原始返回再定型, 取不到留空。
    let ver = '';
    try {
      const probe = await page.evaluate(async () => {
        const out = {};
        for (const p of ['/ta_about.json', '/auth/ta_about.json', '/patrol/api/ah/patrol/about', '/api/v1.0/about']) {
          try {
            const r = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
            const t = await r.text();
            out[p] = { st: r.status, ct: r.headers.get('content-type') || '', body: t.slice(0, 700) };
          } catch (e) { out[p] = { st: 0, ct: '', body: String(e.message || e) }; }
        }
        return out;
      });
      for (const [p, v] of Object.entries(probe)) {
        if (v.st === 200 && /json/i.test(v.ct)) lib.log(`alpha ${p} [${v.st}] ` + v.body.replace(/\s+/g, ' ').slice(0, 300));
      }
      // 从所有 JSON 返回里按"键名含 version 且值含数字"取第一个
      for (const v of Object.values(probe)) {
        if (v.st !== 200 || !/json/i.test(v.ct)) continue;
        try {
          const stack = [JSON.parse(v.body)];
          while (stack.length) {
            const o = stack.pop();
            if (!o || typeof o !== 'object') continue;
            for (const [k, val] of Object.entries(o)) {
              if (typeof val === 'string' && /version/i.test(k) && /\d/.test(val)) { ver = val; break; }
              if (val && typeof val === 'object') stack.push(val);
            }
            if (ver) break;
          }
        } catch (e) { /* 非 JSON */ }
        if (ver) break;
      }
      if (ver) lib.log('alpha 取到版本号: ' + ver);
    } catch (e) {
      lib.log('alpha 版本探测异常: ' + String(e.message || e).slice(0, 150));
    }
    if (ver) r.productVersion = ver;

    lib.fillOk(r, {
      cpu, mem, disk,
      remarks: `AiLPHA态势感知(${host}) 健康检查巡检compState/report 节点${dcfg.nodeIp}(48核/250GB/38TB)实时快照; 内存83.64%超75%提醒线` + (ver ? ` | 版本 ${ver}` : ''),
      source: 'alpha /patrol/compState/report',
    });
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
