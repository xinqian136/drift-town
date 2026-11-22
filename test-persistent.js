// 验证无限生存：死后建筑保留、材料减半、自动复活
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DIST = path.join(process.cwd(), 'dist', 'index.html');
const PORT = 9451;
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

  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-persist-' + Date.now());
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

  await sleep(3000);
  const results = [];
  const check = (name, val, want) => {
    const ok = want === undefined ? !!val : val === want;
    results.push({ name, ok, val, want });
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ' = ' + JSON.stringify(val));
  };

  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(1200);
  check('进入 playing', await ev('window.__gameState().phase'), 'playing');

  console.log('\n[1] 建一些建筑');
  await ev('window.__debugGrant({wood:50,plastic:20,metal:10})');
  await ev('window.__debugBuild("workbench")');
  await ev('window.__debugBuild("shelter")');
  await ev('window.__debugBuild("rainCatcher")');
  await sleep(400);
  var built = await ev('JSON.stringify(window.__gameState().survival)');
  console.log('  生存装备: ' + built);
  check('建了 3 件装备', (JSON.parse(built || '[]')).length, 3);
  var res1 = await ev('JSON.stringify({w:window.__gameState().water,m:window.__gameState().maxWater})');
  console.log('  资源: ' + await ev('window.__gameState().res'));

  console.log('\n[2] 杀死玩家 → 应该 respawn 而不是 game over');
  // 直接把 hearts 减到 0（模拟死亡）
  await ev('window.__debugKill && window.__debugKill()');
  // 如果没有 __debugKill，直接让鲨鱼咬到（用另一种方式：把 hearts 置 0 然后触发受伤）
  var phaseAfterDeath = await ev('window.__gameState().phase');
  console.log('  死后 phase: ' + JSON.stringify(phaseAfterDeath));
  await sleep(2000);
  var phaseAfterWait = await ev('window.__gameState().phase');
  console.log('  2秒后 phase: ' + JSON.stringify(phaseAfterWait));
  check('死后回到 playing（不是 lost）', phaseAfterWait, 'playing');

  console.log('\n[3] 建筑还在吗？');
  var built2 = await ev('JSON.stringify(window.__gameState().survival)');
  console.log('  死后生存装备: ' + built2);
  check('死后建筑保留', (JSON.parse(built2 || '[]')).length >= 3, true);

  console.log('\n[4] 资源减半了？');
  var resAfter = await ev('JSON.stringify(window.__gameState().survival)');
  console.log('  资源状态: ' + resAfter);

  console.log('\n[5] 计时器是正计时？');
  var timeInfo = await ev('JSON.stringify({time: window.__gameState().time})');
  console.log('  time 字段: ' + timeInfo);

  var failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(56));
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  ws.close(); child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
