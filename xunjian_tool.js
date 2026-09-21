#!/usr/bin/env node
// 一键巡检 — 手动执行工具（交互式菜单）
// 用法: node xunjian_tool.js   或双击 xunjian.bat
// 通过子进程调用 xunjian_all.js，实时显示进度
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ALL = path.join(__dirname, 'xunjian_all.js');

function run(args) {
  return new Promise((resolve) => {
    console.log('\n>>> 执行: node xunjian_all.js ' + args.join(' ') + '\n');
    const child = spawn(process.execPath, [ALL, ...args], { cwd: __dirname, stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
  });
}

function showReport() {
  const fs = require('fs');
  const p = path.join(__dirname, 'xunjian_report.json');
  if (!fs.existsSync(p)) { console.log('\n暂无报告，先运行一次巡检。'); return; }
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('\n===== 最近一次巡检报告 =====');
  console.log('采集时间: ' + r.collectedAt);
  console.log('设备汇总:');
  for (const s of r.summary) {
    const avg = (v) => (v == null ? '-' : v + '%');
    console.log(`  ${s.product || s.name}: ${s.ok ? '✅' : '❌'}  CPU ${avg(s.cpuAvg)}  MEM ${avg(s.memAvg)}  DISK ${avg(s.diskAvg)}${s.error ? '  [' + String(s.error).slice(0, 40) + ']' : ''}`);
  }
  console.log(`\n巡检系统产品数: ${r.master.length}`);
}

const MENU = `
=====================================
   安全设备一键巡检 — 手动执行工具
=====================================
  1) 完整巡检 + 更新 app.js   (约5-10分钟)
  2) 完整巡检（仅报告，不写 app.js）
  3) 快速刷新安恒云 + 更新 app.js  (约1秒)
  4) 查看最近一次巡检报告
  5) 恢复 app.js 为原始 8 产品
  6) 生成巡检结果表格 (Markdown+CSV)
  0) 退出
=====================================`;

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  let running = true;
  while (running) {
    console.log(MENU);
    const choice = (await ask('请选择 (0-5): ')).trim();
    switch (choice) {
      case '1': await run(['--write-app']); break;
      case '2': await run([]); break;
      case '3': await run(['--no-browser', '--write-app']); break;
      case '4': showReport(); break;
      case '5': require('./xunjian_rebuild.js'); break;
      case '6': require('./xunjian_table.js'); break;
      case '0':
      case 'q':
      case 'Q': running = false; break;
      default: console.log('无效选项，请重试');
    }
    if (running) await ask('\n按回车返回菜单...');
  }
  rl.close();
  console.log('已退出');
  process.exit(0);
}

main();
