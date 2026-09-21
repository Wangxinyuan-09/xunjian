// EDR 终端安全(27443) — 用 admin 超管登录后，在「用户认证/用户管理」里点 manger 行的「操作项→登录」
// 实现「超管身份跳转登录到 manger」：切换成功后 app 会换上 manger 权限的 Authorization。
// 这个脚本把切换后的会话另存为 hs_manger_session.json，供 collect_hs 取 授权/防护日志/客户端版本。
// 用法: node hs_manger_pick.js
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
    args: ['--ignore-certificate-errors', '--window-size=1440,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  // 1) 先复用已保存的 admin 会话（若失效则需重新 admin 登录）
  const adminFile = path.join(__dirname, 'hs_session.json');
  const restored = await lib.restoreSession(page, ctx, adminFile);
  console.log('复用的 admin 会话文件:', adminFile, restored ? '(已恢复)' : '(无/无法解析)');
  await page.goto(host + '/#/user_permission/user_manage', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (/login/i.test(page.url())) {
    console.log('当前是登录页(admin 会话已过期)，请先在浏览器里手工登录 admin 一次，登录后会自动进入用户管理页');
  }
  console.log('==================================================');
  console.log('  请在弹出的浏览器里：');
  console.log('  1) 找到表格中「manger」那一行 → 操作项 → 点「登录」');
  console.log('  2) 页面会跳转成 manger 身份（URL 可能进入 manager 前端或回到首页 dashboard）');
  console.log('  3) 切好后脚本会自动检测并从请求里捕获 manger 的 Authorization，保存 hs_manger_session.json');
  console.log('==================================================');

  // 2) 监听请求，捕获「切换后」出现的新 Authorization（与原始 admin token 不同则视为 manger token）
  let adminAuth = '';
  let mangerAuth = '';
  const capture = (req) => {
    const h = req.headers()['authorization'] || '';
    if (!h) return;
    if (mangerAuth) return; // 已捕获 manger
    if (!adminAuth) { adminAuth = h; return; } // 第一个是初始 admin
    if (h !== adminAuth) mangerAuth = h;       // 与初始不同 → 是切换后的 manger
  };
  page.on('request', capture);

  let switched = false;
  let urlAtSwitch = '';
  for (let i = 0; i < 420; i++) {
    await page.waitForTimeout(1000);
    if (mangerAuth && !switched) {
      switched = true; urlAtSwitch = page.url();
      console.log('✅ 捕获到切换后的 Authorization（manger）: ' + mangerAuth.slice(0, 40) + '...');
      console.log('   当前URL: ' + urlAtSwitch);
      break;
    }
    if (i % 30 === 0) console.log('  [等待] ' + i + 's url=' + page.url() + (adminAuth ? ' (已取到admin token)' : ''));
  }
  if (!switched) {
    console.log('切换未在7分钟内发生：请确认已点 manger 行的「登录」。');
    // 兜底：即使没切，若 URL 已离开用户管理页，也把当前会话存下来供手动验证
    console.log('保存当前会话作为候选 hs_manger_session.json 供分析...');
  }

  // 3) 保存切换后的会话（含 manger 的 localStorage token）
  await page.waitForTimeout(4000);
  const s = await lib.saveSession(page, ctx, path.join(__dirname, 'hs_manger_session.json'));
  console.log(`✅ 已保存 hs_manger_session.json (localStorage ${s.lsCount} 项, cookies ${s.cookieCount} 个)`);
  if (!switched) {
    console.log('⚠️ 未捕获到 независимый manger token，请到用户管理页重新点「登录」，或检查是否已真的有权限。');
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
