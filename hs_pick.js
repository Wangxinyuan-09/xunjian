// 终端安全(27443) — 手动登录一次，保存会话供一键巡检免验证码复用
// 用法: node hs_pick.js   启动后请在弹出的浏览器中手动登录
// 登录进主界面(URL离开 #/login)后自动保存为 hs_session.json
const { chromium } = require('playwright-core');
const path = require('path');
const cfg = require('./xunjian_config');
const lib = require('./xunjian_lib');

(async () => {
  const dcfg = cfg.devices.hs;
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(host + '/#/login', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  console.log('==================================================');
  console.log('  请在弹出的浏览器中【手动登录】终端安全 (27443)');
  console.log('  账号 ' + dcfg.user + '  密码 ' + dcfg.pass + '  再手输验证码');
  console.log('==================================================');
  // 预填账号密码(该登录页有 readonly 诱饵密码框, 要填可见的 input[name=password]), 人工只需输验证码
  await page.locator('input[name=username]').fill(dcfg.user).catch(() => {});
  await page.locator('input[name=password]').fill(dcfg.pass).catch(() => {});

  let loggedIn = false;
  for (let i = 0; i < 360; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({ url: location.href })).catch(() => null);
    if (st) {
      // 登录成功 = URL 离开 #/login（SPA 跳主界面）
      if (i > 3 && !/login/i.test(st.url)) { loggedIn = true; break; }
      if (i % 30 === 0) console.log('  [等待] ' + i + 's url=' + st.url);
    }
  }
  if (!loggedIn) { console.log('登录超时(6分钟) 或未检测到登录成功'); await browser.close(); process.exit(1); }
  console.log('✅ 已登录, URL:', page.url());
  await page.waitForTimeout(3000);

  const s = await lib.saveSession(page, ctx, path.join(__dirname, 'hs_session.json'));
  console.log('✅ 已保存会话 hs_session.json (localStorage ' + s.lsCount + ' 项, cookies ' + s.cookieCount + ' 个)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
