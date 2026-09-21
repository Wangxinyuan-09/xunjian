// 终端安全 EDR(27443) — 超级管理员手动登录一次，存 hs_admin_session.json
// 供 collect_hs 补 病毒库/漏洞库版本(/file/upgrade/info, 普通 manger 会话 403)
// 用法: node hs_admin_pick.js   在弹出的浏览器用【超管账号】登录，进主界面后自动存会话
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
  const preUser = (cfg.devices.hs.adminUser) || '';
  const prePass = (cfg.devices.hs.adminPass) || '';
  if (preUser) await page.locator('input[name=username]').fill(preUser).catch(() => {});
  if (prePass) await page.locator('input[name=password]').fill(prePass).catch(() => {});
  console.log('==================================================');
  console.log('  请用【超级管理员】账号登录 终端安全 EDR (' + host + ')');
  console.log('  当前 hs_session.json 账号是 manger(普通管理员)，拿不到病毒库/漏洞库版本');
  console.log(preUser ? '  已预填: ' + preUser : '  请在页面输入超管账号密码 + 验证码');
  console.log('==================================================');

  let loggedIn = false;
  for (let i = 0; i < 360; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({ url: location.href })).catch(() => null);
    if (st && i > 3 && !/login/i.test(st.url)) { loggedIn = true; break; }
    if (i % 30 === 0 && st) console.log('  [等待] ' + i + 's url=' + st.url);
  }
  if (!loggedIn) { console.log('登录超时(6分钟) 或未检测到登录成功'); await browser.close(); process.exit(1); }
  console.log('✅ 已登录, URL:', page.url());
  await page.waitForTimeout(4000);
  const s = await lib.saveSession(page, ctx, path.join(__dirname, 'hs_admin_session.json'));
  console.log('✅ 已保存 hs_admin_session.json (localStorage ' + s.lsCount + ' 项, cookies ' + s.cookieCount + ' 个)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
