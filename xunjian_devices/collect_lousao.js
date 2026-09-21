// 明鉴漏扫 — 彩色验证码 OCR（分字符），Bearer 引擎实时快照
// 复用 cmd_ls_getcap.js（取图）+ cmd_ls_fill.js（setNative 填表）+ ocr_ls.py
const lib = require('../xunjian_lib');

async function getCaptchaSrc(page) {
  return page.evaluate(() => {
    let src = null;
    document.querySelectorAll('img').forEach((im) => {
      if (!src && im.src && im.src.indexOf('data:image/jpeg') === 0) src = im.src;
    });
    return src;
  });
}

// 真正登录成功的判据：URL 在 /rasm/ 且页面不再显示欢迎登录/登录表单
async function isLoggedIn(page) {
  return page.evaluate(async () => {
    const url = location.href;
    const body = (document.body.innerText || '');
    const onHome = /rasm/.test(url);
    const notLoginPage = !/欢迎登录/.test(body) && !/请输入验证码/.test(body) && !body.includes('登录');
    return onHome && notLoginPage;
  }).catch(() => false);
}

async function tryLogin(page, dcfg, code, getMsg) {
  await page.evaluate(({ user, pass, code }) => {
    const setNative = (el, val) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    const userEl = inputs.find((i) => /(user|用户|账号|用户(名)?)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[0];
    const passEl = inputs.find((i) => /(pass|pwd|密码)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[1];
    const codeEl = inputs.find((i) => /(验证码|captcha|code)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[2];
    if (userEl) setNative(userEl, user);
    if (passEl) setNative(passEl, pass);
    if (codeEl) setNative(codeEl, code);
  }, { user: dcfg.user, pass: dcfg.pass, code });
  // 【必须真实点击】页面上 [class*=login] 先匹配到容器 div, JS .click() 打不中 submit 按钮,
  // 连 POST /ras/auth/tokens 都发不出去(2026-09-20 实测)
  await page.locator('button:visible', { hasText: /登\s*录/ }).first().click({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 16 && !getMsg(); i++) await page.waitForTimeout(500);
  if (/"code"\s*:\s*10000/.test(getMsg())) return true;
  // 以真实登录态为准（登录失败时 localStorage 也可能残留无效 token）
  return isLoggedIn(page);
}

// 共识投票选【唯一】候选。验证码一次性 —— 同一张图只能提交一个候选, 多试必被拒。
// ls 排最后: 其实测连通域合并阈值把整串字符并成一块, 常产出垃圾候选(旧代码正是被它排第一害的)
const ENGINE_PRIORITY = ['ddd', 'bastion', 'enhanced', 'ls'];

// 【公告弹窗】首页会弹「新功能」更新公告, 它带 v-modal 遮罩(z-index 2000)把整个页头盖住 ——
// 遮罩在时鼠标落在用户名上方的其实是 .cut-dialog__wrapper, 下拉菜单永远打不开。
// 按 Escape 可关掉(2026-09-21 实测: Escape 后 v-modal 消失、body 的 cut-popup-parent--hidden 也清掉)。
async function dismissAnnouncement(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1000);
  return page.evaluate(() => !document.querySelector('.v-modal')).catch(() => false);
}

// 【右上角「关于」弹窗】—— 本产品取【完整版本号】和【授权信息】的唯一位置。
// 三个关键点, 全部 2026-09-21 实测:
//   1. 必须先关掉「新功能」公告弹窗, 否则遮罩挡住页头(见上);
//   2. 下拉是【click 触发】, 不是 hover —— 直接点 .dropdown-link-text 就展开。
//      上一轮记的「必须 hover」是错的: 那次多半正是被公告遮罩挡着, 把「hover 无效」
//      误判成了触发方式。点开前判据用菜单项宽高>0, 不要看 style 里有没有 display:none
//      (展开时 style 里干脆没有 display 这个属性, 用 display 判断会判断反)。
//   3. 菜单里「关于」有多个同名节点, 取【可见且面积最小的那个】(LI.cut-dropdown-menu__item)。
// 返回值【限定在弹窗节点内】—— 页头左上角也有一行 "明鉴漏洞扫描系统 V3.0",
// 直接对全文取第一个匹配会取到那个大版本号而不是弹窗里的 V3.0R26C00(2026-09-21 踩过)。
async function aboutDialogText(page) {
  await dismissAnnouncement(page);
  await page.locator('.dropdown-link-text').first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const open = await page.evaluate(() => [...document.querySelectorAll('.cut-dropdown-menu__item')]
    .some((e) => e.getBoundingClientRect().width > 0));
  if (!open) return '';
  const clicked = await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('.cut-dropdown-menu__item')) {
      if ((el.innerText || '').trim() !== '关于') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const a = r.width * r.height;
      if (!best || a < best.a) best = { a, el };
    }
    if (!best) return false;
    best.el.click();
    return true;
  });
  if (!clicked) return '';
  await page.waitForTimeout(3000);
  // 弹窗正文 = 同时含「授权日期」与「明鉴漏洞扫描系统」的最小节点的文本
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('div,section,article')) {
      const t = el.innerText || '';
      if (!/授权日期/.test(t) || !/明鉴漏洞扫描系统/.test(t)) continue;
      if (!best || t.length < best.length) best = t;
    }
    return best || '';
  });
}

