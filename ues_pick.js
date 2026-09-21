// UES终端准入(53443) — 手动登录一次，保存会话供一键巡检免验证码复用
// 用法: node ues_pick.js   启动后请在弹出的浏览器中手动登录
// 登录进主界面(出现"安全概览")后自动保存为 ues_session.json
const { chromium } = require('playwright-core');
const path = require('path');
const cfg = require('./xunjian_config');
const lib = require('./xunjian_lib');

(async () => {
  const dcfg = cfg.devices.ues;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('==================================================');
  console.log('  请在弹出的浏览器中【手动登录】UES终端准入 (53443)');
  console.log('  账号 ' + dcfg.user + '  密码 ' + dcfg.pass + '  再手输验证码');
  console.log('==================================================');

  let loggedIn = false;
  for (let i = 0; i < 600; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => {
      const body = (document.body.innerText || '');
      const url = location.href;
      const overview = body.includes('安全概览');
      const welcome = body.includes('欢迎登录');
      const urlOut = !/login/i.test(url);
      return { url, ok: overview || (urlOut && !welcome), body: body.slice(0, 60) };
    }).catch(() => null);
    if (st) {
      if (i > 3 && st.ok) { loggedIn = true; break; }
      if (i % 30 === 0) console.log('  [等待] ' + i + 's url=' + st.url + ' 文本=' + st.body);
    }
  }
  if (!loggedIn) { console.log('登录超时(10分钟) 或未检测到登录成功'); await browser.close(); process.exit(1); }
  console.log('✅ 已登录, URL:', page.url());
  await page.waitForTimeout(3000);

  const s = await lib.saveSession(page, ctx, path.join(__dirname, 'ues_session.json'));
  console.log('✅ 已保存会话 ues_session.json (localStorage ' + s.lsCount + ' 项, cookies ' + s.cookieCount + ' 个)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
