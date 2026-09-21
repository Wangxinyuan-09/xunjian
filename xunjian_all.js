#!/usr/bin/env node
// 一键巡检 — 主入口
// 用法: node xunjian_all.js [--write-app] [--dry-run] [--no-browser] [--no-cloud]
//   --write-app   采集后把结果写回 app.js 的 inspectionData
//   --dry-run     只生成报告，不写 app.js
//   --no-browser  跳过所有需要浏览器的设备（只做安恒云映射）
//   --no-cloud    跳过安恒云 13 个专享实例的实时采集（复用现有 anheng_collected.json）
//
// 【安恒云为什么在巡检里采】用户 2026-09-21 明确: 每次巡检要的是实时数据, 不能用之前存下来的。
// 所以 13 个专享实例在这里逐个走控制台 SSO 采一遍, 而不是读一份离线快照。
// 代价是整轮会多几分钟(13 个实例 × 开配置页+取数); 采挂了不影响其他设备, 只标失败。
const cfg = require('./xunjian_config');
const lib = require('./xunjian_lib');

const DEVICE_ORDER = ['apig', 'aidsc', 'alpha', 'lousao', 'hs', 'ues', 'dasv', 'ltbastion'];

// 与 session_keepalive.js 互斥: 两边同时开 Chromium 会互相把对方浏览器搞崩
// (2026-09-10 实测保活整轮探测报 "browser has been closed")。
// 本脚本运行时置 sweep.running, 保活看到就跳过本轮; 若保活正在跑, 先等它结束(最多2分钟)。
const fs = require('fs');
const path = require('path');
const SWEEP_FLAG = path.join(__dirname, 'sweep.running');
const KA_LOCK = path.join(__dirname, 'keepalive.lock');

