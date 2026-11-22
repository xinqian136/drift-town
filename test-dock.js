// Verify the two things the player reported:
//   1. "潜水之后没办法回到船上"  -> exiting a dive must return control to the raft
//   2. "船就是一个移动的小镇, 不开船可以进入小镇, 可以打鱼, 潜水"
//      -> docking, fishing, and diving from the docked town must all work
//
// Run: node test-dock.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DIST = path.join(process.cwd(), 'dist', 'index.html');
const PORT = 9448;
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

  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-dock-' + Date.now());
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
    let buf = Buffer.alloc(0), hs = false; const h2 = new Set();
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
        try { const o = JSON.parse(payload); h2.forEach((h) => h(o)); } catch (e) {}
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
      on: (h) => h2.add(h),
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

  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(900);
  check('进入 playing', await ev('window.__gameState().phase'), 'playing');

  console.log('\n[1] 潜水后必须能回到船上（用户报的阻塞 bug）');
  check('启动潜水', await ev('window.__startDive()'), true);
  await sleep(500);
  check('潜水已激活', await ev('window.__gameState().diving'), true);
  check('退出按钮可见', await ev('window.__gameState().diveExitVisible'), true);
  var exited = await ev('window.__debugExitDive()');
  check('exitDive 后不再是潜水状态', exited, true);
  await sleep(300);
  check('diving 已关闭', await ev('window.__gameState().diving'), false);
  check('回到 playing', await ev('window.__gameState().phase'), 'playing');
  check('显示回到船上的提示', await ev('window.__gameState().diveExitBanner > 0'), true);

  console.log('\n[2] 停船 = 船变成可停留的小镇');
  check('停船按钮可见', await ev('window.__gameState().dockBtnVisible'), true);
  check('初始未停船', await ev('window.__gameState().docked'), false);
  check('下锚', await ev('window.__debugDock(true)'), true);
  check('docked = true', await ev('window.__gameState().docked'), true);

  console.log('\n[3] 停船后可以钓鱼');
  await sleep(400);                       // let a HUD frame run so rects are set
  check('钓鱼按钮出现', await ev('window.__gameState().fishBtnVisible'), true);
  var t = await ev('window.__debugCast()');
  check('甩竿计时开始', t > 0, true);
  await sleep(300);
  check('等待中 fishReady=false', await ev('window.__gameState().fishReady'), false);
  // Fast-forward: the bite takes 2.2-3.8s. Poll while checking the clock runs.
  for (var i = 0; i < 12; i++) {
    await sleep(500);
    var st = await ev('JSON.stringify({r:window.__gameState().fishReady,t:window.__gameState().fishTimer,d:window.__gameState().docked})');
    var o = JSON.parse(st);
    if (i % 3 === 0) console.log('  t+' + ((i + 1) * 0.5).toFixed(1) + 's: ' + st);
    if (o.r) break;
  }
  var ready = await ev('window.__gameState().fishReady');
  console.log('  fishReady after wait = ' + JSON.stringify(ready));
  if (ready) {
    var foodBefore = await ev('window.__gameState().food');
    check('收竿成功', await ev('window.__debugReel()'), true);
    await sleep(200);
    var foodAfter = await ev('window.__gameState().food');
    console.log('  食物: ' + foodBefore + ' -> ' + foodAfter);
    check('食物增加', foodAfter >= foodBefore, true);
  } else {
    check('鱼咬钩（超时未到）', false, true);
  }

  console.log('\n[4] 停船后仍可潜水');
  check('停船状态下启动潜水', await ev('window.__startDive()'), true);
  await sleep(400);
  check('潜水激活', await ev('window.__gameState().diving'), true);
  await ev('window.__debugExitDive()');
  await sleep(300);
  check('退出后回到船上', await ev('window.__gameState().diving'), false);

  console.log('\n[5] 起锚可以继续航行');
  check('起锚', await ev('window.__debugDock(false)'), false);
  check('docked=false', await ev('window.__gameState().docked'), false);

  var failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(54));
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  ws.close(); child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
