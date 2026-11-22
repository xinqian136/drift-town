// Verify the dive module inside the built game, by driving the debug hooks
// through the Chrome DevTools Protocol. Run: node test-dive-integration.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist', 'index.html');

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function main() {
  if (!fs.existsSync(DIST)) { console.log('FAIL: dist/index.html 不存在，先构建'); process.exit(1); }
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP: 未找到 Chrome/Edge'); process.exit(0); }

  console.log('浏览器: ' + path.basename(chrome));
  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-dive-test-' + Date.now());
  const port = 9333;
  const child = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userData,
    '--window-size=960,540',
    '--allow-file-access-from-files',
    'file:///' + DIST.replace(/\\/g, '/')
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + port + '/json/list'));
      // Prefer the target that actually points at our file, not about:blank.
      const page = list.find((t) => t.type === 'page' && t.url && t.url.indexOf('index.html') >= 0 && t.webSocketDebuggerUrl)
        || list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; console.log('CDP 目标: ' + page.url); break; }
    } catch (e) { /* not up yet */ }
  }
  if (!wsUrl) { console.log('FAIL: 无法连接 CDP'); child.kill(); process.exit(1); }

  // Minimal WebSocket client (no deps).
  const WebSocket = (function () {
    const net = require('net');
    const crypto = require('crypto');
    return function connect(url, onMessage) {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(Number(u.port), u.hostname, () => {
        sock.write(
          'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
          'Host: ' + u.hostname + ':' + u.port + '\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      let buf = Buffer.alloc(0), handshook = false;
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!handshook) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          handshook = true;
          buf = buf.slice(idx + 4);
        }
        while (buf.length >= 2) {
          const len0 = buf[1] & 0x7f;
          let offset = 2, len = len0;
          if (len0 === 126) { len = buf.readUInt16BE(2); offset = 4; }
          else if (len0 === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
          if (buf.length < offset + len) return;
          const payload = buf.slice(offset, offset + len).toString('utf8');
          buf = buf.slice(offset + len);
          try { onMessage(JSON.parse(payload)); } catch (e) { /* ignore */ }
        }
      });
      return {
        send: function (obj) {
          const data = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          let header;
          if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
          else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(data.length, 2); }
          const masked = Buffer.alloc(data.length);
          for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
          sock.write(Buffer.concat([header, mask, masked]));
        },
        close: function () { try { sock.destroy(); } catch (e) {} }
      };
    };
  })();

  const pending = new Map();
  let nextId = 1;
  const ws = WebSocket(wsUrl, (msg) => {
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function evaluate(expr) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.result && msg.result.result) resolve(msg.result.result.value);
        else resolve(undefined);
      });
      ws.send({ id: id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } });
    });
  }

  await sleep(3000);   // let three.js and the game boot

  const results = [];
  var pageUrl = await evaluate('location.href');
  console.log('\n[0] 页面地址: ' + pageUrl);
  var readyState = await evaluate('document.readyState');
  console.log('    readyState: ' + readyState);
  var scriptCount = await evaluate('document.scripts.length');
  console.log('    脚本数: ' + scriptCount);
  function check(name, value, want) {
    const ok = want === undefined ? !!value : value === want;
    results.push({ name, ok, value, want });
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ' = ' + JSON.stringify(value) + (want !== undefined ? ' (want ' + JSON.stringify(want) + ')' : ''));
  }

  console.log('\n[1] 模块是否加载');
  check('DiveGame 存在', await evaluate('typeof window.DiveGame'), 'object');
  check('GameData 存在', await evaluate('typeof window.GameData'), 'object');

  console.log('\n[2] 数据表是否驱动游戏');
  check('pickupKindsForGame 条数', await evaluate('window.GameData.pickupKindsForGame().length'), 7);
  check('spawnWeight 之和', await evaluate('window.GameData.pickupKindsForGame().reduce(function(s,k){return s+k.spawnWeight},0)'), 12);
  check('buildingSpecsForGame 条数', await evaluate('window.GameData.buildingSpecsForGame().length'), 6);
  check('validate 通过', await evaluate('window.GameData.validate().ok'), true);

  console.log('\n[3] 游戏启动状态');
  await evaluate('window.__autoplay && 1');
  check('phase', (await evaluate('window.__gameState().phase')) !== undefined, true);

  console.log('\n[4] 强制进入潜水');
  check('forceTownReady 可调用', await evaluate('typeof window.__forceTownReady'), 'function');
  check('startDive 返回 true', await evaluate('window.__startDive()'), true);
  await sleep(500);

  console.log('\n[5] 潜水状态');
  var st = await evaluate('JSON.stringify(window.__gameState().diving)');
  check('diving 为 true', st, 'true');
  var ds = await evaluate('JSON.stringify(window.__gameState().diveState)');
  console.log('  diveState = ' + ds);
  check('diveState 有 phase', ds && ds !== 'null', true);

  console.log('\n[6] 潜水 draw 无异常（跑几帧）');
  await sleep(1500);
  var after = await evaluate('JSON.stringify(window.__gameState().diveState)');
  console.log('  1.5s 后: ' + after);
  var oxy1 = JSON.parse(ds || '{}').oxygen, oxy2 = JSON.parse(after || '{}').oxygen;
  check('氧气在下降', (typeof oxy1 === 'number' && typeof oxy2 === 'number') ? oxy2 < oxy1 : false, true);

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(56));
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
  ws.close();
  child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
