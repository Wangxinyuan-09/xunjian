#!/usr/bin/env node
// 巡检结果表格生成：读 app.js inspectionData（15产品）+ xunjian_report.json（采集状态）
// 输出 xunjian_report_table.md（Markdown）和 xunjian_report_table.csv（Excel，带 BOM）
const fs = require('fs');
const path = require('path');

// 产品 → 内网管理 IP / 授权到期：属于【部署数据】，不入库。
// 放进 xunjian_config.local.js 的 productIp / productExpiry 两段（见 .example 模板）。
// 没配置时这两张表是空的，报表对应列显示 —，不影响采集与其它列。
const _local = (() => { try { return require('./xunjian_config.local'); } catch (e) { return {}; } })();
const PRODUCT_IP = _local.productIp || {};
const PRODUCT_EXPIRY = _local.productExpiry || {};

// 从结果表剔除的产品（原人工占位设备）
const DROP_PRODUCTS = ['CRM系统', '订单管理平台', '支付网关', '会员系统'];

function avg(a) { return Array.isArray(a) && a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null; }

function main() {
  // 读取 app.js inspectionData
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const m = app.match(/const inspectionData = (\[[\s\S]*?\r?\n\];)/);
  if (!m) { console.error('app.js 解析失败'); process.exit(1); }
  let items = new Function('return ' + m[1] + ';')();
  // 剔除不再巡检的产品（人工占位设备不删 app.js 数据源，仅报表不显示）
  if (DROP_PRODUCTS.length) items = items.filter((it) => !DROP_PRODUCTS.includes(it.product));

  // 读取报告（采集状态）
  let report = null;
  const rp = path.join(__dirname, 'xunjian_report.json');
  if (fs.existsSync(rp)) {
    try { report = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) {}
  }
  const deviceByName = {};
  if (report) {
    for (const s of report.summary) {
      deviceByName[s.name] = s; // name = apig/aidsc/alpha/lousao/hs/ues/bastion
    }
  }

  // 运营指标区块(EDR/UES 等): 取 summary 中带 metrics 的项
  const metricDevices = [];
  if (report) {
    for (const s of report.summary) {
      if (s.metrics && Object.keys(s.metrics).length) metricDevices.push({ name: s.name, product: s.product, ok: s.ok, metrics: s.metrics });
    }
  }

  // APT 扩展指标(版本/策略库/告警/流量) —— 两个来源:
  //   1) summary: 本地独立部署的 LC1/LC2(collect_apt.js 的 r.aptMetrics)
  //   2) master : 安恒云上的 APT-36(anheng_cloud_collect.js 采完挂在实例行上) —— 需求3 要求云上 APT 也有
  const aptDevices = [];
  if (report) {
    for (const s of report.summary) {
      if (s.aptMetrics && Object.keys(s.aptMetrics).length) aptDevices.push({ name: s.name, product: s.product, ok: s.ok, m: s.aptMetrics });
    }
    const aptSeen = new Set(aptDevices.map((d) => d.product));
    for (const m of report.master || []) {
      if (!m.product || !m.aptMetrics || !Object.keys(m.aptMetrics).length) continue;
      if (aptSeen.has(m.product)) continue;
      aptDevices.push({ name: m.product, product: m.product, ok: true, m: m.aptMetrics });
      aptSeen.add(m.product);
    }
  }

  // ---- 版本号索引(需求: 所有产品都需要收集版本号) ----
  // 两个来源: master 行的 productVersion(安恒云实例 / LT堡垒机 / APT),
  //           以及 summary.metrics 里的版本项(hs/ues/dasv 只进 summary 不进 master)。
  const SUMMARY_PRODUCT = { hs: '终端安全', ues: 'UES终端准入', dasv: 'DasV大屏', ltbastion: 'LT堡垒机' };
  // 版本号必须含数字才能采信 —— 这条守卫在 anheng_collected 上已经救过一次
  // (上游把产品名当版本号填), 这里同样适用: DasV 的 metrics['平台类型/版本'] 实际值是
  // "DasV 部署:host 模式:dasv-license"(部署方式, 不含数字), 若直接取会当成版本号上报。
  const looksLikeVersion = (s) => !!s && /\d/.test(s);
  const versionOf = {};
  for (const m of (report && report.master) || []) {
    if (m.product && m.productVersion) versionOf[m.product] = m.productVersion;
  }
  for (const s of (report && report.summary) || []) {
    const pname = SUMMARY_PRODUCT[s.name];
    if (!pname || versionOf[pname]) continue;
    const mk = s.metrics || {};
    const v = mk['平台软件版本'] || mk['软件版本'] || mk['平台类型/版本'];
    if (looksLikeVersion(v)) versionOf[pname] = v;
  }

  // 采集状态映射：name → 状态说明
  const statusHint = {
    apig: 'web采集', aidsc: 'web采集', alpha: '实时快照', lousao: '实时快照',
    hs: '人工/堡垒机', ues: '人工/堡垒机', bastion: '堡垒机xterm',
  };
  const deviceStatus = {};
  for (const [name, s] of Object.entries(deviceByName)) {
    deviceStatus[name] = s.ok ? '✅ ' + (statusHint[name] || '采集') : '⚠️ ' + (s.error || '降级').slice(0, 40);
  }

  // 人工产品（无采集脚本）
  const manualIds = [1, 3, 4];
  // 安恒云实例（id>=9 且有 productCode 含义）标注来源
  const isAnheng = (id) => id >= 9;

  const rows = items.map((it) => {
    const id = it.id;
    const peak = (res) => it[res + 'PeakSeries'];
    // 特定采集器状态优先(LT id18/DasV id19 也 >=9，不能按安恒云标；以本次采集结果为准)
    const devStat = (name, label) => (deviceStatus[name] ? (deviceStatus[name].startsWith('✅') ? '✅ ' + label : deviceStatus[name]) : '✅ ' + label);
    let status = '人工录入';
    if (it.product === 'LT堡垒机') status = devStat('ltbastion', '堡垒机快照');
    else if (it.product === 'DasV大屏') status = devStat('dasv', 'web采集');
    else if (/^APT攻击预警-LC/.test(it.product)) status = deviceStatus['apt_' + id] ? ((deviceStatus['apt_' + id] || '').startsWith('✅') ? '✅ 实时快照' : deviceStatus['apt_' + id]) : '✅ 实时快照';
    else if (manualIds.includes(id)) status = '人工/保留';
    // 安恒云实例: 本次采挂了的要显出来, 不能一律写"安恒云采集"——那会让人以为数据是刚采的
    else if (isAnheng(id)) status = /本次采集失败|数据超时|采集失败/.test(it.remarks || '') ? '⚠️ 安恒云(采集失败/数据超时)' : '安恒云采集';
    else if (id === 5) status = deviceStatus.apig || 'web采集';
    else if (id === 6) status = deviceStatus.lousao || '实时快照';
    else if (id === 7) status = deviceStatus.alpha || '实时快照';
    else if (id === 8) status = deviceStatus.aidsc || 'web采集';
    else if (id === 2) status = deviceStatus.bastion || '堡垒机';
    // 备注优先用 notes: 安恒云实例的 remarks 以产品 URL 开头, 截 60 字会把"实时值/超时/采集失败"
    // 这些关键口径标记切掉。notes 是采集器写的一句话摘要, 正好装得下。
    const remark = (it.notes || it.remarks || '').replace(/\s+/g, ' ').slice(0, 60);
    // 版本号: master.productVersion 优先, 其次 master 自身的 productVersion(直接写回时),
    // 再回落 summary.metrics。都没有就 —（不编造）
    const ver = versionOf[it.product] || it.productVersion || '—';
    return {
      id, product: it.product, ip: PRODUCT_IP[it.product] || '—',
      exp: PRODUCT_EXPIRY[it.product] || '—',
      ver,
      collectionMode: it.collectionMode, hasWebChart: it.hasWebChart,
      cpu: avg(it.cpuSeries), mem: avg(it.memSeries), disk: avg(it.diskSeries),
      cpuPeak: avg(peak('cpu')), memPeak: avg(peak('mem')), diskPeak: avg(peak('disk')),
      status, remark,
    };
  });

  // 需求6: "终端安全、UES等IP加上, 每个产品的信息写一起不要分开"。
  // hs/ues 的 dcfg.id 是 null → 永远不进 app.js/master, 只出现在 summary 里,
  // 所以旧表【根本没有这两行】。这里在表尾补上, 让它们的 IP/版本/状态与其他产品同表。
  const inTable = new Set(rows.map((r) => r.product));
  for (const s of (report && report.summary) || []) {
    const pname = SUMMARY_PRODUCT[s.name];
    if (!pname || inTable.has(pname)) continue;
    rows.push({
      id: '—', product: pname, ip: PRODUCT_IP[pname] || '—',
      exp: PRODUCT_EXPIRY[pname] || '—',
      ver: versionOf[pname] || '—',
      collectionMode: s.name === 'ues' ? 'web' : '人工/堡垒机', hasWebChart: 'no',
      cpu: null, mem: null, disk: null, cpuPeak: null, memPeak: null, diskPeak: null,
      status: s.ok ? '✅ 采集' : '⚠️ ' + String(s.error || '降级').slice(0, 40),
      remark: (s.remarks || '').replace(/\s+/g, ' ').slice(0, 60),
    });
    inTable.add(pname);
  }

  const fmt = (v) => (v == null ? '—' : String(v));
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r|\n/g, ' ');

  // ---- Markdown ----
  const md = [];
  md.push('# 安全设备巡检结果表');
  md.push('');
  md.push(`> 生成时间: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  if (report) md.push(`> 采集时间: ${report.collectedAt}`);
  md.push('');
  md.push('| ID | 产品 | IP | 授权到期 | 版本 | CPU% | 内存% | 磁盘% | CPU峰值% | 内存峰值% | 磁盘峰值% | 方式 | 状态/备注 |');
  md.push('|----|------|----|---------|------|-----:|------:|------:|---------:|---------:|---------:|------|-----------|');
  for (const r of rows) {
    md.push(`| ${r.id} | ${esc(r.product)} | ${esc(r.ip)} | ${esc(r.exp)} | ${esc(r.ver)} | ${fmt(r.cpu)} | ${fmt(r.mem)} | ${fmt(r.disk)} | ${fmt(r.cpuPeak)} | ${fmt(r.memPeak)} | ${fmt(r.diskPeak)} | ${r.collectionMode} | ${esc(r.status)}${r.remark ? ' — ' + esc(r.remark) : ''} |`);
  }
  // 超阈值标注
  md.push('');
  // 报头必须跟下面的判定条件逐字一致: 内存阈值与 CPU/磁盘 不同(75 vs 80), 且并没有分档告警。
  // 旧报头写"内存/磁盘 ≥80% 提醒, ≥86% 告警" —— 与代码不符, 会让人以为 76.5% 是误报。
  md.push('## 告警关注（阈值：CPU/磁盘 ≥80%、内存 ≥75%）');
  md.push('');
  for (const r of rows) {
    const warns = [];
    if (r.cpu >= 80) warns.push(`CPU ${r.cpu}%`);
    if (r.mem >= 75) warns.push(`内存 ${r.mem}%`);
    if (r.disk >= 80) warns.push(`磁盘 ${r.disk}%`);
    if (warns.length) md.push(`- **${r.product}**（ID ${r.id}）: ${warns.join('，')}`);
  }

  // 运营指标区块(EDR/UES 等版本/授权/日志/终端)
  if (metricDevices.length) {
    md.push('');
    md.push('## 运营指标（版本 / 授权 / 日志 / 终端）');
    md.push('');
    for (const d of metricDevices) {
      md.push(`### ${d.product}${d.ok ? '' : '（采集失败）'}`);
      for (const [k, v] of Object.entries(d.metrics)) md.push(`- ${k}：${v}`);
      md.push('');
    }
  }

  // APT 扩展指标(需求3): 策略库版本 / 告警情况 / 流量情况
  if (aptDevices.length) {
    md.push('');
    md.push('## APT攻击预警平台（策略库 / 告警 / 流量）');
    md.push('');
    for (const d of aptDevices) {
      const m = d.m;
      md.push(`### ${d.product}${d.ok ? '' : '（采集失败）'}`);
      if (m.platformVersion) md.push(`- 平台版本：${m.platformVersion}`);
      md.push(`- 策略库版本：${m.strategyVersion || '—'}`);
      md.push(`- 本日告警数量：${m.alarmToday == null ? '—' : m.alarmToday}`);
      md.push(`- 最近一周告警数量：${m.alarmWeek == null ? '—' : m.alarmWeek}`);
      // 流量: 系统无历史流量接口, 只能跨轮次采样累积, 故标注口径与采样次数
      if (m.flowPeakBps != null) {
        md.push(`- 本日流量峰值：${m.flowPeakGbps.toFixed(3)}Gb/s（采样峰值，${m.flowPeakDate} 累计 ${m.flowSamples} 次采样取最大）`);
      } else {
        md.push('- 本日流量峰值：—');
      }
      if (m.versionCloudOk === false || m.strategyCloudOk === false) {
        md.push('- 备注：云端不可达（内网环境），本地版本/策略库仍有效');
      }
      md.push('');
    }
  }

  // 注: 不再单列「版本号汇总」—— 版本号已进主表「版本」列, 单列会重复同一份数据。
  fs.writeFileSync(path.join(__dirname, 'xunjian_report_table.md'), md.join('\n'), 'utf8');

  // ---- CSV ----
  const csv = [];
  csv.push(['ID', '产品', 'IP', '授权到期', '版本', 'CPU%', '内存%', '磁盘%', 'CPU峰值%', '内存峰值%', '磁盘峰值%', '采集方式', '状态/备注']);
  for (const r of rows) {
    csv.push([r.id, r.product, r.ip, r.exp, r.ver, fmt(r.cpu), fmt(r.mem), fmt(r.disk), fmt(r.cpuPeak), fmt(r.memPeak), fmt(r.diskPeak), r.collectionMode, (r.status + (r.remark ? ' — ' + r.remark : '')).replace(/,/g, '，')]);
  }
  // 超阈值附加行
  csv.push([]);
  csv.push(['告警关注（阈值：CPU/磁盘 ≥80%、内存 ≥75%）']);
  for (const r of rows) {
    const warns = [];
    if (r.cpu >= 80) warns.push('CPU ' + r.cpu + '%');
    if (r.mem >= 75) warns.push('内存 ' + r.mem + '%');
    if (r.disk >= 80) warns.push('磁盘 ' + r.disk + '%');
    if (warns.length) csv.push([r.id, r.product, warns.join('，')]);
  }
  // 运营指标区块
  if (metricDevices.length) {
    csv.push([]);
    csv.push(['运营指标（版本/授权/日志/终端）']);
    for (const d of metricDevices) {
      csv.push([d.product, d.ok ? '' : '采集失败']);
      for (const [k, v] of Object.entries(d.metrics)) csv.push(['  ' + k, v]);
    }
  }
  // APT 扩展指标(需求3)
  if (aptDevices.length) {
    csv.push([]);
    csv.push(['APT攻击预警平台（策略库/告警/流量）']);
    for (const d of aptDevices) {
      const m = d.m;
      csv.push([d.product, d.ok ? '' : '采集失败']);
      if (m.platformVersion) csv.push(['  平台版本', m.platformVersion]);
      csv.push(['  策略库版本', m.strategyVersion || '—']);
      csv.push(['  本日告警数量', m.alarmToday == null ? '—' : String(m.alarmToday)]);
      csv.push(['  最近一周告警数量', m.alarmWeek == null ? '—' : String(m.alarmWeek)]);
      csv.push(['  本日流量峰值', m.flowPeakBps == null ? '—'
        : m.flowPeakGbps.toFixed(3) + 'Gb/s(采样峰值, ' + m.flowPeakDate + ' 共' + m.flowSamples + '次采样)']);
    }
  }
  const csvText = '﻿' + csv.map((r) => r.join(',')).join('\r\n');
  const csvPath = path.join(__dirname, 'xunjian_report_table.csv');
  try {
    fs.writeFileSync(csvPath, csvText, 'utf8');
    console.log('✅ 已生成: ' + csvPath);
  } catch (e) {
    // 文件可能被 Excel 占用 → 写新文件
    const alt = path.join(__dirname, 'xunjian_report_table.new.csv');
    fs.writeFileSync(alt, csvText, 'utf8');
    console.log('⚠️ CSV 被占用(可能在Excel打开)，已写入: ' + alt);
    console.log('   请关闭原 CSV 后重跑，或直接打开新文件');
  }
  console.log('✅ 已生成: ' + path.join(__dirname, 'xunjian_report_table.md'));
}

main();
