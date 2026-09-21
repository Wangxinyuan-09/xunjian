// 态势感知(22443) — 手动登录后抓"健康检查巡检"资源接口
// 直接导航到用户提供的路由 /#/micro-patrol/patrol/inspection/main
// 用法: node alpha_pick.js  启动后请手动登录
const { chromium } = require('playwright-core');
const cfg = require('./xunjian_config');

const TARGET = `https://${cfg.devices.alpha.host}:${cfg.devices.alpha.port}/#/micro-patrol/patrol/inspection/main`;

(async () => {
  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const reqs = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\.(png|jpg|jpeg|gif|svg|woff|ttf|css|js)/.test(u)) return;
    if (/(bigdata|patrol|micro|monitor|api|inspection|health)/i.test(u)) reqs.push({ m: r.method(), u: u.slice(0, 220) });
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (!/(bigdata|patrol|micro|monitor|inspection)/i.test(u)) return;
    try {
      const t = await r.text();
      if (/(hostinfo|cpu|memory|disk|health|巡检|节点|cpuUtil)/i.test(t)) {
        const k = u.split('?')[0];
        if (!reqs.find((x) => x.u === k)) reqs.push({ m: 'RESP', u: k, len: t.length, sample: t.slice(0, 300) });
      }
    } catch (e) {}
  });

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('==================================================');
  console.log('  请在弹出的浏览器中【手动登录】态势感知 (22443)');
  console.log('  登录后会自动回到健康检查巡检页面');
  console.log('==================================================');

  let loggedIn = false;
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(1000);
    const u = page.url();
    if (!/login/.test(u) && i > 2) { loggedIn = true; break; }
  }
  if (!loggedIn) { console.log('登录超时(5分钟)'); await browser.close(); process.exit(1); }
  console.log('✅ 检测到已登录:', page.url());
  await page.waitForTimeout(8000);

  // 若未停在目标页，重新导航
  if (!page.url().includes('/micro-patrol/')) {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(8000);
  }

  const body = await page.evaluate(() => document.body.innerText.split('\n').filter((t) => t.trim()).slice(0, 45));
  console.log('\n===== 健康检查巡检 页面内容 =====');
  console.log(JSON.stringify(body));
  console.log('\n===== 捕获的资源接口 =====');
  reqs.forEach((r) => console.log(r.m, r.u, r.len ? ('[' + r.len + 'B]') : ''));
  console.log('\nURL:', page.url());

  // 保留浏览器 60 秒供进一步操作
  await page.waitForTimeout(60000);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
