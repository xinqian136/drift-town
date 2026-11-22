#!/usr/bin/env node
/* 漂流小镇 · 内联构建脚本 build-inline.js
 * ---------------------------------------------------------------------------
 * 把 data/{resources,buildings,recipes,npcs}.json 写进 game-data.js 的
 * EMBEDDED 区块，让微信小游戏（无网络、无文件系统）也能拿到配置数据。
 *
 * 用法（在项目根目录执行）：
 *   node build-inline.js            写入 game-data.js
 *   node build-inline.js --check    只校验是否最新，不写盘（CI / 提交前用）
 *   node build-inline.js --report   打印体积估算
 *
 * 幂等：数据没变时重复执行不会改动文件内容。
 * 只替换 EMBEDDED 区块，区块之外的代码一字不动。
 * ---------------------------------------------------------------------------
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var TARGET = path.join(ROOT, 'game-data.js');
var DATA_DIR = path.join(ROOT, 'data');
var TABLES = ['resources', 'buildings', 'recipes', 'npcs'];
var BEGIN = '/* === EMBEDDED:BEGIN (\u7531 build-inline.js \u751f\u6210\uff0c\u52ff\u624b\u6539) === */';
var END = '/* === EMBEDDED:END === */';

/* 微信小游戏主包上限 4.00 MB；本项目目前用到约 21%。 */
var WECHAT_PACKAGE_BUDGET = 4 * 1024 * 1024;
var WECHAT_PACKAGE_USED_RATIO = 0.21;

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

function readTables() {
  var out = {};
  for (var i = 0; i < TABLES.length; i++) {
    var name = TABLES[i];
    var file = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(file)) throw new Error('缺少数据表：' + file);
    var raw = fs.readFileSync(file, 'utf8');
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error('data/' + name + '.json 不是合法 JSON：' + error.message);
    }
    /* 顶层键顺序 = 原文件顺序（build-inline 不重排字段，方便和盘上文件逐行对照）。 */
    out[name] = { json: parsed, bytes: Buffer.byteLength(raw, 'utf8') };
  }
  return out;
}

/* 生成 EMBEDDED 区块。JSON 本身就是合法 JS 字面量（纯数据、无注释），
 * 直接内联即可，不需要 eval / Function —— 微信小游戏里这两个都受限。 */
function renderBlock(tables) {
  var lines = [BEGIN, '  var EMBEDDED = {'];
  for (var i = 0; i < TABLES.length; i++) {
    var name = TABLES[i];
    var text = JSON.stringify(tables[name].json);
    /* 防御：数据里若出现 </script> 之类的内容会破坏 HTML 直嵌，这里 JSON 里
     * 不可能出现裸的 <，但保留一个安全断言以免将来有人改成非 JSON 源。 */
    if (text.indexOf('</') >= 0) throw new Error(name + ' 含有 </，无法安全内联');
    lines.push('    ' + name + ': ' + text + (i < TABLES.length - 1 ? ',' : ''));
  }
  lines.push('  };');
  lines.push('  ' + END);
  return lines.join('\n');
}

function extract(source) {
  var start = source.indexOf(BEGIN);
  var end = source.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('game-data.js 里找不到 EMBEDDED 区块标记，无法安全替换');
  }
  return { start: start, end: end };
}

function main() {
  var argv = process.argv.slice(2);
  var checkOnly = argv.indexOf('--check') >= 0;
  var report = argv.indexOf('--report') >= 0;

  if (!fs.existsSync(TARGET)) throw new Error('找不到 ' + TARGET);
  var source = fs.readFileSync(TARGET, 'utf8');
  var span = extract(source);
  var tables = readTables();
  var block = renderBlock(tables);
  var next = source.slice(0, span.start) + block + source.slice(span.end + END.length);

  var oldBlock = source.slice(span.start, span.end + END.length);
  var changed = oldBlock !== block;

  if (checkOnly) {
    if (changed) {
      console.error('[build-inline] game-data.js 的 EMBEDDED 已过期，请运行 node build-inline.js');
      process.exitCode = 1;
      return;
    }
    console.log('[build-inline] OK：game-data.js 的 EMBEDDED 与 data/*.json 一致');
    return;
  }

  if (changed) {
    fs.writeFileSync(TARGET, next, 'utf8');
  }

  var totalRaw = 0, totalInline = 0;
  console.log('[build-inline] ' + (changed ? '已更新' : '无需更新（数据未变）') + ' → game-data.js');
  for (var i = 0; i < TABLES.length; i++) {
    var name = TABLES[i];
    var count = countItems(tables[name].json, name);
    totalRaw += tables[name].bytes;
    totalInline += Buffer.byteLength(JSON.stringify(tables[name].json), 'utf8');
    console.log('  ' + name.padEnd(10) + ' 条目 ' + String(count).padStart(3) +
      '  源文件 ' + kb(tables[name].bytes).padStart(9) +
      '  内联 ' + kb(Buffer.byteLength(JSON.stringify(tables[name].json), 'utf8')).padStart(9));
  }

  var sourceSize = Buffer.byteLength(source, 'utf8');
  var nextSize = Buffer.byteLength(next, 'utf8');
  var blockSize = Buffer.byteLength(block, 'utf8');
  console.log('  ' + 'EMBEDDED 区块'.padEnd(10) + '          ' + '' + ' '.repeat(9) +
    '            ' + kb(blockSize).padStart(9) + '  （占 game-data.js 的 ' +
    (blockSize / nextSize * 100).toFixed(1) + '%）');
  console.log('  data/*.json 合计 ' + kb(totalRaw) + ' → 内联后 ' + kb(totalInline) +
    '（省 ' + (100 - totalInline / totalRaw * 100).toFixed(1) + '% 空白）');
  console.log('  game-data.js ' + kb(sourceSize) + (changed ? ' → ' + kb(nextSize) : '') +
    '，本机上已装文件大小 ' + kb(fs.statSync(TARGET).size));

  var usedBudget = WECHAT_PACKAGE_BUDGET * WECHAT_PACKAGE_USED_RATIO;
  var afterRatio = (usedBudget + blockSize) / WECHAT_PACKAGE_BUDGET * 100;
  console.log('  微信主包：4.00 MB 上限，当前已用约 21%（' + kb(usedBudget) + '），' +
    '加入 game-data.js 后约 ' + afterRatio.toFixed(1) + '%（余量 ' +
    kb(WECHAT_PACKAGE_BUDGET - usedBudget - blockSize) + '）');

  if (report) {
    console.log('  提示：关闭 gzip 时按原始字节算；微信小游戏主包按上传后字节计，未做额外压缩。');
  }
}

function countItems(table, name) {
  var key = name === 'resources' ? 'items' : name;
  return Array.isArray(table[key]) ? table[key].length : 0;
}

try {
  main();
} catch (error) {
  console.error('[build-inline] 失败：' + (error && error.message || error));
  process.exitCode = 1;
}
