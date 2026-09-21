// 漏扫(8891) — 手动登录后滚动到页面底部，抓取资源利用率 + 捕获接口
// 用法: node lousao_pick.js  启动后请手动登录
const { chromium } = require('playwright-core');
const fs = require('fs');
const cfg = require('./xunjian_config');

(async () => {
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // 捕获 /ras/ 接口
  const rasApis = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (!/\/ras\//.test(u) || /\.(png|jpg|jpeg|gif|svg|woff|ttf|css|js)/.test(u)) return;
    try {
      const t = await r.text();
      const k = u.split('?')[0];
      const low = t.toLowerCase();
      if (low.includes('cpu') || low.includes('memory') || low.includes('disk') || low.includes('usage') || low.includes('rate')) {
        rasApis.push({ u: k, st: r.status(), len: t.length, sample: t.slice(0, 200) });
      }
    } catch (e) {}
  });

  await page.goto(`https://${cfg.devices.lousao.host}:${cfg.devices.lousao.port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // 预填账号密码, 人工只需输验证码(与 hs_pick.js 一致)
  const dcfg = cfg.devices.lousao;
  await page.evaluate(({ user, pass }) => {
    const setNative = (el, val) => {
      if (!el) return;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    const u = inputs.find((i) => /(user|用户|账号)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[0];
    const p = inputs.find((i) => /(pass|pwd|密码)/i.test((i.placeholder || '') + (i.name || ''))) || inputs[1];
    setNative(u, user);
    setNative(p, pass);
  }, { user: dcfg.user, pass: dcfg.pass }).catch(() => {});

  console.log('==================================================');
  console.log('  请在弹出的浏览器中登录漏扫 (8891)');
  console.log('  账号密码已预填，你只需输入验证码');
  console.log('  登录进入主界面后，我自动滚动到底部抓资源利用率');
  console.log('==================================================');

  // 关键: 登录页冷启动时 localStorage 里可能已经有 CUT_token(占位值),
  // 所以"存在 token"不能当登录成功判据 —— 必须要求 token 变成登录后【新签发】的那个
  // (2026-09-10 LT堡垒机踩过同一个坑: 占位 token 导致假成功)
  const preTok = await page.evaluate(() => localStorage.getItem('CUT_token')).catch(() => null);
  let loggedIn = false;
  for (let i = 0; i < 600; i++) {
    await page.waitForTimeout(1000);
    const tok = await page.evaluate(() => localStorage.getItem('CUT_token')).catch(() => null);
    if (tok && tok !== preTok) { loggedIn = true; break; }
  }
  if (!loggedIn) { console.log('登录超时(10分钟) 或未检测到新签发的 CUT_token'); await browser.close(); process.exit(1); }
  console.log('✅ 检测到已登录 (CUT_token)，URL:', page.url());
  await page.waitForTimeout(5000);

  // 保存会话（供一键巡检免验证码复用）
  const lib = require('./xunjian_lib');
  const s = await lib.saveSession(page, ctx, require('path').join(__dirname, 'lousao_session.json'));
  console.log('✅ 已保存会话 lousao_session.json (localStorage ' + s.lsCount + ' 项, cookies ' + s.cookieCount + ' 个)');

  // 滚动到底部（多次，触发懒加载）
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 800));
    }
  });
  await page.waitForTimeout(3000);

  // 抓页面底部文本（找资源利用率）
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n').filter((t) => t.trim());
  console.log('\n===== 页面末尾 40 行 =====');
  console.log(JSON.stringify(lines.slice(-40), null, 0));
  fs.writeFileSync('lousao_body.txt', lines.join('\n'), 'utf8');
  console.log('\n已保存 lousao_body.txt (' + lines.length + ' 行)');

  // 资源相关行
  const res = lines.filter((l) => /(CPU|内存|磁盘|利用率|使用率|usage|%|占用)/i.test(l) && /[0-9]/i.test(l));
  console.log('\n===== 资源相关行 =====');
  console.log(JSON.stringify(res.slice(0, 30), null, 0));

  console.log('\n===== 含 cpu/memory/disk 的接口 =====');
  rasApis.forEach((a) => console.log(a.st, a.u, '[' + a.len + 'B]', a.sample.replace(/\n/g, '').slice(0, 120)));

  await page.waitForTimeout(20000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
