// 会话自动激活 — 无人值守 OCR 重新登录(验证码识别优先)
// 由 session_keepalive.js 在探测到会话失效/临期时调用；OCR 全失败才由 keepalive 弹窗人工兜底
// 每个设备复用其 *_pick/collect 中已被验证过的取码/填表/判活逻辑，仅做"登录+保存会话"，
// 不做资源采集。成功判据与 session_keepalive.js 的 probeType 一一对齐。
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const lib = require('./xunjian_lib');
const cfg = require('./xunjian_config');

const offLoginRe = /(^|\/)(#\/)?login/i;

// ---------- 通用: base64 img -> buffer ----------
const buf = (b64) => lib.b64Buffer(b64);

// ---------- EDR 账号锁定冷却 ----------
// 2026-09-10 实测: EDR 有密码错误计数锁号策略, 无人值守连续试登会把生产账号(admin/manger)锁死,
// 锁定后服务端直接返回 400 用户已被锁定。故一旦检测到锁定就写冷却文件, 冷却期内一律不再自动登录。
const EDR_LOCK_FILE = path.join(cfg.root, 'edr_lockout.json');
const EDR_LOCK_MIN = 360; // 分钟

function edrLock() {
  try {
    const j = JSON.parse(fs.readFileSync(EDR_LOCK_FILE, 'utf8'));
    if (j && j.until > Date.now()) return j;
  } catch (e) {}
  return null;
}
function edrSetLock(why) {
  const until = Date.now() + EDR_LOCK_MIN * 60 * 1000;
  try { fs.writeFileSync(EDR_LOCK_FILE, JSON.stringify({ until, setAt: Date.now(), why }, null, 2), 'utf8'); } catch (e) {}
  lib.log(`⚠️ EDR 账号已锁定(${why})，自动登录冷却 ${EDR_LOCK_MIN} 分钟至 ${new Date(until).toLocaleString()}`);
  return until;
}

async function launchCtx() {
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: true,
    args: cfg.browser.args,
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  return { browser, ctx };
}

function closeCtx(browser, ctx) {
  return Promise.all([ctx.close().catch(() => {}), browser.close().catch(() => {})]);
}

// 多引擎候选合并（去重、保留次序）
async function ocrUnion(engines, b64, note) {
  if (!b64) return [];
  const out = [];
  for (const e of engines) {
    try { out.push(...await lib.ocr(e, buf(b64), cfg)); } catch (err) { lib.log(`${note} OCR(${e}) 异常: ${String(err.message || err).slice(0, 60)}`); }
  }
  return [...new Set(out)];
}

// ================= EDR 终端安全 27443 (manger / 超管) =================
// 取码: 读页面自身最后一张 img[src^="data:image"]（**不要**再 fetch('/captcha')，那会换新图→永远验证码错误）;
//       表单 input[name=username/password/captcha]（name=password 那个框 type=text, 另一个 readonly 密码框是诱饵）
// 关键: 仅"URL 离开 #/login"不足以证明登录成功(SPA 可能只渲染壳)，须用登录响应里的 token /
//       localStorage.CUT_token 确认鉴权接口返回 200 再保存会话(2026-09-10 实测两次均 200)
async function loginEDR(user, pass, sessionFile, verifyPath) {
  const dcfg = cfg.devices.hs;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const vpath = verifyPath || '/user_license/list_licenses?offset=0';
  const { browser, ctx } = await launchCtx();
  try {
    // 每次尝试用【全新 page】(同一 ctx 复用 cookie)：失败提交后 EDR 的 SPA 会清掉表单且
    // hash 路由 goto/reload 都不重建登录页 → 新开 page 才能保证干净的首屏状态(2026-09-09 实测)
    // 锁号冷却期: 直接放弃, 不开浏览器(避免给已锁账号继续加错误计数)
    const lk = edrLock();
    if (lk) return { ok: false, locked: true, note: `EDR 账号锁定冷却中(至 ${new Date(lk.until).toLocaleString()})，跳过自动登录` };

    let success = false;
    let page = null;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) { // 限2次: EDR 有错误计数锁号策略, 宁可下轮再试也不能锁死生产账号
      page = await ctx.newPage();
      let hdr = ''; // 取【最后一个】Authorization(登录前可能已有陈旧头, 第一个不是登录后那个)
      let msg = ''; // 登录接口返回体(锁定/密码错判据比页面 toast 可靠)
      page.on('request', (r) => { const h = r.headers()['authorization']; if (h) hdr = h; });
      page.on('response', async (r) => {
        if (r.request().method() === 'POST' && /\/login(\?|$)/.test(r.url())) {
          msg = (await r.text().catch(() => '')).slice(0, 200);
        }
      });
      let keep = false;
      try {
        await page.goto(host + '/#/login', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
        // 【关键】必须用页面自己显示的那张验证码图。再 fetch('/captcha') 会生成新的一张,
        // 与服务端当前持有的不一致 → 永远"验证码错误"(2026-09-10 真机定位, 此前 8/8 全败的根因)
        const b64 = await page.evaluate(() => {
          const im = [...document.querySelectorAll('img')].filter((x) => (x.src || '').startsWith('data:image'));
          return im.length ? im[im.length - 1].src : '';
        }).catch(() => '');
        if (b64) {
          const code = (await ocrUnion(['ddd'], b64, 'EDR'))[0] || '';
          if (code && code.length >= 4) {
            await page.locator('input[name=username]').fill(user, { timeout: 8000 });
            await page.locator('input[name=password]').fill(pass, { timeout: 8000 });
            await page.locator('input[name=captcha]').fill(code, { timeout: 8000 });
            await page.getByRole('button').filter({ hasText: /登\s*录/ }).first().click().catch(() => {});
            for (let i = 0; i < 20 && !msg; i++) await page.waitForTimeout(500);
            const url = page.url();
            const txt = await page.evaluate(() => document.body.innerText.slice(0, 160).replace(/\s+/g, ' ')).catch(() => '');
            if (/登录成功/.test(msg)) {
              // 登录成功后 SPA 才把 token 写进 localStorage; 用它校验(比抓请求头可靠)
              await page.waitForTimeout(3500);
              const lsTok = await page.evaluate(() => {
                const raw = localStorage.getItem('CUT_token');
                if (!raw) return '';
                try { const p = JSON.parse(raw); return typeof p === 'string' ? p : (p && p.token) || raw; } catch (e2) { return raw; }
              }).catch(() => '');
              let use = lsTok || hdr;
              if (use && !/^Bearer\s/i.test(use)) use = 'Bearer ' + use;
              const st = use ? await page.evaluate(async ({ t, u }) => { const r = await fetch(u, { headers: { Authorization: t, Accept: 'application/json' } }); return r.status; }, { t: use, u: vpath }).catch(() => -1) : -1;
              if (st === 200 || lsTok) { success = true; keep = true; break; }
              lib.log(`EDR(${user}) 第${attempt}次 登录成功但鉴权接口 ${st}，重试`);
            } else if (/已被锁定|账号锁定|锁定/i.test(msg + ' ' + txt)) {
              const until = edrSetLock(`登录接口返回 ${msg.slice(0, 60)}`);
              return { ok: false, locked: true, note: `EDR(${user}) 账号已被锁定，已进入冷却至 ${new Date(until).toLocaleString()}` };
            } else if (/密码错误|用户名或密码/.test(msg)) {
              // 口令不对重试没有意义, 只会把账号推向锁定 → 同样进冷却, 交给人工核对密码
              const until = edrSetLock('口令校验未通过(用户名或密码错误)');
              return { ok: false, locked: true, note: `EDR(${user}) 提示"用户名或密码错误"，自动登录无意义，已冷却至 ${new Date(until).toLocaleString()}` };
            } else {
              lib.log(`EDR(${user}) 第${attempt}次 未通过(验证码 ${code}): ${(msg || txt).slice(0, 80)}`);
            }
          }
        }
      } catch (e) {
        lib.log(`EDR(${user}) 第${attempt}次 异常: ` + String(e.message || e).slice(0, 60));
      } finally {
        if (!keep) await page.close().catch(() => {});
      }
    }
    if (!success) return { ok: false, note: 'EDR OCR 登录未过（验证码/锁定/鉴权未通过）' };
    await page.waitForTimeout(2000); // 让 SPA 主界面稳定后再存
    const s = await lib.saveSession(page, ctx, sessionFile);
    return { ok: true, note: `EDR(${user}) 已登录并校验鉴权200, 会话已保存 (ls ${s.lsCount}/ck ${s.cookieCount})` };
  } finally { await closeCtx(browser, ctx); }
}

// ================= UES 办公智盾 53443 =================
// 取码: img[src*="loginVerifyCode"] 相对路径 → 页内 fetch 转 base64; ddd 4-5位
async function loginUES(sessionFile) {
  const dcfg = cfg.devices.ues;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const { browser, ctx } = await launchCtx();
  try {
    const page = await ctx.newPage();
    let success = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await page.goto(host + '/', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const capImg = await page.locator('img[src*="loginVerifyCode"]').first().getAttribute('src').catch(() => '');
      if (!capImg) { await page.waitForTimeout(1000); continue; }
      const capUrl = capImg.startsWith('http') ? capImg : host + capImg;
      const b64 = await page.evaluate(async (u) => {
        const r = await fetch(u); const ab = await r.arrayBuffer();
        const bytes = new Uint8Array(ab); let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      }, capUrl).catch(() => '');
      const code = (await ocrUnion(['ddd'], b64, 'UES'))[0] || '';
      if (!/^[a-zA-Z0-9]{4,5}$/.test(code)) continue;
      await page.locator('input[name=username]').fill(dcfg.user);
      await page.locator('input[name=password]').fill(dcfg.pass);
      await page.locator('input').nth(2).fill(code);
      await page.getByRole('button').filter({ hasText: /登\s*录/ }).first().click().catch(() => {});
      await page.waitForTimeout(3500);
      const st = await page.evaluate(() => {
        const body = (document.body.innerText || '');
        return { url: location.href, ok: body.includes('安全概览') || (!offLoginRe.test(location.href) && !body.includes('欢迎登录')) };
      }).catch(() => ({ ok: false }));
      if (st.ok) { success = true; break; }
      lib.log(`UES 第${attempt}次 登录未过 (${code})`);
    }
    if (!success) return { ok: false, note: 'UES OCR 登录未过' };
    await page.waitForTimeout(3000);
    const s = await lib.saveSession(page, ctx, sessionFile);
    return { ok: true, note: `UES 会话已保存 (ls ${s.lsCount}/ck ${s.cookieCount})` };
  } finally { await closeCtx(browser, ctx); }
}

// ================= 漏扫 8891（彩色验证码，多引擎） =================
// 【2026-09-20 定因】此前"彩色验证码 OCR 识别率低 / 只能人工登录"的结论是错的。
// 实测: ddddocr 在同一张图上读得和肉眼完全一致(bnad), bastion/enhanced 也一致,
//       只有专用引擎 ocr_ls 读错(它的连通域合并阈值 <=6px 把 4 个字符并成一个块 → 输出垃圾)。
// 真因是【候选排序 + 验证码一次性】的组合:
//   1) GET /ras/auth/captcha 每次返回新图, 且验证码与当前会话绑定、【一次使用即作废】
//      (重抓一次接口, 页面显示的那张立刻失效 —— 与 EDR 同一个坑)
//   2) 旧代码把 ls/ddd/bastion/enhanced 的候选【串行全部尝试】, 而 ls 的垃圾候选恰好排第一
//      → 提交垃圾 = 消耗掉这张验证码 → 后面正确的 bnad 必然失败 → "OCR 全败"的假象
// 修法: 每张验证码【只提交一个】候选, 且该候选由多引擎共识投票选出; 失败就换一张新图重来。
async function loginLousao(sessionFile) {
  const dcfg = cfg.devices.lousao;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const { browser, ctx } = await launchCtx();
  try {
    const page = await ctx.newPage();
    const isLoggedIn = () => page.evaluate(() => {
      const url = location.href; const body = (document.body.innerText || '');
      return /rasm/.test(url) && !/欢迎登录/.test(body) && !/请输入验证码/.test(body) && !body.includes('登录');
    }).catch(() => false);
    const getCap = () => page.evaluate(() => {
      let src = null;
      document.querySelectorAll('img').forEach((im) => { if (!src && im.src && im.src.indexOf('data:image/jpeg') === 0) src = im.src; });
      return src;
    });

    // 登录响应(比 DOM/URL 判据更可靠): {"code":10000,"data":{"token":...}} = 成功
    let loginMsg = '';
    page.on('response', async (r) => {
      if (/\/ras\/auth\/tokens/.test(r.url())) {
        try { loginMsg = (await r.text()).slice(0, 300); } catch (e) {}
      }
    });

    // 共识投票选【唯一】候选(见 xunjian_lib.pickOneCaptcha 注释):
    // 验证码一次性, 同一张图只能提交一个; ls 放最后, 其分字符合并逻辑有 bug 常产出垃圾候选
    const ENGINE_PRIORITY = ['ddd', 'bastion', 'enhanced', 'ls'];

    const tryCode = async (code) => {
      await page.evaluate(({ user, pass, code }) => {
        const setNative = (el, val) => {
          if (!el) return;
          const proto = Object.getPrototypeOf(el); const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')];
        const u = inputs.find((i) => /(user|用户|账号)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[0];
        const p = inputs.find((i) => /(pass|pwd|密码)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[1];
        const c = inputs.find((i) => /(验证码|captcha|code)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[2];
        if (u) setNative(u, user); if (p) setNative(p, pass); if (c) setNative(c, code);
      }, { user: dcfg.user, pass: dcfg.pass, code });
      // 【必须用真实点击】页面上 [class*=login] 会先匹配到容器 div, 旧代码的 JS .click() 打不中
      // submit 按钮 → 连 POST 都发不出去(2026-09-20 实测: JS click 时网络里没有任何 /ras/auth/tokens)
      await page.locator('button:visible', { hasText: /登\s*录/ }).first().click({ timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 16 && !loginMsg; i++) await page.waitForTimeout(500);
      if (/"code"\s*:\s*10000/.test(loginMsg)) return true;
      if (loginMsg) lib.log(`漏扫 登录被拒: ${loginMsg.slice(0, 120)}`);
      return isLoggedIn();
    };

    let success = false;
    // 每轮换一张【全新】验证码: 验证码一次性, 同一张图只有一次提交机会(见函数头注释)
    for (let attempt = 0; attempt < 6 && !success; attempt++) {
      loginMsg = '';
      await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3500);
      if (await isLoggedIn()) { success = true; break; } // 意外已是登录态
      const b64 = await getCap();
      if (!b64) { lib.log(`漏扫 第${attempt + 1}轮未取到验证码图, 重试`); continue; }
      const code = await lib.pickOneCaptcha(ENGINE_PRIORITY, buf(b64), cfg);
      if (!code) { lib.log(`漏扫 第${attempt + 1}轮 OCR 无有效候选, 重试`); continue; }
      const okThis = await tryCode(code);
      lib.log(`漏扫 第${attempt + 1}轮 提交 ${code} → ${okThis ? '成功' : '未过'}`);
      if (okThis) { success = true; break; }
      // 保险: 服务端若启用"N 次错误即锁号"(alpha 是"1分钟内5次"), 必须立刻停手, 否则越试越锁
      if (/锁定|lock/i.test(loginMsg)) return { ok: false, note: '漏扫账号已锁定, 停止重试: ' + loginMsg.slice(0, 100) };
    }
    if (!success) return { ok: false, note: '漏扫验证码 6 轮未过(每轮 4 字符共识候选, 均为一次性提交)' };
    await page.waitForTimeout(2000);
    const s = await lib.saveSession(page, ctx, sessionFile);
    return { ok: true, note: `漏扫 会话已保存 (ls ${s.lsCount}/ck ${s.cookieCount})` };
  } finally { await closeCtx(browser, ctx); }
}

// ================= APT 攻击预警 (LC1 6943 / LC2 4743) =================
async function loginAPT(dcfg, sessionFile) {
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const { browser, ctx } = await launchCtx();
  try {
    const page = await ctx.newPage();
    const lsAuthKeys = () => page.evaluate(() => {
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/token|auth|session/i.test(k)) ls[k] = true; }
      return Object.keys(ls);
    }).catch(() => []);
    const tryCode = async (code) => {
      await page.evaluate(({ user, pass, code }) => {
        const setNative = (el, val) => {
          if (!el) return;
          const proto = Object.getPrototypeOf(el); const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // 只填【可见】input: 登录页有 6 个 input, 后 3 个属于隐藏的 thirdAuth 表单, 按下标填会填错行
        const vis = [...document.querySelectorAll('input')].filter((i) => i.offsetWidth || i.offsetHeight || i.getClientRects().length);
        setNative(vis[0], user); setNative(vis[1], pass);
        const cap = vis.find((i) => /验证码|captcha/i.test((i.name || '') + (i.placeholder || '')));
        if (cap) setNative(cap, code);
      }, { user: dcfg.user, pass: dcfg.pass, code });
      // 必须真实点击: JS .click() 打不中提交按钮(与漏扫同一个坑)
      await page.locator('button:visible', { hasText: /登\s*录/ }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const keys = await lsAuthKeys();
      return { url: page.url(), lsKeys: keys, hasAuth: keys.length > 0 };
    };
    const getCap = () => page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.src && i.src.includes('base64'));
      return imgs.length ? imgs[imgs.length - 1].src : '';
    });
    // token 在 localStorage.echo_token(JSON 编码串) → 裸 JWT
    const readToken = () => page.evaluate(() => {
      const raw = localStorage.getItem('echo_token'); if (!raw) return '';
      try { const p = JSON.parse(raw); if (typeof p === 'string') return p; if (p && typeof p === 'object' && typeof p.token === 'string') return p.token; } catch (e) {}
      return raw;
    }).catch(() => '');
    // 【必须带 Authorization: Bearer】—— 应用用自己的 axios 拦截器加这个头, 裸 fetch 绕过它,
    // 服务端永远回 401 "缺少token"。旧代码这里就是裸 fetch, 所以【即使登录成功也永远判失败】:
    // 下面的 checkAuthed 兜底、以及末尾的 authed 终判, 全部恒不等于 200 → 一直 reload → 把刚登好的会话又打回登录页。
    const checkAuthed = () => page.evaluate(async () => {
      const raw = localStorage.getItem('echo_token'); if (!raw) return -1;
      let t = raw; try { t = JSON.parse(raw); } catch (e) {}
      if (typeof t !== 'string') t = '';
      const r = await fetch('/system/status', { headers: { Authorization: 'Bearer ' + t }, credentials: 'include' });
      return r.status;
    }).catch(() => -1);
    let success = false;
    for (let attempt = 0; attempt < 6 && !success; attempt++) {
      if (attempt > 0) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      else await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const b64 = await getCap();
      if (!b64) { await page.waitForTimeout(800); continue; }
      // 验证码一次性(2026-09-20 实测 /auth/captcha 重取即换新图) → 一张图只提交一个共识候选。
      // ls 排最后: 其合并逻辑有 bug。旧代码串行全试, ddd 读错时那张图就被浪费掉了。
      // captchaLen 必须传 —— APT 是 5 位, 按 4 位过滤会把四个引擎都读对的答案整个滤掉(实测 3mdmx)。
      const code = await lib.pickOneCaptcha(['ddd', 'bastion', 'enhanced', 'ls'], buf(b64), cfg, dcfg.captchaLen);
      if (!code) { await page.waitForTimeout(600); continue; }
      const res = await tryCode(code);
      const offLogin = !offLoginRe.test(res.url);
      if ((res.hasAuth && offLogin) || (res.lsKeys.length && offLogin)) { success = true; break; }
      // 兜底：某次提交其实已成功但 URL 判定滞后 → 用真实鉴权接口确认，避免误 reload 登出(clobber)
      if (await checkAuthed() === 200) { success = true; break; }
    }
    if (!success) return { ok: false, note: `${dcfg.product} OCR 登录未过` };
    // 必须真实可鉴权（/system/status 200，带 Bearer），避免存到登录页残留态
    let authed = false;
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(1500);
      if (await checkAuthed() === 200) { authed = true; break; }
    }
    if (!authed) return { ok: false, note: `${dcfg.product} 登录后 /system/status 未 200` };
    const s = await lib.saveSession(page, ctx, sessionFile);
    return { ok: true, note: `${dcfg.product} 会话已保存 (ls ${s.lsCount}/ck ${s.cookieCount})` };
  } finally { await closeCtx(browser, ctx); }
}

// ================= AiDSC 数据安全管控 6543 =================
async function loginAidsc(sessionFile) {
  const dcfg = cfg.devices.aidsc;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const { browser, ctx } = await launchCtx();
  try {
    const page = await ctx.newPage();
    const isLoggedIn = () => page.evaluate(() => {
      const url = location.href; const body = (document.body.innerText || '');
      return !/login/i.test(url) && !/欢迎登录|请输入验证码/.test(body) && !document.getElementById('form_item_captcha');
    }).catch(() => false);
    const getCap = () => page.evaluate(() => {
      let src = null;
      document.querySelectorAll('img').forEach((im) => { if (!src && im.src && im.src.indexOf('data:image') === 0) src = im.src; });
      return src;
    });
    const tryCode = async (code) => {
      await page.evaluate(({ user, pass, code }) => {
        const setVal = (el, val) => {
          if (!el) return false;
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          desc.set.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        setVal(document.getElementById('form_item_username'), user);
        setVal(document.getElementById('form_item_password'), pass);
        if (code) setVal(document.getElementById('form_item_captcha'), code);
        const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim().indexOf('登') >= 0);
        if (btn) btn.click();
      }, { user: dcfg.user, pass: dcfg.pass, code });
      await page.waitForTimeout(7000);
      return isLoggedIn();
    };
    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      else await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      if (await isLoggedIn()) { success = true; break; }
      const b64 = await getCap();
      if (!b64) { await page.waitForTimeout(600); continue; }
      const cands = (await ocrUnion(['ddd', 'bastion', 'enhanced'], b64, 'Aidsc')).filter((c) => /^[0-9a-zA-Z]{4}$/.test(c));
      for (const code of cands) { if (await tryCode(code)) { success = true; break; } }
    }
    if (!success) return { ok: false, note: 'Aidsc OCR 登录未过' };
    await page.waitForTimeout(1500);
    const s = await lib.saveSession(page, ctx, sessionFile);
    return { ok: true, note: `Aidsc 会话已保存 (ls ${s.lsCount}/ck ${s.cookieCount})` };
  } finally { await closeCtx(browser, ctx); }
}

