// 会话更新记录 — 每次发生会话写入/登录/失效变化时自动追加一行
// 用途: 审计"会话何时被刷新/恢复/失效",避免靠人定期手动重登后无据可查
// 由 xunjian_lib.saveSession / session_keepalive.js 调用
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '会话更新记录.md');

const HEADER = `# 巡检会话更新记录

> 自动记录每次会话写入/登录/续期/失效事件。手动重登应成为罕见操作 —— 保活任务每 10 分钟自动续期。

| 时间 | 设备 | 事件 | 结果 | 说明 |
|------|------|------|------|------|
`;

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ensure() {
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, HEADER, 'utf8');
}

// 从会话文件名推断设备中文名(无映射则返回文件名)
function labelOf(file) {
  const b = path.basename(file || '').toLowerCase();
  if (b.includes('lousao')) return '漏扫';
  if (b.includes('ltb')) return 'LT堡垒机';
  if (b.includes('dasv')) return 'DasV大屏';
  if (b.includes('hs_admin')) return 'EDR-超管';
  if (b.includes('hs_session') || b.startsWith('hs_')) return 'EDR-终端安全';
  if (b.includes('ues')) return 'UES办公智盾';
  if (b.includes('aidsc')) return 'Aidsc';
  if (b.includes('apt')) return 'APT';
  if (b.includes('anheng')) return '安恒云';
  return path.basename(file || '');
}

// device: 中文名; event: 事件; ok: true/false; note: 补充
function append(device, event, ok, note) {
  try {
    ensure();
    const row = `| ${ts()} | ${device} | ${event} | ${ok ? '✅ 成功' : '❌ 失败'} | ${String(note || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |\n`;
    fs.appendFileSync(FILE, row, 'utf8');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

module.exports = { append, labelOf, FILE };
