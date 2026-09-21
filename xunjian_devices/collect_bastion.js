// 堡垒机(7443) → 订单管理平台服务器(df/free/top) + UES 资源
// 复用 cmd_ws5.js 握手 / cmd_authorized.js / bastion_ocr_big.py
// 最高风险：xterm 终端输入 opcode 未证实，尝试 data/input/key，失败降级 ok:false
const lib = require('../xunjian_lib');

const LOGIN_MARKER = 'DAS_USM_ROUTER_AUTH_';

async function getCaptchaSrc(page) {
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.src && /base64|data:image/.test(i.src));
    return imgs.length ? imgs[imgs.length - 1].src : null;
  });
}

async function attemptLogin(page, dcfg) {
  await page.goto(`https://${dcfg.host}:${dcfg.port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  for (let attempt = 0; attempt < 4; attempt++) {
    const src = await getCaptchaSrc(page);
    if (src) {
      const cands = await lib.ocr(dcfg.ocr, lib.b64Buffer(src), require('../xunjian_config'));
      for (const code of cands) {
        try {
          await page.locator('input').nth(0).fill(dcfg.user, { timeout: 4000 });
          await page.locator('input').nth(1).fill(dcfg.pass, { timeout: 4000 });
          const codeInput = page.locator('input').nth(2);
          if (await codeInput.count()) await codeInput.fill(code, { timeout: 4000 });
          await page.locator('button[type=submit], button').last().click().catch(() => {});
          await page.waitForTimeout(3500);
          const auth = await page.evaluate((marker) => {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.indexOf(marker) >= 0) return localStorage.getItem(k);
            }
            return null;
          }, LOGIN_MARKER);
          if (auth) {
            // 等待页面跳转到 index/workbench（会话完全建立，token 刷新），再取最新 auth
            for (let i = 0; i < 15; i++) {
              await page.waitForTimeout(1000);
              const u = page.url();
              if (u.indexOf('/index') >= 0 || u.indexOf('workbench') >= 0) break;
            }
            const auth2 = await page.evaluate((marker) => {
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(marker) >= 0) return localStorage.getItem(k);
              }
              return null;
            }, LOGIN_MARKER);
            return { ok: true, auth: auth2 || auth };
          }
        } catch (e) {}
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return { ok: false, err: '堡垒机登录失败(验证码4次未过)' };
}

async function discoverOrderAsset(page, auth, cfg) {
  return page.evaluate(async ({ auth, hint }) => {
    const hdrs = { authorization: auth, 'content-type': 'application/json', lang: 'ZH_CN' };
    const paths = [
      '/pamapi/om/v1/assets?type=ALL&pageSize=100&pageNumber=1',
      '/pamapi/om/v1/assets?pageSize=100&pageNumber=1',
      '/pamapi/om/v1/host/list?pageSize=100&pageNumber=1',
      '/pamapi/om/v1/host/assetList?pageSize=100&pageNumber=1',
    ];
    for (const p of paths) {
      try {
        const r = await fetch(p, { headers: hdrs });
        const j = await r.json();
        const list = (j.data && (j.data.list || j.data.records || j.data)) || [];
        const arr = Array.isArray(list) ? list : [];
        for (const a of arr) {
          const name = String(a.name || '');
          const ip = String(a.ip || a.ipAddr || '');
          if (name.includes(hint.nameRe) && hint.ipRe.test(ip)) {
            return { assetId: a.id, accountId: a.accountId, name, ip };
          }
        }
      } catch (e) {}
    }
    return null;
  }, { auth, hint: cfg.devices.bastion.orderAssetHint });
}

// 页面内建立 xterm 会话（复用 cmd_ws5 逻辑），返回 sid/url/是否就绪
async function openXterm(page, auth, accountId, assetId) {
  return page.evaluate(async ({ auth, accountId, assetId }) => {
    const w = window;
    const hdrs = { authorization: auth, 'content-type': 'application/json', lang: 'ZH_CN' };
    const r = await fetch('/pamapi/om/v1/host/authorized', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ accountId, service: 'ssh', method: 'H5', remoteClientId: 0, fromSysdef: false, assetId }),
    });
    const j = await r.json();
    const m = (j.data && j.data.url || '').match(/token=([^&]+)/);
    if (!m) return { ok: false, err: 'authorized无token: ' + JSON.stringify(j).slice(0, 300) };
    const authToken = atob(decodeURIComponent(m[1]));

    let pub = '04deadbeef';
    try {
      const kp = await w.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const jwk = await w.crypto.subtle.exportKey('jwk', kp.publicKey);
      const b64u = (b) => b.replace(/-/g, '+').replace(/_/g, '/') + (b.length % 4 === 2 ? '==' : b.length % 4 === 3 ? '=' : '');
      const toHex = (b) => { const bin = atob(b64u(b)); let s = ''; for (let i = 0; i < bin.length; i++) s += ('0' + bin.charCodeAt(i).toString(16)).slice(-2); return s; };
      pub = '04' + toHex(jwk.x) + toHex(jwk.y);
    } catch (e) {}

    const r2 = await w.fetch('/webclient/api/requestsession?ts=' + Date.now(), {
      method: 'GET',
      headers: { AuthToken: authToken, Authorization: auth, Timestamp: String(Date.now()), 'Client-Access-Key': pub },
    });
    const j2 = await r2.json();
    const sess = j2.h5Info && j2.h5Info.sessions && j2.h5Info.sessions[0];
    if (!sess || !sess.id) return { ok: false, err: 'requestsession无sid' };
    const sid = sess.id;

    w.__termLog = [];
    const log = w.__termLog;
    const encode = (e) => String(e).length + '.' + e;
    const sendMsg = (ws, opcode, args) => {
      const s = [encode(opcode)].concat((args || []).map(encode)).join(',') + ';';
      try { ws.send(s); log.push('SENT<' + opcode + '>'); } catch (e) { log.push('SEND_ERR ' + e); }
    };
    const handshakeArgs = { skip: 'true', speed: '1', type: 'char', protocol: 'SSH', width: '120', height: '30', encoding: 'utf8' };
    const url = 'wss://' + sess.usmHost + ':' + sess.usmWebPort + '/webclient/ws/xterm?sid=' + sid;
    const readyP = new Promise((resolve) => {
      let ws;
      try {
        ws = new w.WebSocket(url);
      } catch (e) { resolve({ ok: false, err: 'WS构造失败 ' + e }); return; }
      w.__ws = ws;
      ws.onopen = () => { log.push('OPEN'); sendMsg(ws, 'select', ['SSH']); };
      ws.onmessage = (e) => {
        const msgs = String(e.data).split(';');
        for (const mm of msgs) {
          if (!mm) continue;
          const parts = mm.split(',').map((p) => { const i = p.indexOf('.'); return p.substring(i + 1); });
          const op = parts.shift();
          if (op === 'args') {
            const vals = parts.map((k) => (k in handshakeArgs ? handshakeArgs[k] : ''));
            sendMsg(ws, 'connect', vals);
          } else if (op === 'ready') {
            sendMsg(ws, 'size', ['120', '30']);
            resolve({ ok: true, sid, url });
          } else if (op === 'tes') {
            // TES 输出是 base64 编码
            let txt = parts[0] || '';
            try { txt = atob(parts[0]); } catch (e) {}
            log.push('TES:' + txt.slice(0, 3000));
          } else if (op) log.push('RECV<' + op + '>');
        }
      };
      ws.onerror = () => log.push('WS_ERR');
      ws.onclose = () => log.push('WS_CLOSE');
      setTimeout(() => resolve({ ok: false, err: '握手超时', log: log.join('\n') }), 15000);
    });
    const res = await readyP;
    if (!res.ok) return res;
    w.__termSend = (opcode, cmd) => {
      const ws = w.__ws;
      if (!ws) return { ok: false, err: 'no ws' };
      // 文本分块发送（避免超长帧）
      const chunks = [];
      for (let i = 0; i < String(cmd).length; i += 200) chunks.push(String(cmd).slice(i, i + 200));
      for (const ch of chunks) sendMsg(ws, opcode, [ch]);
      return { ok: true };
    };
    return res;
  }, { auth, accountId, assetId });
}

function parseTop(dfOut, freeOut, topOut) {
  // disk: df -h 找挂载 / 的 Use%
  let disk = null;
  const dfLines = dfOut.split('\n');
  for (const line of dfLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6 && parts[5] === '/') {
      disk = parseFloat(parts[4]);
      break;
    }
  }
  // mem: free -h Mem 行 used/total
  let mem = null;
  const freeLines = freeOut.split('\n');
  for (const line of freeLines) {
    if (/^Mem:/i.test(line.trim())) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const used = parseFloat(parts[1]); const total = parseFloat(parts[2]);
        if (!isNaN(used) && !isNaN(total) && total > 0) mem = Math.round((used / total) * 1000) / 10;
      }
      break;
    }
  }
  // cpu: top %Cpu(s): us, sy ... idle
  let cpu = null;
  const topLines = topOut.split('\n');
  for (const line of topLines) {
    const m = line.match(/(\d+(\.\d+)?)\s+id/);
    if (m && line.includes('Cpu')) {
      cpu = Math.round((100 - parseFloat(m[1])) * 10) / 10;
      break;
    }
  }
  return { cpu, mem, disk };
}

async function collect(ctx, cfg, dcfg) {
  const r = lib.emptyResult(cfg.orderProduct.id, cfg.orderProduct.product);
  const page = await ctx.newPage();
  try {
    const login = await lib.withTimeout(attemptLogin(page, dcfg), 90000, 'bastion login');
    if (!login.ok) { r.error = login.err; return r; }
    lib.log('堡垒机登录成功');

    // 资产发现（订单平台）
    const asset = await lib.withTimeout(discoverOrderAsset(page, login.auth, cfg), 30000, 'asset discover');
    if (!asset) {
      r.error = '未在堡垒机资产列表中匹配到订单平台资产(匹配规则见 xunjian_config 的 bastion.orderAssetHint)，需人工确认资产ID后配置';
      r.remarks = '堡垒机登录成功、xterm 通道可用，但订单资产发现失败';
      return r;
    }
    const target = asset;

    // xterm 握手
    const term = await lib.withTimeout(openXterm(page, login.auth, target.accountId, target.assetId), 30000, 'xterm handshake');
    if (!term.ok) { r.error = 'xterm握手失败: ' + (term.err || ''); return r; }
    lib.log('xterm会话就绪 sid=' + term.sid);

    // 等待 shell 初始化
    await page.waitForTimeout(4000);

    // 探测可用输入 opcode
    let goodOp = null;
    for (const op of ['data', 'input', 'write', 'key']) {
      await page.evaluate(({ op, probe }) => window.__termSend(op, probe), { op, probe: 'echo XTERM_OK\\n' });
      await page.waitForTimeout(3500);
      const probeOut = await page.evaluate(() => window.__termLog.join('|'));
      if (probeOut.includes('XTERM_OK')) { goodOp = op; break; }
    }
    if (!goodOp) {
      const out = await page.evaluate(() => window.__termLog.join('\n'));
      r.error = '未找到可用终端输入opcode(data/input/write/key均无回显)，需人工进入堡垒机执行 df/free/top';
      r.remarks = out.slice(0, 800);
      return r;
    }
    lib.log(`堡垒机终端输入 opcode=${goodOp}`);

    // 发送完整命令
    const cmd = 'df -h; echo ===MEM===; free -h; echo ===TOP===; top -bn1 | head -30\\n';
    await page.evaluate(({ op, cmd }) => window.__termSend(op, cmd), { op: goodOp, cmd });
    await page.waitForTimeout(8000);

    // 读取输出
    const out = await page.evaluate(() => window.__termLog.join('\n'));
    if (!out.includes('MEM') && !out.includes('Filesystem')) {
      r.error = '命令未回显，需人工进入堡垒机执行 df/free/top';
      r.remarks = out.slice(0, 800);
      return r;
    }
    const df = out.split('===MEM===')[0] || out;
    const memSec = out.split('===MEM===')[1] || '';
    const freeOut = memSec.split('===TOP===')[0] || '';
    const topOut = memSec.split('===TOP===')[1] || out;
    const { cpu, mem, disk } = parseTop(df, freeOut, topOut);
    if (cpu == null && mem == null && disk == null) {
      r.error = '命令输出解析失败';
      r.remarks = out.slice(0, 1200);
      return r;
    }
    lib.fillOk(r, {
      cpu: cpu == null ? 0 : cpu, mem: mem == null ? 0 : mem, disk: disk == null ? 0 : disk,
      remarks: `订单管理平台(堡垒机xterm ${target.name || target.ip || ''}) 实时快照 df/free/top`,
      source: 'bastion xterm',
      collectionMode: 'bastion', hasWebChart: 'no',
    });
    return r;
  } catch (e) {
    r.error = String(e.message || e).slice(0, 300);
    return r;
  }
}

module.exports = { collect };