// ================= LT 堡垒机 (明御运维审计 DAS, 7443) =================
async function loginLT(sessionFile) {
  const dcfg = cfg.devices.ltbastion;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const AUTH_MARKER = 'DAS_USM_ROUTER_AUTH_';
  const { browser, ctx } = await launchCtx();
  try {
    const page = await ctx.newPage();
    const getCap = () => page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.src && /base64|data:image/.test(i.src));
      return imgs.length ? imgs[imgs.length - 1].src : null;
    });
    // 【坑 1 成功判据】登录页冷启动时 localStorage 里就已经有一个【登录前占位 token】，
    // 它会被带到 get_captcha/auth 这些请求上 → "localStorage 里有 token"和"抓到 authorization 头"都【不能】
    // 当登录成功判据，否则永远假成功(2026-09-10 实测: 假成功存下的 token 打 pamapi 全是 UNAUTHENTICATED)。
    // 唯一可靠判据: 拿候选 token 打只读 pamapi，返回 code === 'OK'。
    const verify = () => page.evaluate(async ({ res, m }) => {
      const toks = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(m) >= 0) toks.push(localStorage.getItem(k)); }
      for (const tok of toks) {
        try {
          const r = await fetch(res, { headers: { authorization: tok, 'content-type': 'application/json', lang: 'ZH_CN' } });
          const j = await r.json();
          if (j && j.code === 'OK') return tok;
        } catch (e) {}
      }
      return '';
    }, { res: '/pamapi/maintain/v1/license:get_license_info', m: AUTH_MARKER }).catch(() => '');
    let goodTok = '';
    for (let attempt = 0; attempt < 4 && !goodTok; attempt++) {
      if (attempt > 0) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      else await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const b64 = await getCap();
      if (!b64) { await page.waitForTimeout(1000); continue; }
      const cands = (await ocrUnion([dcfg.ocr || 'bastion'], b64, 'LT堡垒机'));
      for (const code of cands) {
        try {
          await page.locator('input').nth(0).fill(dcfg.user, { timeout: 4000 });
          await page.locator('input').nth(1).fill(dcfg.pass, { timeout: 4000 });
          const ci = page.locator('input').nth(2);
          if (await ci.count()) await ci.fill(code, { timeout: 4000 });
          await page.locator('button[type=submit], button').last().click().catch(() => {});
          for (let i = 0; i < 15 && !goodTok; i++) { await page.waitForTimeout(1000); goodTok = await verify(); }
          if (goodTok) break;
        } catch (e) {}
      }
    }
    if (!goodTok) return { ok: false, note: 'LT堡垒机 DAS 登录(OCR) 未过(pamapi 未返回 OK)' };
    const s = await lib.saveSession(page, ctx, sessionFile);
    // 【坑 2】登录后前端会把 localStorage 的 token 轮换成无效占位值, 所以存完会话再把【校验通过的那个】写回文件
    try {
      const obj = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      obj.ls = obj.ls || {};
      let key = Object.keys(obj.ls).find((k) => k.indexOf(AUTH_MARKER) >= 0);
      if (!key) key = AUTH_MARKER;
      obj.ls[key] = goodTok;
      fs.writeFileSync(sessionFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {}
    return { ok: true, note: `LT堡垒机 会话已保存并校验 pamapi=OK (ls ${s.lsCount}/ck ${s.cookieCount})` };
  } finally { await closeCtx(browser, ctx); }
}

