// 回归测试：城镇图纸选择「点击没反应」的 bug
// 真实模拟 pointerdown 点击卡片，验证建筑真的被建成
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DIST = path.join(process.cwd(), 'dist', 'index.html');
const PORT = 9453;
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

  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-town-' + Date.now());
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

  // 进入游戏
  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(1200);
  check('进入 playing', await ev('window.__gameState().phase'), 'playing');

  // 触发城镇图纸
  var offer = await ev('window.__debugOfferTown()');
  console.log('  图纸: ' + JSON.stringify(offer));
  check('图纸弹窗出现', Array.isArray(offer) && offer.length >= 1, true);
  await sleep(400);   // 等一帧把 townCardRects 画出来

  var rects = await ev('JSON.stringify(window.__debugTownRects())');
  console.log('  命中区: ' + rects);
  var rs = JSON.parse(rects || 'null');
  check('townCardRects 未被清空', Array.isArray(rs) && rs.length >= 1, true);

  var before = await ev('window.__gameState().buildings');
  console.log('  点击前建筑数: ' + before);

  // 真实点击第一张卡片中心
  if (rs && rs.length) {
    var cxp = Math.round(rs[0].x + rs[0].w / 2), cyp = Math.round(rs[0].y + rs[0].h / 2);
    console.log('  点击坐标: ' + cxp + ',' + cyp);
    await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:' + cxp + ',clientY:' + cyp + ',pointerId:7,bubbles:true}))');
    await sleep(600);
    var after = await ev('window.__gameState().buildings');
    console.log('  点击后建筑数: ' + after);
    check('点击卡片后建筑 +1', after === before + 1, true);
    var offerGone = await ev('JSON.stringify(window.__gameState().offer)');
    console.log('  弹窗状态: ' + offerGone);
    check('点击后弹窗关闭', offerGone === 'null', true);
  } else {
    check('能拿到卡片命中区', false, true);
  }

  var failed = results.filter(function (r) { return !r.ok; });
  console.log('\n' + '='.repeat(56));
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  ws.close(); child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