async function waitKeepaliveIdle(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    let busy = false;
    try { busy = Date.now() - fs.statSync(KA_LOCK).mtimeMs < 8 * 60 * 1000; } catch (e) { busy = false; }
    if (!busy) return true;
    if (Date.now() - t0 === 0) lib.log('会话保活正在运行, 等它结束再开始巡检(最多2分钟)...');
    await new Promise((r) => setTimeout(r, 10000));
  }
  lib.log('⚠️ 保活仍在运行, 巡检继续(可能互相影响, 结果以本次为准)');
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const writeApp = argv.includes('--write-app');
  const dryRun = argv.includes('--dry-run');
  const noBrowser = argv.includes('--no-browser');
  const noCloud = argv.includes('--no-cloud');
  cfg.writeApp = writeApp;

  lib.log('===== 一键巡检开始 =====');
  const collected = []; // {name, result}
  let browser = null;

  await waitKeepaliveIdle(120000);
  try { fs.writeFileSync(SWEEP_FLAG, String(Date.now()), 'utf8'); } catch (e) {}

  try {
    if (!noBrowser) {
      browser = await lib.launchBrowser(cfg);
      for (const name of DEVICE_ORDER) {
        const dcfg = cfg.devices[name];
        if (!dcfg.enabled) continue;
        let result;
        try {
          const mod = require('./xunjian_devices/collect_' + name);
          const ctx = await lib.newContext(browser);
          try {
            result = await lib.withTimeout(mod.collect(ctx, dcfg, cfg), 200000, name);
          } finally {
            await ctx.close();
          }
        } catch (e) {
          result = Object.assign(lib.emptyResult(dcfg.id, dcfg.product), { error: String(e.message || e).slice(0, 300) });
        }
        collected.push({ name, result });
        const ok = result && result.ok;
        lib.log(`${dcfg.product}(${name}): ${ok ? '✅ OK' : '❌ ' + (result.error || 'FAIL')}`);
        if (ok && result.cpuSeries) {
          const avg = (a) => a ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
          lib.log(`   CPU ${avg(result.cpuSeries)}%  MEM ${avg(result.memSeries)}%  DISK ${avg(result.diskSeries)}%`);
        }
        if (ok && result.metrics) {
          for (const [mk, mv] of Object.entries(result.metrics)) lib.log(`   ${mk}: ${mv}`);
        }
      }

      // APT 平台（多实例）
      if (cfg.apt && cfg.apt.length) {
        for (const dcfg of cfg.apt) {
          if (!dcfg.enabled) continue;
          let result;
          try {
            const mod = require('./xunjian_devices/collect_apt');
            const ctx = await lib.newContext(browser);
            try {
              result = await lib.withTimeout(mod.collect(ctx, dcfg, cfg), 120000, dcfg.product);
            } finally {
              await ctx.close();
            }
          } catch (e) {
            result = Object.assign(lib.emptyResult(dcfg.id, dcfg.product), { error: String(e.message || e).slice(0, 300) });
          }
          collected.push({ name: 'apt_' + dcfg.id, result });
          lib.log(`${dcfg.product}: ${result.ok ? '✅ OK' : '❌ ' + (result.error || 'FAIL')}`);
        }
      }
    }

    // 安恒云 13 个专享实例 —— 每次都重采, 保证表里是实时数据
    if (!noBrowser && !noCloud) {
      const t0 = Date.now();
      try {
        const mod = require('./anheng_cloud_collect');
        const cctx = await lib.newContext(browser);
        try {
          const r = await lib.withTimeout(mod.collect(cctx, {}), 900000, 'anheng_cloud');
          lib.log(`安恒云实时采集: ${r.ok}/${r.total} 成功, 用时 ${Math.round((Date.now() - t0) / 1000)}s`);
        } finally {
          await cctx.close().catch(() => {});
        }
      } catch (e) {
        // 采不到不影响其他设备: 现有 anheng_collected.json 会被逐实例标"数据超时建议重采"
        lib.log(`安恒云实时采集: ❌ ${String(e.message || e).slice(0, 200)}`);
      }
    } else if (noCloud) {
      lib.log('--no-cloud: 跳过安恒云实时采集, 复用现有 anheng_collected.json');
    }

    // 堡垒机 → 订单平台(id2) + UES 资源
    if (cfg.devices.bastion.enabled && !noBrowser) {
      try {
        const mod = require('./xunjian_devices/collect_bastion');
        const ctx = await lib.newContext(browser);
        try {
          const r = await lib.withTimeout(mod.collect(ctx, cfg, cfg.devices.bastion), 180000, 'bastion');
          collected.push({ name: 'bastion', result: r.order || Object.assign(lib.emptyResult(cfg.orderProduct.id, cfg.orderProduct.product), { error: r.error || 'FAIL' }) });
          lib.log(`订单管理平台(bastion): ${(r.order && r.order.ok) ? '✅ OK' : '❌ ' + ((r.order && r.order.error) || r.error || 'FAIL')}`);
        } finally {
          await ctx.close();
        }
      } catch (e) {
        collected.push({ name: 'bastion', result: Object.assign(lib.emptyResult(cfg.orderProduct.id, cfg.orderProduct.product), { error: String(e.message || e).slice(0, 300) }) });
        lib.log(`订单管理平台(bastion): ❌ ${e.message}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { fs.unlinkSync(SWEEP_FLAG); } catch (e) {}
  }

  // 安恒云映射（纯文件读取）
  const anhengRows = [];
  try {
    const mod = require('./xunjian_devices/collect_anheng');
    const rows = await mod.collect(cfg.devices.anheng, cfg);
    anhengRows.push(...rows);
    lib.log(`安恒云专享实例: 映射 ${rows.length} 个有历史实例`);
  } catch (e) {
    lib.log(`安恒云映射: ❌ ${e.message}`);
  }

  // 生成报告
  const report = require('./xunjian_report');
  const out = await report.build({ cfg, collected, anhengRows, argv });

  // 写 app.js（可选）
  if (writeApp && !dryRun) {
    const ok = await report.writeApp(cfg, out);
    lib.log(ok ? '✅ app.js 已更新' : '❌ app.js 更新失败（未改动）');
  } else if (dryRun) {
    lib.log('--dry-run：未写 app.js');
  } else {
    lib.log('未写 app.js（用 --write-app 开启）');
  }

  lib.log('===== 一键巡检结束 =====');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