// ================= DasV 大屏 19480（无验证码，纯自动登录探活） =================
async function loginDasv() {
  const dcfg = cfg.devices.dasv;
  const host = `http://${dcfg.host}:${dcfg.port}`;
  const { browser, ctx } = await launchCtx();
  try {
    const page = await ctx.newPage();
    await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('input', { timeout: 20000 }).catch(() => {});
    const ins = page.locator('input');
    await ins.nth(0).fill(dcfg.user);
    await ins.nth(1).fill(dcfg.pass);
    const clicked = await page.evaluate(() => {
      const cand = [...document.querySelectorAll('button, input[type=button], input[type=submit], [role=button], .ant-btn')];
      const b = cand.find((x) => { const t = ((x.textContent || '') + ' ' + (x.value || '')).replace(/\s+/g, ''); return t.includes('登') && t.includes('录'); });
      if (b) { b.click(); return true; } return false;
    });
    if (!clicked) return { ok: false, note: 'DasV 未找到登录按钮' };
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const t = await page.evaluate(() => !!localStorage.getItem('DasV-Edit_token')).catch(() => false);
      if (t) { await page.waitForTimeout(1500); return { ok: true, note: 'DasV 自动登录成功 (无会话文件，采集时现登)' }; }
    }
    return { ok: false, note: 'DasV 登录超时' };
  } finally { await closeCtx(browser, ctx); }
}

