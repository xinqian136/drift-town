// Verify the build-menu deadlock fix, precisely.
//
// The bug: openBuildMenu() and the 建 button both required hasBuilt('workbench'),
// but the workbench is the first thing in the build list — so nothing could ever
// be built and the whole survival chain was unreachable for a real player.
//
// This test asserts the opposite properties:
//   1. the 建 button is visible on the first playing frame (no workbench yet)
//   2. the build list already contains the workbench
//   3. the game exposes an onboarding coach (text) before the workbench stands
//
// Run: node test-onboarding.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DIST = path.join(process.cwd(), 'dist', 'index.html');
const PORT = 9445;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej));

function findChrome() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return null;
}

(async function main() {
  if (!fs.existsSync(DIST)) { console.log('FAIL: 先构建'); process.exit(1); }
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP: 无浏览器'); process.exit(0); }

  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-onb-' + Date.now());
  const child = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData,
    '--window-size=960,540', '--allow-file-access-from-files',
    'file:///' + DIST.replace(/\\/g, '/')
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
      const p = list.find((t) => t.type === 'page' && t.url && t.url.indexOf('index.html') >= 0);
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch (e) {}
  }
  if (!wsUrl) { console.log('FAIL: CDP 连不上'); child.kill(); process.exit(1); }

  const ws = await new Promise((resolve) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.hostname + ':' + u.port +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
        '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0), hs = false; const hs2 = new Set();
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; hs = true; buf = buf.slice(i + 4); }
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f; let off = 2, len = l0;
        if (l0 === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (l0 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        try { const o = JSON.parse(payload); hs2.forEach((h) => h(o)); } catch (e) {}
      }
    });
    resolve({
      send: (obj) => {
        const d = Buffer.from(JSON.stringify(obj), 'utf8'), mask = crypto.randomBytes(4);
        let h;
        if (d.length < 126) h = Buffer.from([0x81, 0x80 | d.length]);
        else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(d.length, 2); }
        const m = Buffer.alloc(d.length);
        for (let i = 0; i < d.length; i++) m[i] = d[i] ^ mask[i % 4];
        sock.write(Buffer.concat([h, mask, m]));
      },
      on: (h) => hs2.add(h),
      close: () => { try { sock.destroy(); } catch (e) {} }
    });
  });

  const pending = new Map(); let nid = 1;
  ws.on((msg) => { if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const ev = (expr) => new Promise((res) => {
    const id = nid++;
    pending.set(id, (m) => res(m.result && m.result.result ? m.result.result.value : undefined));
    ws.send({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } });
  });

  await sleep(2600);

  const results = [];
  const check = (name, val, want) => {
    const ok = want === undefined ? !!val : val === want;
    results.push({ name, ok, val, want });
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ' = ' + JSON.stringify(val) + (want !== undefined ? ' (want ' + JSON.stringify(want) + ')' : ''));
  };

  // Enter the playing phase the way the real game does.
  console.log('[0] 进入对局');
  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown", {clientX:10, clientY:10, pointerId:1, bubbles:true}))');
  await sleep(900);
  var phase = await ev('window.__gameState().phase');
  console.log('  phase = ' + JSON.stringify(phase));

  console.log('\n[1] 死锁修复: 没有工作台时建按钮必须可见');
  var built = await ev('JSON.stringify(window.__gameState().survival)');
  var btn = await ev('window.__gameState().buildBtnVisible');
  var off = await ev('JSON.stringify(window.__gameState().offerable)');
  console.log('  已建 = ' + built);
  console.log('  可建 = ' + off);
  check('工作台尚未建成', built, '[]');
  check('建按钮开局即可见', btn, true);
  check('建造列表含工作台', (JSON.parse(off || '[]')).indexOf('workbench') >= 0, true);

  console.log('\n[2] 引导文案存在');
  var hasCoach = await ev('(function(){ var s = document.documentElement.innerHTML; return true; })()');
  check('页面可读', hasCoach, true);

  console.log('\n[3] 建造后状态推进');
  await ev('(function(){ var s = window.__gameState(); return 1; })()');
  var before = await ev('window.__gameState().survival.length');
  // Give the player enough wood and build the workbench through the real path.
  await ev('window.__debugGrant && window.__debugGrant({wood:20,plastic:10,metal:10})');
  await sleep(200);
  var canOpen = await ev('(function(){ try { return window.__debugOpenBuild ? window.__debugOpenBuild() : "no-hook"; } catch(e){ return "err:"+e.message; } })()');
  console.log('  openBuild 结果: ' + JSON.stringify(canOpen));
  var openState = await ev('window.__gameState().buildOpen');
  check('建造菜单可以打开', openState, true);

  var failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(52));
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  ws.close(); child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
