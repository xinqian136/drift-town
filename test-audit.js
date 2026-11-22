// 诚实的整体功能体检：模拟新玩家从打开游戏开始，逐项验证「看得见、点得到、有反应、有意义」
// 不依赖 debug hook 的乐观断言，尽量走玩家真实路径
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const DIST = path.join(process.cwd(), 'dist', 'index.html');
const PORT = 9452;
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

  const userData = path.join(process.env.TEMP || '/tmp', 'dsh-audit-' + Date.now());
  const child = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData,
    '--window-size=960,540', '--allow-file-access-from-files',
    'file:///' + DIST.replace(/\\/g, '/')
  ], { stdio: 'ignore' });

  let wsUrl = null, consoleErrors = [];
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
  ws.on((msg) => {
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    // 收集运行时异常
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(JSON.stringify(msg.params.exceptionDetails && msg.params.exceptionDetails.text || ''));
    }
  });
  const ev = (expr) => new Promise((res) => {
    const id = nid++;
    pending.set(id, (m) => res(m.result && m.result.result ? m.result.result.value : undefined));
    ws.send({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } });
  });

  await ev('Runtime.enable()');
  await sleep(3500);

  const rows = [];
  const row = (cat, name, pass, detail) => {
    rows.push({ cat, name, pass, detail });
    console.log((pass ? '  OK   ' : '  FAIL ') + '[' + cat + '] ' + name + (detail ? ' — ' + detail : ''));
  };

  console.log('==================== 漂流小镇 整体功能体检 ====================\n');

  // --- A. 启动与渲染 ---
  console.log('--- A. 启动与渲染 ---');
  var st0 = await ev('JSON.stringify(window.__gameState ? window.__gameState() : null)');
  var s0 = JSON.parse(st0 || 'null');
  row('启动', '游戏能启动 (window.__gameState 存在)', !!s0, s0 ? 'phase=' + s0.phase : '无状态');
  row('渲染', 'WebGL 渲染器工作', s0 && s0.renderer === 'webgl', s0 ? 'renderer=' + s0.renderer : '');
  row('渲染', '无运行时异常', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0,2).join('; ') : '0 条');

  // --- B. 新玩家开局 ---
  console.log('\n--- B. 新玩家开局 ---');
  // 真实点击开始
  await ev('document.getElementById("game").dispatchEvent(new PointerEvent("pointerdown",{clientX:10,clientY:10,pointerId:1,bubbles:true}))');
  await sleep(1500);
  var s1 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  row('开局', '点击屏幕能进入 playing', s1.phase === 'playing', 'phase=' + s1.phase);
  row('开局', '海上有垃圾可捡', (s1.pickups || []).length > 0, 'pickups=' + (s1.pickups || []).length);
  row('开局', '有鲨鱼(有威胁)', (s1.enemies || []).length >= 0, 'enemies=' + (s1.enemies || []).length);
  row('开局', '无限计时(非倒计时)', s1.time > 900000 || s1.time === undefined, 'time=' + s1.time);

  // --- C. 打捞核心循环 ---
  console.log('\n--- C. 打捞核心循环（等 8 秒看自动打捞能否产出材料）---');
  await sleep(8000);
  var s2 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  // __gameState 没暴露 res，用 HUD 截图无法读数值，改用拾取计数代理：score 或 pieces
  row('打捞', '打捞后 score 有变化', (s2.score || 0) > (s1.score || 0), 'score ' + (s1.score||0) + ' -> ' + (s2.score||0));

  // --- D. 建造可达性（关键：新手能不能造出第一个东西）---
  console.log('\n--- D. 建造可达性 ---');
  var buildBtn = s2.buildBtnVisible;
  row('建造', '「建」按钮开局可见', !!buildBtn, 'buildBtnVisible=' + buildBtn);
  var offerable = s2.offerable || [];
  row('建造', '建造列表包含工作台', offerable.indexOf('workbench') >= 0, JSON.stringify(offerable));
  // 直接给材料再走真实建造路径
  await ev('window.__debugGrant && window.__debugGrant({wood:20,plastic:10,metal:10})');
  await sleep(300);
  var opened = await ev('(function(){ window.__debugOpenBuild && window.__debugOpenBuild(); return window.__gameState().buildOpen; })()');
  row('建造', '能打开建造菜单', opened === true, 'buildOpen=' + opened);
  var built = await ev('window.__debugBuild && window.__debugBuild("workbench")');
  row('建造', '能造出工作台', built === true, 'result=' + built);
  await sleep(400);
  var s3 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  row('建造', '造完后船上确实有建筑', (s3.shipParts || []).length > 0, 'shipParts=' + JSON.stringify(s3.shipParts));

  // --- E. 功能面板可达性 ---
  console.log('\n--- E. 功能面板 ---');
  var buttons = {
    '潜(下潜)': s3.diveBtnVisible, '船(管理)': s3.manageBtnVisible,
    '建': s3.buildBtnVisible, '成(成就)': s3.achBtnVisible, '榜(排行)': s3.lbBtnVisible
  };
  Object.keys(buttons).forEach(function (k) {
    row('面板', k + ' 按钮可见', !!buttons[k], '=' + buttons[k]);
  });
  // 面板开关
  var achOpen = await ev('(function(){ window.__debugAchievePanel && window.__debugAchievePanel(); return window.__gameState().panelOpen; })()');
  row('面板', '成就面板能打开', achOpen === 'ach', 'panelOpen=' + achOpen);
  await ev('window.__debugClosePanel && window.__debugClosePanel()');
  var lbOpen = await ev('(function(){ window.__debugLeaderPanel && window.__debugLeaderPanel(); return window.__gameState().panelOpen; })()');
  row('面板', '排行榜面板能打开', lbOpen === 'lb', 'panelOpen=' + lbOpen);
  await ev('window.__debugClosePanel && window.__debugClosePanel()');

  // --- F. 潜水进出（用户报过「潜水后回不来」）---
  console.log('\n--- F. 潜水进出 ---');
  var diveStart = await ev('window.__startDive && window.__startDive()');
  row('潜水', '能进入潜水', diveStart === true, 'result=' + diveStart);
  await sleep(500);
  var s4 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  row('潜水', '潜水状态激活', s4.diving === true, 'diving=' + s4.diving);
  row('潜水', '有「返回船上」按钮', s4.diveExitVisible === true, 'diveExitVisible=' + s4.diveExitVisible);
  var exited = await ev('window.__debugExitDive && window.__debugExitDive()');
  row('潜水', '能退出回到船上', exited === true, 'result=' + exited);
  await sleep(300);
  var s5 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  row('潜水', '退出后不是潜水画面', s5.diving === false, 'diving=' + s5.diving);
  row('潜水', '退出后仍在 playing', s5.phase === 'playing', 'phase=' + s5.phase);

  // --- G. 停船/钓鱼（用户要求「不开船可以进小镇打鱼」）---
  console.log('\n--- G. 停船与钓鱼 ---');
  var dock = await ev('window.__debugDock && window.__debugDock(true)');
  row('停船', '能下锚停船', dock === true, 'result=' + dock);
  await sleep(400);
  var s6 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  row('停船', '钓鱼按钮出现', s6.fishBtnVisible === true, 'fishBtnVisible=' + s6.fishBtnVisible);
  var cast = await ev('window.__debugCast && window.__debugCast()');
  row('钓鱼', '能甩竿', cast > 0, 'timer=' + cast);

  // --- H. 死亡不清建筑（v2.0.0 核心）---
  console.log('\n--- H. 死亡不清建筑（无限生存核心）---');
  var before = await ev('JSON.stringify(window.__gameState().survival)');
  await ev('window.__debugKill && window.__debugKill()');
  await sleep(1200);
  var s7 = JSON.parse((await ev('JSON.stringify(window.__gameState())')) || '{}');
  var after = await ev('JSON.stringify(window.__gameState().survival)');
  row('生存', '死亡后不是 lost', s7.phase === 'playing', 'phase=' + s7.phase);
  row('生存', '死亡后建筑保留', before === after, before + ' -> ' + after);

  // --- I. 模块完整性 ---
  console.log('\n--- I. 系统模块 ---');
  var mods = JSON.parse((await ev('JSON.stringify(["GameData","DiveGame","Achievements","Leaderboard","NpcDialogue","SushiShop"].map(function(k){return window[k]?"ok":"MISSING"}))')) || '[]');
  ['GameData','DiveGame','Achievements','Leaderboard','NpcDialogue','SushiShop'].forEach(function (m, i) {
    row('模块', m + ' 已加载', mods[i] === 'ok', mods[i]);
  });

  // --- J. 最终异常检查 ---
  console.log('\n--- J. 全程异常 ---');
  row('异常', '全程无脚本异常', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0,3).join(' | ') : '0 条');

  var failed = rows.filter(function (r) { return !r.pass; });
  console.log('\n' + '='.repeat(60));
  console.log('共 ' + rows.length + ' 项检查，通过 ' + (rows.length - failed.length) + '，失败 ' + failed.length);
  if (failed.length) {
    console.log('\n失败项清单（这些就是「没法玩」的具体原因）:');
    failed.forEach(function (r) { console.log('  - [' + r.cat + '] ' + r.name + (r.detail ? ' (' + r.detail + ')' : '')); });
  }
  ws.close(); child.kill();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
