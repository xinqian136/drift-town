// 验证 v1.9.0 的新东西：NPC 对话、寿司店、成就面板、排行榜面板
// Run: node test-v19.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DIST = path.join(process.cwd(), 'dist', 'index.html');
const PORT = 9450;
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

  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-v19-' + Date.now());
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
    console.log((ok ? '  ok   ' : '  FAIL ') + name + ' = ' + JSON.stringify(val) + (want !== undefined ? ' (want ' + JSON.stringify(want) + ')' : ''));
  };

  console.log('[0] 模块加载');
  var mods = await ev('JSON.stringify(["GameData","DiveGame","Achievements","Leaderboard","NpcDialogue","SushiShop"].map(function(k){return window[k]?"ok":"MISSING"}))');
  var modList = JSON.parse(mods || '[]');
  ['GameData','DiveGame','Achievements','Leaderboard','NpcDialogue','SushiShop'].forEach(function (m, i) {
    check(m + ' 已加载', modList[i], 'ok');
  });

  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(1000);
  check('进入 playing', await ev('window.__gameState().phase'), 'playing');

  console.log('\n[1] 建筑精修（5 座建筑方块数）');
  var bld = await ev('(function(){ try { return JSON.stringify(window.__renderBuildings ? Object.keys(window.__renderBuildings(64)) : null); } catch(e){ return "err:"+e.message; } })()');
  console.log('  建筑特写: ' + bld);

  console.log('\n[2] 成就/排行榜面板');
  check('A 键面板可开', await ev('(function(){ window.__debugAchievePanel && window.__debugAchievePanel(); return window.__gameState().panelOpen === "ach"; })()'), true);
  await ev('window.__debugClosePanel && window.__debugClosePanel()');
  await sleep(200);
  check('L 键面板可开', await ev('(function(){ window.__debugLeaderPanel && window.__debugLeaderPanel(); return window.__gameState().panelOpen === "lb"; })()'), true);
  await ev('window.__debugClosePanel && window.__debugClosePanel()');
  await sleep(200);

  console.log('\n[3] NPC 对话');
  check('招募老陈', await ev('window.__debugRecruitNpc("laochen")'), true);
  await sleep(300);
  check('有可触发事件', await ev('(function(){ return !!window.NpcDialogue.availableEvent(); })()'), true);
  check('E 面板可开', await ev('window.__debugNpc()'), true);
  var npcSt = await ev('JSON.stringify({open: window.__gameState().panelOpen, ev: (window.NpcDialogue.availableEvent()||{}).event ? window.NpcDialogue.availableEvent().event.title : null})');
  console.log('  ' + npcSt);

  console.log('\n[4] 寿司店');
  // 先关掉 NPC 面板
  await ev('(function(){ var e = new PointerEvent("pointerdown",{clientX:5,clientY:5,pointerId:2,bubbles:true}); document.getElementById("game").dispatchEvent(e); })()');
  await sleep(300);
  check('招募小满（开店前置）', await ev('window.__debugRecruitNpc("xiaoman")'), true);
  await sleep(200);
  check('开寿司店', await ev('window.__debugSushi()'), true);
  check('寿司店已开', await ev('window.SushiShop.isOpen()'), true);
  var menu = await ev('JSON.stringify(window.SushiShop.summary())');
  console.log('  店铺状态: ' + menu);

  console.log('\n[5] 潜水食材 → 寿司店入库');
  await ev('(function(){ window.SushiShop.addFromDive({items:[{key:"seaweed"},{key:"seaweed"},{key:"clam"}]}); })()');
  var stock = await ev('JSON.stringify(window.SushiShop.stockList())');
  console.log('  食材: ' + stock);
  check('食材已入库', (JSON.parse(stock || '[]')).length > 0, true);

  var failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(56));
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  ws.close(); child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
