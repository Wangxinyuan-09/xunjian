// APT攻击预警平台 — 手动登录一次，保存会话供一键巡检免验证码复用
// 用法: node apt_pick.js <实例id>      # 16=LC1(6943)  17=LC2(4743)
const { chromium } = require('playwright-core');
const path = require('path');
const cfg = require('./xunjian_config');
const lib = require('./xunjian_lib');

async function main() {
  const id = process.argv[2];
  const dcfg = (cfg.apt || []).find((d) => String(d.id) === String(id));
  if (!dcfg) { console.log('未找到 APT 实例 id=' + id + ' (可用: 16 / 17)'); process.exit(1); }
  const host = `https://${dcfg.host}:${dcfg.port}`;
  const sessionFile = path.join(__dirname, `apt_session_${dcfg.id}.json`);

  const browser = await chromium.launch({
    executablePath: cfg.browser.executablePath,
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1400,900'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('==================================================');
  console.log(`  请手动登录 ${dcfg.product} (${host})`);
  console.log('  账号 ' + dcfg.user + '  密码 ' + dcfg.pass + '  再手输验证码');
  console.log('==================================================');

  let done = false;
  for (let i = 0; i < 600; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => {
      const ls = {}; for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k); if (/token|auth|session/i.test(key)) ls[key] = true; }
      return { url: location.href, authKeys: Object.keys(ls) };
    }).catch(() => null);
    // 真判据：URL 必须已离开登录页（/#/login 或 /login），且出现鉴权键。
    // 登录页本身带 APT_THIRD_AUTH_LOGIN 键，仅凭键会误判，故一定要看 URL。
    const offLogin = !/(^|\/)(#\/)?login/i.test(st ? st.url : '');
    if (st && i > 2 && st.authKeys.length && offLogin) {
      done = true; console.log('✅ 已离开登录页, URL:', st.url, 'token键:', st.authKeys.join(',')); break;
    }
    if (i % 15 === 0 && st) console.log('  [等待] ' + i + 's url=' + st.url);
  }
  if (!done) { console.log('登录超时(10分钟) 或未离开登录页 → 未保存（避免坏会话）。请重开 login 窗口并完成登录'); await browser.close(); process.exit(1); }
  await page.waitForTimeout(4000); // 等前端跳转&token 写入完成
  const s = await lib.saveSession(page, ctx, sessionFile);
  console.log(`✅ 已保存会话 ${path.basename(sessionFile)} (localStorage ${s.lsCount} 项, cookies ${s.cookieCount} 个)`);
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
