// 一键巡检 — 设备配置（结构定义，可入库）
//
// 【这里不放真实地址和凭据】两个来源，优先级从高到低：
//   1. 环境变量（临时覆盖 / CI 用）：XUNJIAN_<设备名>_<字段名>，如 XUNJIAN_APIG_PASS
//   2. 同目录 `xunjian_config.local.js`（已 .gitignore，不入库）—— 推荐，见 .example 模板
// 两者都没有时用占位值。占位值是明显假的(example.com)，采集会直接连不上并报错，
// 不会静默连到别人的设备上。
//
// 需要覆盖的字段：host / port / user / pass / adminUser / adminPass，
// 以及各产品特有的部署项（alpha.nodeIp、ues.bastionAsset 等）。
const path = require('path');

let local = {};
try {
  local = require('./xunjian_config.local');
} catch (e) {
  // 没有本地配置：用占位值跑，采集时报错提示补配置
}

// 敏感字段允许用环境变量覆盖（同名环境变量优先于 local 文件）
const SECRET_KEYS = ['host', 'user', 'pass', 'adminUser', 'adminPass'];
function dev(name, base) {
  const out = Object.assign({}, base, local[name] || {});
  for (const k of SECRET_KEYS) {
    const e = process.env['XUNJIAN_' + name.toUpperCase() + '_' + k.toUpperCase()];
    if (e !== undefined) out[k] = e;
  }
  return out;
}

function aptDev(spec) {
  const l = (local.apt || {})[spec.id] || {};
  const out = Object.assign({}, spec, l);
  for (const k of SECRET_KEYS) {
    const e = process.env['XUNJIAN_APT' + spec.id + '_' + k.toUpperCase()];
    if (e !== undefined) out[k] = e;
  }
  return out;
}

module.exports = {
  root: __dirname,
  browser: {
    // 用本机 Chrome；也可设 XUNJIAN_CHROME 指向别的 Chromium
    executablePath: process.env.XUNJIAN_CHROME
      || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--ignore-certificate-errors', '--disable-gpu', '--no-sandbox'],
  },
  reportFile: 'xunjian_report.json',
  writeApp: false,          // 需 --write-app 才写 app.js
  appendNewProducts: true,  // 安恒云有历史实例是否追加为 app.js 新行
  ocrScripts: {
    ddd: path.join(__dirname, 'cap_ocr_dddd.py'),
    bastion: path.join(__dirname, 'bastion_ocr_big.py'),
    ls: path.join(__dirname, 'ocr_ls.py'),
    enhanced: path.join(__dirname, 'cap_ocr_enhanced.py'),
  },
  devices: {
    apig: dev('apig', {
      id: 5, product: 'API网关', host: 'apig.example.com', port: 37443,
      user: 'admin', pass: '', ocr: null, enabled: true,
    }),
    aidsc: dev('aidsc', {
      id: 8, product: '数据安全管控平台', host: 'aidsc.example.com', port: 6543,
      user: 'admin', pass: '', ocr: null, enabled: true,
    }),
    alpha: dev('alpha', {
      id: 7, product: '态势感知', host: 'alpha.example.com', port: 22443,
      user: 'admin', pass: '', ocr: 'bastion', enabled: true,
      cascadeOrgId: '',        // 级联组织 ID，各部署不同
      nodeIp: '',
    }),
    lousao: dev('lousao', {
      id: 6, product: '漏扫', host: 'lousao.example.com', port: 8891,
      user: 'admin', pass: '', ocr: 'ls', enabled: true,
    }),
    hs: dev('hs', {
      id: null, product: '终端安全', host: 'edr.example.com', port: 27443,
      user: 'manger', pass: '', ocr: 'ddd', enabled: true,
      maxAttempts: 6,
      // 超管账号，只有取病毒库/漏洞库版本时用。
      // ⚠️ EDR 连续登录失败会锁生产账号，且策略很敏感 —— 不要提高重试次数。
      adminUser: 'admin', adminPass: '',
    }),
    ues: dev('ues', {
      id: null, product: 'UES终端准入', host: 'ues.example.com', port: 53443,
      user: 'secadm', pass: '', ocr: 'ddd', enabled: true,
      bastionAsset: { assetId: 0, accountId: 0 },
    }),
    bastion: dev('bastion', {
      host: 'bastion.example.com', port: 7443,
      user: 'admin', pass: '', ocr: 'bastion', enabled: false, // 订单管理平台默认不采
      // 在堡垒机资产列表里认出"订单平台"的规则（名称含"订单" 且 IP 命中该正则）
      orderAssetHint: { nameRe: '订单', ipRe: /^10\.0\.0\./ },
    }),
    anheng: {
      file: path.join(__dirname, 'anheng_collected.json'),
      staleHours: 26,
    },
    ltbastion: dev('ltbastion', { // LT堡垒机(明御运维审计) — collect_ltbastion.js；需先 ltb_pick.js 手动登录一次
      id: 18, product: 'LT堡垒机', host: 'ltbastion.example.com', port: 7443,
      user: 'admin', pass: '', ocr: 'bastion', enabled: true,
    }),
    dasv: dev('dasv', { // DasV大屏(数字孪生可视化，无验证码自动登录)
      id: 19, product: 'DasV大屏', host: 'dasv.example.com', port: 19480,
      user: 'admin', pass: '', ocr: null, enabled: true,
    }),
  },
  // 安恒云控制台（13 个专享实例走它的 SSO 借道）
  // 凭据优先用 ANHENG_CLOUD_USER/PASSWORD 环境变量（沿用既有习惯），
  // 没有时回落到 xunjian_config.local.js 的 anhengCloud 段。
  anhengCloud: Object.assign(
    {
      console: 'https://console.example.com:9443/console',
      user: '',
      pass: '',
    },
    local.anhengCloud || {},
    {
      user: process.env.ANHENG_CLOUD_USER || (local.anhengCloud || {}).user || '',
      pass: process.env.ANHENG_CLOUD_PASSWORD || (local.anhengCloud || {}).pass || '',
    }
  ),
  apt: [
    // captchaLen: 5 —— 实测 APT 验证码是【5 位】(如 3mdmx)。旧代码统一按 4 位过滤，
    // 会把四个引擎都读对的正确答案整个滤掉，只留下错候选 → 表象是"验证码识别不准"，
    // 实际是过滤器扔了正解。
    aptDev({ id: 16, product: 'APT攻击预警-LC1', host: 'apt1.example.com', port: 6943, user: 'admin', pass: '', ocr: 'ddd', enabled: true, captchaLen: 5 }),
    aptDev({ id: 17, product: 'APT攻击预警-LC2', host: 'apt2.example.com', port: 4743, user: 'admin', pass: '', ocr: 'ddd', enabled: true, captchaLen: 5 }),
  ],
  orderProduct: { id: 2, product: '订单管理平台' }, // 堡垒机采集目标
};
