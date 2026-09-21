// 本地私有配置模板 —— 复制成 `xunjian_config.local.js` 后填入真实值。
//
//   cp xunjian_config.local.example.js xunjian_config.local.js
//
// `xunjian_config.local.js` 已被 .gitignore 排除，**不要提交**。
// 这里只需要写"与默认值不同"的字段；没写的沿用 xunjian_config.js 的占位值。
module.exports = {
  apig:      { host: '10.0.0.11', port: 37443, user: 'admin',  pass: '<口令>' },
  aidsc:     { host: '10.0.0.12', port: 6543,  user: 'admin',  pass: '<口令>' },
  alpha:     { host: '10.0.0.13', port: 22443, user: 'admin',  pass: '<口令>',
               cascadeOrgId: '<级联组织ID>', nodeIp: '10.0.0.13' },
  lousao:    { host: '10.0.0.14', port: 8891,  user: 'admin',  pass: '<口令>' },
  hs:        { host: '10.0.0.15', port: 27443, user: 'manger', pass: '<普通账号口令>',
               adminUser: 'admin', adminPass: '<超管口令>' },
  ues:       { host: '10.0.0.16', port: 53443, user: 'secadm', pass: '<口令>',
               bastionAsset: { assetId: 0, accountId: 0 } },
  bastion:   { host: '10.0.0.17', port: 7443,  user: 'admin',  pass: '<口令>',
               orderAssetHint: { nameRe: '订单', ipRe: /^10\.0\.0\./ } },
  ltbastion: { host: '10.0.0.17', port: 7443,  user: 'admin',  pass: '<口令>' },
  dasv:      { host: '10.0.0.18', port: 19480, user: 'admin',  pass: '<口令>' },

  // 安恒云控制台（专享实例走它的 SSO 借道）
  anhengCloud: { console: 'https://console.example.com:9443/console',
                 user: '<控制台账号>', pass: '<控制台口令>' },

  // APT 攻击预警平台，按 id 索引
  apt: {
    16: { host: '10.0.0.21', port: 6943, user: 'admin', pass: '<口令>' },
    17: { host: '10.0.0.21', port: 4743, user: 'admin', pass: '<口令>' },
  },
};