async function collect(ctx, dcfg, cfg) {
  const r = lib.emptyResult(dcfg.id, dcfg.product);
  const page = await ctx.newPage();
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const sessionFile = require('path').join(cfg.root, 'lousao_session.json');
  try {
    // 先尝试恢复已保存会话（免 OCR）
    await lib.restoreSession(page, ctx, sessionFile);
    await page.goto(`${host}/rasm/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);

    let loggedIn = await isLoggedIn(page);
    if (loggedIn) {
      lib.log('漏扫: 复用已保存会话 (免验证码)');
    } else {
      // 登录响应作为成功判据(比 DOM 可靠): {"code":10000,"data":{"token":...}}
      let loginMsg = '';
      page.on('response', async (res) => {
        if (/\/ras\/auth\/tokens/.test(res.url())) {
          try { loginMsg = (await res.text()).slice(0, 300); } catch (e) {}
        }
      });
      const cfg0 = require('../xunjian_config');
      // 每轮换一张【全新】验证码: 验证码与当前会话绑定且一次性, 同一张图只有一次提交机会
      for (let attempt = 0; attempt < 6 && !loggedIn; attempt++) {
        loginMsg = '';
        await page.goto(`${host}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3500);
        if (await isLoggedIn(page)) { loggedIn = true; break; }
        const src = await getCaptchaSrc(page);
        if (!src) { lib.log(`漏扫 第${attempt + 1}轮未取到验证码图, 重试`); continue; }
        const code = await lib.pickOneCaptcha(ENGINE_PRIORITY, lib.b64Buffer(src), cfg0);
        if (!code) { lib.log(`漏扫 第${attempt + 1}轮 OCR 无有效候选, 重试`); continue; }
        const okThis = await tryLogin(page, dcfg, code, () => loginMsg);
        lib.log(`漏扫 第${attempt + 1}轮 提交 ${code} → ${okThis ? '成功' : (loginMsg ? loginMsg.slice(0, 80) : '未过')}`);
        if (okThis) { loggedIn = true; break; }
        // 保险: 若哪天服务端也上了"N 次错误即锁号"策略(如 alpha 的"1分钟内5次"),
        // 必须立刻停手 —— 锁号后 OCR 再准也登不进去, 而且会一路锁到人工解锁
        if (/锁定|lock/i.test(loginMsg)) { lib.log('漏扫: 账号被锁定, 停止重试'); r.error = '账号已锁定, 停止重试: ' + loginMsg.slice(0, 120); return r; }
      }
      if (!loggedIn) { r.error = '登录失败（6 轮验证码均未过，每轮均取新图并只提交一个共识候选）'; return r; }
      await lib.saveSession(page, ctx, sessionFile).catch(() => {});
      lib.log('漏扫: 登录态已保存（下次免验证码）');
    }

    // 资源利用率在首页(/rasm/home)页面底部 DOM
    if (!/rasm/.test(page.url())) {
      await page.goto(host + '/rasm/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const body = await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) { window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 500)); }
      await new Promise((r) => setTimeout(r, 1500));
      return document.body.innerText;
    });

    const m = (re) => { const x = body.match(re); return x ? parseFloat(x[1]) : null; };
    const cpu = m(/CPU[：:]\s*核心数\s*\d+\s*[，,]\s*使用率\s*([\d.]+)\s*%/);
    const mem = m(/内存[：:]\s*已使用\s*([\d.]+)\s*%/);
    const disk = m(/磁盘[：:]\s*已使用\s*([\d.]+)\s*%/);
    if (cpu == null || mem == null || disk == null) {
      r.error = '首页底部未解析到资源利用率 DOM: ' + JSON.stringify(body.slice(-300));
      return r;
    }

    // 版本号 + 授权信息(需求2) —— 走【右上角 admin → 关于】弹窗。
    //   首页左上角只显示 "V3.0"(大版本), 关于弹窗才是 "V3.0R26C00"(完整构建号)。2026-09-21 实测。
    // 【不要用 /ras/license/info】: 该接口需 Authorization 头(localStorage.CUT_token)而非 cookie,
    //   未带头返回 401 {"code":10004,"msg":"用户未登录"}; 带上头能通, 但其 licenseVersion 字段
    //   值是【"测试"】两个字(许可批次描述), 不是版本号。
    const aboutTxt = await aboutDialogText(page);
    const vm = aboutTxt.match(/明鉴漏洞扫描系统\s*(V[\w.]+)/);
    const ver = vm ? vm[1] : '';
    if (ver) r.productVersion = ver;
    else lib.log('漏扫 关于弹窗未匹配到版本串: ' + aboutTxt.replace(/\s+/g, ' ').slice(-200));

    // 授权信息: 同一个弹窗里就有, 顺手抓下来(授权到期是表里要的一列)
    if (aboutTxt) {
      const g = (re) => { const m = aboutTxt.match(re); return m ? m[1].trim() : ''; };
      const dt = '(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})';
      const lic = {
        授权日期: g(new RegExp('授权日期[：:]\\s*' + dt)),
        过期时间: g(new RegExp('过期时间[：:]\\s*' + dt)),
        维保日期: g(new RegExp('维保日期[：:]\\s*' + dt)),
        授权类型: g(/授权类型[：:]\s*([^\s\n]+)/),
        客户信息: g(/客户信息[：:]\s*([^\n]+)/),
        服务代码: g(/服务代码[：:]\s*([^\s\n]+)/),
      };
      for (const k of Object.keys(lic)) if (lic[k]) { r.metrics = r.metrics || {}; r.metrics[k] = lic[k]; }
    }

    lib.fillOk(r, {
      cpu, mem, disk,
      remarks: `明鉴漏洞扫描系统(${host}) 首页底部实时快照; CPU核心数/内存${mem}%/磁盘${disk}%` + (ver ? ` | 版本 ${ver}` : ''),
      source: 'lousao /rasm/home DOM资源利用率',
    });
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
