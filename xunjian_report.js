// 一键巡检 — 报告构建 + app.js inspectionData 写回
const fs = require('fs');
const path = require('path');
const lib = require('./xunjian_lib');

const APP_JS = path.join(__dirname, 'app.js');

// 从 app.js 提取现有 inspectionData 数组（只 eval 数组字面量，不执行 DOM 代码）
function readBaseline() {
  const text = fs.readFileSync(APP_JS, 'utf8');
  const m = text.match(/const inspectionData = (\[[\s\S]*?\r?\n\];)/);
  if (!m) return { text, baseline: [] };
  let baseline = [];
  try { baseline = new Function('return ' + m[1] + ';')(); } catch (e) { baseline = []; }
  return { text, baseline: Array.isArray(baseline) ? baseline : [] };
}

// result(inspectionData 格式 schema) → app.js 行对象
function toRow(result) {
  return {
    id: result.id,
    product: result.product,
    collectionMode: result.collectionMode || 'web',
    hasWebChart: result.hasWebChart || 'no',
    cpuSeries: result.cpuSeries || [],
    diskSeries: result.diskSeries || [],
    memSeries: result.memSeries || [],
    ...(result.cpuPeakSeries ? { cpuPeakSeries: result.cpuPeakSeries } : {}),
    ...(result.diskPeakSeries ? { diskPeakSeries: result.diskPeakSeries } : {}),
    ...(result.memPeakSeries ? { memPeakSeries: result.memPeakSeries } : {}),
    // 版本号(需求: 所有产品都要有版本号)。采集器各自填充, 没有就不写这个键。
    // 目前有: 安恒云实例(含从 notes 提取的 19/4)、LT堡垒机、APT。
    ...(result.productVersion ? { productVersion: result.productVersion } : {}),
    ...(result.deviceSN ? { deviceSN: result.deviceSN } : {}),
    ...(result.license ? { license: result.license } : {}),
    remarks: result.remarks || '',
  };
}

async function build({ cfg, collected, anhengRows }) {
  const { text, baseline } = readBaseline();
  const baselineMap = new Map(baseline.map((b) => [b.id, b]));
  const byId = new Map();

  // 默认保留全部 baseline（含未采集/失败的旧值）
  for (const [id, row] of baselineMap) byId.set(id, row);

  // 采集结果：ok 则覆盖（新增若不在 baseline）
  for (const { name, result } of collected) {
    const id = result && result.id;
    if (result && result.ok && id != null) {
      byId.set(id, toRow(result));
    }
  }

  // 安恒云实例 → 按产品名去重：baseline 已有且槽位未被本地设备占用则复用 id，否则分配未占用 id
  // (本地/独立设备固定 id: apig5/lousao6/alpha7/aidsc8/apt16,17/LT18/DasV19，安恒云不得覆盖)
  const usedIds = new Set([...byId.keys()].map((k) => Number(k) || 0).filter((x) => x > 0));
  const deviceIds = new Set();
  for (const d of Object.values(cfg.devices || {})) if (d && Number(d.id) > 0) deviceIds.add(Number(d.id));
  for (const d of cfg.apt || []) if (d && Number(d.id) > 0) deviceIds.add(Number(d.id));
  if (cfg.orderProduct && Number(cfg.orderProduct.id) > 0) deviceIds.add(Number(cfg.orderProduct.id));
  let nextId = 9;
  for (const row of anhengRows) {
    if (!cfg.appendNewProducts) break;
    const dup = baseline.find((b) => b.product === row.product);
    const reusable = dup && !deviceIds.has(Number(dup.id) || 0);
    if (reusable) row.id = dup.id;
    else { while (usedIds.has(nextId)) nextId++; row.id = nextId++; }
    byId.set(row.id, row);
    usedIds.add(row.id);
  }

  // master 按 id 排序（保持 app.js 原有顺序 + 追加新行）
  const master = [...byId.values()].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

  // summary
  const summary = collected.map(({ name, result }) => {
    const avg = (a) => (Array.isArray(a) && a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
    return {
      name, id: result && result.id, product: result && result.product,
      ok: result && result.ok, error: result && result.error,
      cpuAvg: avg(result && result.cpuSeries), memAvg: avg(result && result.memSeries), diskAvg: avg(result && result.diskSeries),
      source: result && result.source,
      metrics: result && result.metrics || null,        // 运营指标(hs/ues/apt)
      metricsExtra: result && result.metricsExtra || null,
      // APT 扩展指标(版本/策略库/告警/流量)。collect_apt.js 挂在 r.aptMetrics 上,
      // 之前这里没透传 → 采到了却在产物里消失, 只剩被截断到 60 字的 remarks。
      aptMetrics: result && result.aptMetrics || null,
      remarks: result && result.remarks || '',
    };
  });

  const out = {
    schemaVersion: 2,
    collectedAt: new Date().toISOString(),
    summary,
    master,
    appJsText: text,
  };
  lib.writeJson(path.join(__dirname, cfg.reportFile || 'xunjian_report.json'), {
    schemaVersion: out.schemaVersion,
    collectedAt: out.collectedAt,
    summary: out.summary,
    master: out.master,
  });
  lib.log(`报告已写入 ${cfg.reportFile || 'xunjian_report.json'}`);
  return out;
}

// 文本替换 app.js 的 inspectionData 数组（兼容 CRLF/LF）
function writeApp(cfg, out) {
  const text = out.appJsText;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const HEAD = 'const inspectionData = ';
  const arrStart = text.indexOf(HEAD + '[');
  if (arrStart < 0) { lib.log('未找到 inspectionData 数组起点，中止'); return false; }
  const bodyStart = text.indexOf(eol, arrStart) + eol.length;
  const close = text.indexOf(eol + '];', bodyStart);
  if (close < 0) { lib.log('未找到数组结束标记 ]，中止'); return false; }

  const json = JSON.stringify(out.master, null, 2).split('\n');
  const body = json.slice(1, -1).join(eol);
  const replacement = '[' + eol + body + eol + '];';

  const tail = text.slice(close + eol.length + 2); // 跳过 "\n];" 或 "\r\n];"
  const next = text.slice(0, arrStart) + HEAD + replacement + tail;

  // 断言数组之后的内容（函数段等）逐字节保留在末尾
  if (tail && !next.endsWith(tail)) { lib.log('写回后尾部代码异常，中止'); return false; }
  if (!next.includes('function average(')) { lib.log('写回后函数段缺失，中止'); return false; }
  // 断言替换后的数组可解析
  const m2 = next.match(/const inspectionData = (\[[\s\S]*?\r?\n\];)/);
  if (!m2) { lib.log('写回后数组无法定位，中止'); return false; }
  try { new Function('return ' + m2[1] + ';')(); } catch (e) { lib.log('写回后数组解析失败，中止: ' + e.message); return false; }

  try { fs.copyFileSync(APP_JS, APP_JS + '.bak'); } catch (e) {}
  fs.writeFileSync(APP_JS, next, 'utf8');
  lib.log('app.js 已更新，备份 app.js.bak');
  return true;
}

module.exports = { build, writeApp, readBaseline, toRow };
