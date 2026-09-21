// AiDSC(6543) — 手动登录一次，保存会话供一键巡检免验证码复用
// 用法: node aidsc_pick.js   启动后请在弹出的浏览器中手动登录
// 登录进主界面后自动把 cookies 存为 aidsc_session.json
const { chromium } = require('playwright-core');
const path = require('path');
const cfg = require('./xunjian_config');
const lib = require('./xunjian_lib');

(async () => {
  const dcfg = cfg.devices.aidsc;
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
  console.log('  请在弹出的浏览器中【手动登录】AiDSC (6543)');
  console.log('  账号 admin  密码 ' + dcfg.pass + '  再手输验证码');
  console.log('==================================================');

  let loggedIn = false;
  for (let i = 0; i < 360; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => {
      const url = location.href;
      const body = (document.body.innerText || '').replace(/\s+/g, ' ');
      // 登录成功判定（放宽）：验证码输入框消失 且 页面不再是登录欢迎语
      const captchaGone = !document.getElementById('form_item_captcha');
      const noWelcome = !/欢迎登录|请输入验证码/.test(body);
      const urlOut = !/\/login/i.test(url);
      return { captchaGone, noWelcome, urlOut, url, body: body.slice(0, 60) };
    }).catch(() => null);
    if (st) {
      if (i > 2 && st.captchaGone && st.noWelcome) { loggedIn = true; break; }
      if (i % 30 === 0) console.log('  [等待] ' + i + 's url=' + st.url + ' 文本=' + st.body);
    }
  }
  if (!loggedIn) { console.log('登录超时(4分钟) 或未检测到登录成功'); await browser.close(); process.exit(1); }
  console.log('✅ 已登录, URL:', page.url());
  await page.waitForTimeout(3000);

  const s = await lib.saveSession(page, ctx, path.join(__dirname, 'aidsc_session.json'));
  console.log('✅ 已保存会话 aidsc_session.json (localStorage ' + s.lsCount + ' 项, cookies ' + s.cookieCount + ' 个)');
  await page.waitForTimeout(1500);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
