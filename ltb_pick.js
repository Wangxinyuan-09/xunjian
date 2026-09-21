// LT堡垒机(7443, 安恒明御运维审计) — 手动登录一次存会话, 供保活与采集
// 与漏扫/UES 一致: 冷启动人输一次验证码, 之后 10 分钟保活自动续期
// 用法: node ltb_pick.js   在弹出的浏览器输验证码完成登录, 自动存 ltb_session.json
const { chromium } = require('playwright-core');
const path = require('path');
const cfg = require('./xunjian_config');
const lib = require('./xunjian_lib');

(async () => {
  const base = `https://${cfg.devices.ltbastion.host}:${cfg.devices.ltbastion.port}`;
  const host = base + '/index/#/';
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(host, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('==================================================');
  console.log('  请登录 LT堡垒机 (明御运维审计) ' + base);
  console.log('  已预填账号 admin，请输密码并手输验证码');
  console.log('==================================================');
  await page.locator('input').nth(0).fill('admin').catch(() => {});
  try {
    const pass = cfg.devices.ltbastion.pass || cfg.devices.bastion.pass;
    if (pass) await page.locator('input').nth(1).fill(pass).catch(() => {});
  } catch (e) {}

  let ok = false;
  for (let i = 0; i < 360; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({ url: location.href })).catch(() => null);
    if (st && i > 3 && !/(\/login|\/login\.html|欢迎登录)/i.test(st.url) && !/Login/.test(st.url)) { ok = true; break; }
    if (i % 30 === 0 && st) console.log('  [等待] ' + i + 's url=' + st.url);
  }
  if (!ok) { console.log('超时(6分钟)或未检测到登录成功'); await browser.close(); process.exit(1); }
  console.log('✅ 已登录, URL:', page.url());
  await page.waitForTimeout(4000);
  const s = await lib.saveSession(page, ctx, path.join(__dirname, 'ltb_session.json'));
  console.log('✅ 已保存 ltb_session.json (localStorage ' + s.lsCount + ' 项, cookies ' + s.cookieCount + ' 个)');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