// ================= 对外统一入口 =================
// t: keepalive TARGET 项 {name, file, probeType, aptId?}
async function activate(t) {
  const file = t.file ? path.join(cfg.root, t.file) : null;
  let r;
  switch (t.activate) {
    case 'hs':        r = await loginEDR(cfg.devices.hs.user, cfg.devices.hs.pass, file, '/user_license/list_licenses?offset=0'); break; // hs_session.json (manger)
    case 'hs_admin':  r = await loginEDR(cfg.devices.hs.adminUser, cfg.devices.hs.adminPass, file, '/upgrade/get_upgrade_progress'); break; // hs_admin_session.json (超管)
    case 'ues':       r = await loginUES(file); break;
    case 'lousao':    r = await loginLousao(file); break;
    case 'apt': {
      const dcfg = (cfg.apt || []).find((d) => String(d.id) === String(t.aptId));
      if (!dcfg) r = { ok: false, note: 'APT 实例未配置 id=' + t.aptId };
      else r = await loginAPT(dcfg, file);
      break;
    }
    case 'aidsc':     r = await loginAidsc(file); break;
    case 'ltb':       r = await loginLT(file); break;
    case 'dasv':      r = await loginDasv(); break; // DasV 无会话文件
    default:          r = { ok: false, note: '未定义激活类型 ' + t.activate };
  }
  // 记录文件由调用方 session_keepalive.js 统一按"状态变化"写档，这里保持纯返回
  return r;
}

module.exports = { activate, edrLock, EDR_LOCK_FILE };
