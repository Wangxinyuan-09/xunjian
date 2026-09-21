// 安恒云控制台(9443) — 手动登录一次，把控制台 cookies 存回 anheng_cloud_cookies.json
// 供 anheng_cloud_agent 重扫实例 + 获取实例授权/维保。账号通常是 superadmin。
// 用法: node anheng_pick.js   在弹出的浏览器登录控制台，出现 consoleToken 后自动保存
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const cfg = require('./xunjian_config');

const CONSOLE = cfg.anhengCloud.console;
const COOKIE_FILE = path.join(__dirname, 'anheng_cloud_cookies.json');

(async () => {
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(CONSOLE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('==================================================');
  console.log('  请在浏览器登录【安恒云控制台】 ' + CONSOLE);
  console.log('  账号 superadmin，登录进控制台后自动保存 cookies');
  console.log('==================================================');

  let saved = false;
  for (let i = 0; i < 360; i++) {
    await page.waitForTimeout(1000);
    let tok = '';
    try { tok = await page.evaluate(() => document.cookie.match(/consoleToken=([^;]+)/)?.[0] || ''); } catch (e) {}
    const cks = await ctx.cookies().catch(() => []);
    const hasToken = cks.some((c) => c.name === 'consoleToken' && c.value);
    if (hasToken) {
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cks, null, 2), 'utf8');
      console.log('✅ 已保存控制台 cookies (' + cks.length + ' 个) → anheng_cloud_cookies.json');
      saved = true;
      break;
    }
    if (i % 30 === 0) console.log('  [等待] ' + i + 's url=' + page.url() + (tok ? ' token=' + tok.slice(0, 20) : ''));
  }
  if (!saved) console.log('超时(6分钟)未捕获 consoleToken，请重试');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
