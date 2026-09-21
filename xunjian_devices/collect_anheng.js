// 安恒云专享实例 — 把 anheng_collected.json 映射成 inspectionData 格式的行(不含 id，由 report.build 分配 9+)
//
// 【数据来源与实时性】本文件只读不写。JSON 由 anheng_cloud_collect.js 生成，
// 而那个采集器【每次巡检都会被 xunjian_all.js 调用】—— 所以这里读到的就是本次采的实时数据，
// 不是"以前存下来的"。每个实例的 inst.resourceCollectedAt 记录了它自己那次采集的时间，
// 逐实例判断新鲜度(整体时间戳无法反映"某个实例这次采挂了")。
const fs = require('fs');
const lib = require('../xunjian_lib');

function collect(dcfg, cfg) {
  if (!fs.existsSync(dcfg.file)) {
    throw new Error('anheng_collected.json 不存在，请先采集安恒云');
  }
  const data = lib.readJson(dcfg.file);
  const rows = [];
  const staleMs = (dcfg.staleHours || 26) * 3600000;
  const globalAt = data.resourceCollectedAt || data.collectedAt;

  const licTxt = (l) => l ? `授权到期${l.expireDate || '?'}${l.daysLeft != null ? '(剩' + l.daysLeft + '天)' : ''}` : '';

  // 【版本号从 notes 里捞回来】—— 有 2 个实例的版本其实早就采到了, 但被降级成 notes 自由文本:
  //   下一代防火墙-19: "版本TC_nologo_fw 20250102"  主机安全-4: "明御终端安全及防病毒系统V3.0"
  // notes 是人工判读的混杂文本, 直接当版本号会上报一堆"磁盘使用率偏高"之类的噪声, 必须用正则精确提取。
  const NOTES_VERSION_RULES = [
    // 固件串带空格分隔的构建号(TC_nologo_fw 20251231) —— 必须连构建号一起取,
    // 只取 TC_nologo_fw 会丢掉版本里唯一可比的日期部分
    /(TC_nologo_fw(?:[\w.-]*)(?:\s+\d{6,8})?)/,
    /(明御终端安全及防病毒系统\s*V[\d.]+)/,           // 主机安全平台版本
  ];
  function versionFromNotes(notes) {
    if (!notes) return '';
    for (const re of NOTES_VERSION_RULES) {
      const m = notes.match(re);
      if (m) return m[1].trim();
    }
    return '';
  }

  // 上游 productVersion 字段【不可信】: 有 2 个实例填的是产品名而非版本号
  //   -80/-79 → "数据库安全网关";  -47 → "恒脑API风险监测系统"
  // 版本号一定含数字(如 V4.0R75C00、WAF-V3.0R47C59、TC_nologo_fw 20251231),
  // 产品名不含 → 用"必须含数字"把这类脏值挡掉, 宁可显示 — 也不能把产品名当版本号上报。
  function looksLikeVersion(s) {
    return !!s && /\d/.test(s);
  }

  for (const inst of data.instances || []) {
    const d = inst.daily;
    // 【逐指标独立判断, 不能拿 cpu 一票否决】—— 有的产品只暴露内存/磁盘(如数据加解密-32:
    // cpuEcharts 恒返回空数组, 只有 basicInfo 的 memUsedRate/diskUsedRate 可用)。
    // 旧代码用 d.cpu.avg.length===7 当总开关, 会把该产品的 内存/磁盘 一起丢掉。
    // 长度也不再限死 7: 只有实时值的产品是【单点序列】, 长度 1 同样要出表。
    const has = (m) => !!(d && d[m] && Array.isArray(d[m].avg) && d[m].avg.length > 0);
    const any = has('cpu') || has('mem') || has('disk');
    // 实时值(live)与历史曲线的口径不同, 报表必须写清楚, 否则"峰值"会被误读成真实波动区间
    const live = (m) => has(m) && !!(d[m] && d[m].live);
    const liveNote = any && ['cpu', 'mem', 'disk'].some(live) ? ' (实时值, 峰值=当前值)' : '';
    // 新鲜度逐实例判断: 用该实例自己的采集时间, 没有才退回整份文件的时间戳
    const rAt = inst.resourceCollectedAt || globalAt;
    const stale = rAt ? Date.now() - new Date(rAt).getTime() > staleMs : true;
    const lic = licTxt(inst.license);
    // 上游字段只有"像版本号"才采纳, 否则回落 notes 正则; 都没有就留空(报表显示 —)
    const ver = (looksLikeVersion(inst.productVersion) ? inst.productVersion : '') || versionFromNotes(inst.notes);
    // 【口径标记放 notes, 不放 remarks】remarks 以产品 URL 开头(50+ 字符), 而报表备注列只截 60 字,
    // 后面的"实时值/超时"标记会被截掉 —— 恰恰是最需要给人看到的那几个字。
    // notes 是干净的一句话摘要, 表格优先取它。
    const notesFull = (inst.notes || '') + liveNote + (stale ? ' (数据超时建议重采)' : '');
    const r = {
      product: inst.name,
      collectionMode: 'web',
      // 结构化字段, 供设备巡检记录表(按系统分组)取用; 顺带保留原 remarks 文本
      productVersion: ver,
      productUrl: inst.productUrl,
      deviceSN: '',                       // 安恒云控制台实例清单不含 SN, 留空不编造
      license: inst.license || null,
      notes: notesFull,
      remarks: `${inst.productUrl} ${ver}${lic ? ' | ' + lic : ''} ${notesFull}`,
      source: 'anheng_cloud_collect.js (本次巡检实时采集)',
    };
    // APT 扩展指标(需求3): 策略库版本/告警/流量 —— 云上 APT-36 与本地 LC1/LC2 口径一致。
    // 挂在这行上会随 master 一起进 xunjian_report.json, 由 xunjian_table.js 渲染成独立区块。
    if (inst.aptMetrics) r.aptMetrics = inst.aptMetrics;
    if (any) {
      r.hasWebChart = 'yes';
      // 逐指标给出: 该产品没有的那个指标留 null, 由表格渲染成 —(不编造数值)
      r.cpuSeries = has('cpu') ? d.cpu.avg : null; r.memSeries = has('mem') ? d.mem.avg : null; r.diskSeries = has('disk') ? d.disk.avg : null;
      r.cpuPeakSeries = has('cpu') ? d.cpu.max : null; r.memPeakSeries = has('mem') ? d.mem.max : null; r.diskPeakSeries = has('disk') ? d.disk.max : null;
    } else {
      // 无任何资源数据实例也出表：仅展示 IP + 授权到期(资源列空)
      r.hasWebChart = 'no';
      r.cpuSeries = null; r.memSeries = null; r.diskSeries = null;
    }
    rows.push(r);
  }
  const curves = rows.filter((x) => x.cpuSeries || x.memSeries || x.diskSeries).length;
  const staleN = rows.filter((x) => /数据超时建议重采/.test(x.remarks)).length;
  lib.log(`安恒云映射: 读取 ${data.instances ? data.instances.length : 0} 实例, 全部出表; ${curves} 个有资源数据` +
    (staleN ? `，${staleN} 个数据超时` : ''));
  return rows;
}

module.exports = { collect };
