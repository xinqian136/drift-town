#!/usr/bin/env node
/* 漂流小镇 · 数据表接入层验收测试 test-data.js
 * ---------------------------------------------------------------------------
 * 只跑 node，不联网、不依赖测试框架：
 *   node test-data.js
 *
 * 覆盖 5 项验收：
 *   1. 四张表能正确加载（结构 / 条目数 / id 索引 / 引用完整）
 *   2. pickupKindsForGame() 的 7 条，value / res / name 与 game.js 的
 *      PICKUP_KINDS 逐字段相等
 *   3. buildingSpecsForGame() 的 6 条，cost 与 game.js 的 BUILDING_SPECS
 *      逐字段相等
 *   4. spawnWeight 之和 = 12
 *   5. validate() 返回 ok:true
 *
 * 期望值为什么是手工抄的常量，而不是从 game.js 里正则提取：
 *   game.js 是 IIFE，加载即需要 document / WebGL，不能 require。若用正则从
 *   源码里抠，等于拿同一份源码自证——数据表错了照样能通过（只要提取逻辑和
 *   读取逻辑一致）。所以下面的 EXPECTED_* 是照着 game.js 手抄的独立副本，
 *   任何一侧改动都会让测试红。硬编码的值都标了 game.js 行号。
 * ---------------------------------------------------------------------------
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var GD = require(path.join(ROOT, 'game-data.js'));

/* --- 手抄自 game.js 的期望值（改 game.js 时这里必须同步改，否则测试红） ---- */

/* game.js:614-622 · PICKUP_KINDS，数组顺序就是 game.js 的下标顺序。
 * model 字段不在此列：体素模型是代码画的，数据表只给 modelKey（见第 2 项断言）。 */
var EXPECTED_PICKUP_KINDS = [
  { index: 0, id: 'plasticBottle', name: '塑料瓶', value: 1, glow: '#8ee3b8', res: { plastic: 1 }, modelKey: 'BOTTLE' },
  { index: 1, id: 'sodaCan', name: '易拉罐', value: 1, glow: '#ff9a96', res: { metal: 1 }, modelKey: 'CAN' },
  { index: 2, id: 'rubberDuck', name: '橡皮鸭', value: 1, glow: '#ffe066', res: { plastic: 1 }, modelKey: 'DUCK' },
  { index: 3, id: 'woodenCrate', name: '木箱', value: 2, glow: '#ffd166', res: { wood: 2 }, modelKey: 'CRATE' },
  { index: 4, id: 'barrel', name: '木桶', value: 2, glow: '#e0b072', res: { wood: 1, metal: 1 }, modelKey: 'BARREL' },
  { index: 5, id: 'tire', name: '轮胎', value: 2, glow: '#aab4c0', res: { plastic: 1, metal: 1 }, modelKey: 'TIRE' },
  { index: 6, id: 'fishingNet', name: '渔网', value: 3, glow: '#7fd8b4', res: { wood: 1, plastic: 2 }, modelKey: 'NET' }
];

/* game.js:767-774 · BUILDING_SPECS，顺序即建造顺序。 */
var EXPECTED_BUILDING_SPECS = [
  { id: 'cabin', name: '小屋', cost: { wood: 4, plastic: 0, metal: 0 }, pop: 1, perk: 'maxHearts', desc: '+1 心' },
  { id: 'waterTower', name: '水塔', cost: { wood: 3, plastic: 3, metal: 0 }, pop: 1, perk: 'water', desc: '水壶 +25' },
  { id: 'greenhouse', name: '温室', cost: { wood: 2, plastic: 4, metal: 0 }, pop: 1, perk: 'magnet', desc: '吸附范围+' },
  { id: 'lighthouse', name: '灯塔', cost: { wood: 3, plastic: 2, metal: 3 }, pop: 0, perk: 'shields', desc: '护盾更久' },
  { id: 'marketStall', name: '市集', cost: { wood: 4, plastic: 3, metal: 3 }, pop: 2, perk: 'trade', desc: '收益 +1' },
  { id: 'windmill', name: '风车', cost: { wood: 5, plastic: 3, metal: 4 }, pop: 1, perk: 'speed', desc: '船速 +' }
];

/* game.js:54-70 · DEFAULTS.survival 的 6 条造价与 6 个速率常量（附加验证）。 */
var EXPECTED_SURVIVAL_COSTS = {
  workbench: { wood: 4, plastic: 0, metal: 0 },
  shelter: { wood: 8, plastic: 2, metal: 0 },
  rainCatcher: { wood: 3, plastic: 2, metal: 0 },
  fishBasket: { wood: 4, plastic: 0, metal: 0 },
  scoopNet: { wood: 3, plastic: 0, metal: 0 },
  purifier: { wood: 4, plastic: 0, metal: 2 }
};
var EXPECTED_SURVIVAL_RATES = {
  rainEvery: 8, rainAmount: 8,
  fishEvery: 10, fishAmount: 6,
  purifyEvery: 5, purifyAmount: 12
};

/* game.js:1619 · var roll = Math.random() * 12 */
var EXPECTED_WEIGHT_TOTAL = 12;

var EXPECTED_COUNTS = { resources: 29, buildings: 18, recipes: 10, npcs: 6 };

/* --- 极简断言器 ------------------------------------------------------- */

var results = [];
var failures = 0;
var current = null;

function group(title, detail) {
  current = { title: title, detail: detail, checks: [], failed: 0 };
  results.push(current);
}
function check(name, ok, actualText) {
  current.checks.push({ name: name, ok: !!ok, actual: ok ? null : actualText });
  if (!ok) { current.failed++; failures++; }
}
function eq(name, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, '实际 ' + a + ' / 期望 ' + e);
}
function show(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
}
function deepClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/* 逐字段 diff：把 expected 的每个键摊平成路径，逐个和 actual 比。
 * 这样失败信息能精确指到「哪一条的哪个字段」，而不是只说数组不等。 */
function diffPaths(actual, expected, prefix) {
  var out = [], key, pathText;
  for (key in expected) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) continue;
    pathText = prefix ? prefix + '.' + key : key;
    var e = expected[key], a = actual === null || actual === undefined ? undefined : actual[key];
    if (e && typeof e === 'object' && !Array.isArray(e)) {
      if (!a || typeof a !== 'object') {
        out.push({ path: pathText, actual: show(a), expected: show(e) });
        continue;
      }
      out = out.concat(diffPaths(a, e, pathText));
    } else if (JSON.stringify(a) !== JSON.stringify(e)) {
      out.push({ path: pathText, actual: show(a), expected: show(e) });
    }
  }
  return out;
}

function printReport() {
  var total = 0;
  results.forEach(function (r) { total += r.checks.length; });
  results.forEach(function (r) {
    var tag = r.failed === 0 ? 'PASS' : 'FAIL';
    console.log('');
    console.log('[' + tag + '] ' + r.title + (r.detail ? '  ' + r.detail : ''));
    r.checks.forEach(function (c) {
      console.log('       ' + (c.ok ? 'ok   ' : 'FAIL ') + c.name + (c.ok ? '' : '  ->  ' + c.actual));
    });
  });
  console.log('');
  console.log('------------------------------------------------------------');
  console.log('共 ' + total + ' 项断言，通过 ' + (total - failures) + ' 项，失败 ' + failures + ' 项');
  console.log(failures === 0 ? '结论：全部通过' : '结论：存在不一致，见上面的 FAIL 行');
  return failures === 0;
}

/* --- 0. 加载 ---------------------------------------------------------- */

group('0 · 模块加载', 'game-data.js 可加载且 EMBEDDED 非空');
check('加载即就绪（不需要先 init）', GD.info().ready === true, show(GD.info()));
check('数据来源为内联 EMBEDDED', GD.info().source === 'embedded', show(GD.info().source));
eq('EMBEDDED 覆盖四张表', GD.info().embeddedTables.slice().sort(), ['buildings', 'npcs', 'recipes', 'resources']);
var initResult = GD.init();
check('init() 返回 ok:true', initResult.ok === true, show(initResult.problems));

/* 内联数据是空的就没什么可测的了。此时后面的断言会抛出难以理解的 TypeError，
 * 不如就地报清楚：最常见的原因是改了 data/*.json 却忘了跑 node build-inline.js。 */
if (!GD.resources().length || !GD.buildings().length || !GD.recipes().length || !GD.npcs().length) {
  group('致命 · 内联数据缺失', 'game-data.js 的 EMBEDDED 区块是空的');
  check('EMBEDDED 含四张表（若是空的，请先运行 node build-inline.js）', false,
    'resources=' + GD.resources().length + ' buildings=' + GD.buildings().length +
    ' recipes=' + GD.recipes().length + ' npcs=' + GD.npcs().length);
  console.log('漂流小镇 · 数据表接入层验收测试（node test-data.js）');
  printReport();
  process.exitCode = 1;
  return;
}

/* --- 1. 四张表能正确加载 ---------------------------------------------- */

group('1 · 四张表加载', '结构 / 条目数 / 索引 / 引用完整');
eq('resources 条目数', GD.resources().length, EXPECTED_COUNTS.resources);
eq('buildings 条目数', GD.buildings().length, EXPECTED_COUNTS.buildings);
eq('recipes 条目数', GD.recipes().length, EXPECTED_COUNTS.recipes);
eq('npcs 条目数', GD.npcs().length, EXPECTED_COUNTS.npcs);

['resources', 'buildings', 'recipes', 'npcs'].forEach(function (name) {
  var meta = GD.tableMeta(name);
  var titleText = function () { return meta ? meta.title : null; };
  check(name + ' 表头可读（' + titleText() + '）',
    !!meta && meta.version === 1 && typeof meta.schema === 'string' && meta.count > 0,
    show(meta));
});
eq('pickupKindsForGame() 条数', GD.pickupKindsForGame().length, 7);
eq('buildingSpecsForGame() 条数', GD.buildingSpecsForGame().length, 6);
eq('survivalStepsForGame() 条数', GD.survivalStepsForGame().length, 6);

/* 查询接口：按 id 取到的必须是同一份数据 */
eq('resourceById("plasticBottle").name', (GD.resourceById('plasticBottle') || {}).name, '塑料瓶');
eq('resourceById("不存在的id")', GD.resourceById('不存在的id'), null);
eq('buildingById("windmill").name', (GD.buildingById('windmill') || {}).name, '风车');
eq('npcById("laochen").name', (GD.npcById('laochen') || {}).name, '老陈');
eq('recipeById("seaweedRoll").name', (GD.recipeById('seaweedRoll') || {}).name, '海藻卷');

/* 返回的是副本：改它不能污染真相来源 */
var mutated = GD.resources();
mutated[0].spawnWeight = 999;
eq('resources() 返回副本（改副本不影响源）', GD.resources()[0].spawnWeight, 2.6);

/* 引用完整性：菜谱食材、建筑前置、生存步骤前置都指向存在的 id */
var resIds = {}, bldIds = {};
GD.resources().forEach(function (i) { resIds[i.id] = true; });
GD.buildings().forEach(function (i) { bldIds[i.id] = true; });
var badRefs = [];
GD.recipes().forEach(function (r) {
  Object.keys(r.ingredients || {}).forEach(function (k) {
    if (!resIds[k]) badRefs.push('recipes.' + r.id + '.ingredients.' + k);
  });
});
GD.buildings().forEach(function (b) {
  (b.prereq || []).forEach(function (p) {
    if (p.indexOf(':') >= 0) return;
    if (!bldIds[p]) badRefs.push('buildings.' + b.id + '.prereq.' + p);
  });
});
eq('跨表引用无悬空 id', badRefs, []);

/* --- 2. PICKUP_KINDS 逐字段相等 -------------------------------------- */

group('2 · pickupKindsForGame() vs game.js PICKUP_KINDS', '7 条 · value/res/name 逐字段');
var kinds = GD.pickupKindsForGame();
eq('条数一致', kinds.length, EXPECTED_PICKUP_KINDS.length);
if (kinds.length === EXPECTED_PICKUP_KINDS.length) {
  EXPECTED_PICKUP_KINDS.forEach(function (expected, i) {
    var actual = kinds[i];
    var diffs = diffPaths(actual, {
      name: expected.name, value: expected.value, res: expected.res
    }, '');
    var label = '[' + i + '] ' + expected.name;
    check(label + ' · name/value/res 与 game.js 逐字段相等',
      diffs.length === 0,
      diffs.map(function (d) { return d.path + ' 实际 ' + d.actual + ' 期望 ' + d.expected; }).join('; '));
    /* 视觉数据：数据表只有颜色与图标，模型键要靠 modelKey 映射 */
    check(label + ' · glowColor = "' + expected.glow + '"', actual.glowColor === expected.glow, show(actual.glowColor));
    check(label + ' · modelKey = "' + expected.modelKey + '"', actual.modelKey === expected.modelKey, show(actual.modelKey));
    /* 顺序一致：game.js 的 addPickup 按区间取 PICKUP_KINDS[i]，顺序错了掉落比例就错 */
    check(label + ' · 位于 PICKUP_KINDS[' + expected.index + ']（id=' + expected.id + '）',
      actual.id === expected.id, show(actual.id));
  });
  /* 区间自洽：spawnFrom 必须等于前面所有条目 spawnWeight 的前缀和。
   * 这样 game.js 既可以直接用 spawnFrom <= roll < spawnTo 抽样，
   * 也可以照原样保留 if 链——每种物品的区间宽度都等于它自己的权重。 */
  var prefixOk = true, cursor = 0;
  kinds.forEach(function (k) {
    if (Math.abs(k.spawnFrom - cursor) > 1e-9) prefixOk = false;
    if (Math.abs((k.spawnTo - k.spawnFrom) - k.spawnWeight) > 1e-9) prefixOk = false;
    cursor = Math.round((cursor + k.spawnWeight) * 10000) / 10000;
  });
  check('spawnFrom/spawnTo 为权重前缀和、宽度 = 自身 spawnWeight（可直接用于加权抽样）',
    prefixOk, show(kinds.map(function (k) { return [k.id, k.spawnFrom, k.spawnTo]; })));
}

/* --- 3. BUILDING_SPECS 逐字段相等 ------------------------------------ */

group('3 · buildingSpecsForGame() vs game.js BUILDING_SPECS', '6 条 · cost/pop/perk/desc 逐字段');
var specs = GD.buildingSpecsForGame();
eq('条数一致', specs.length, EXPECTED_BUILDING_SPECS.length);
if (specs.length === EXPECTED_BUILDING_SPECS.length) {
  EXPECTED_BUILDING_SPECS.forEach(function (expected, i) {
    var actual = specs[i];
    var diffs = diffPaths(actual, {
      name: expected.name, cost: expected.cost, pop: expected.pop,
      perk: expected.perk, desc: expected.desc
    }, '');
    check('[' + i + '] ' + expected.name + ' · cost/pop/perk/desc 与 game.js 逐字段相等',
      diffs.length === 0,
      diffs.map(function (d) { return d.path + ' 实际 ' + d.actual + ' 期望 ' + d.expected; }).join('; '));
    check('[' + i + '] ' + expected.name + ' · 位于 BUILDING_SPECS[' + i + ']（id=' + expected.id + '）',
      actual.id === expected.id, show(actual.id));
  });
}

/* 附加：生存层 6 步造价与速率（game.js DEFAULTS.survival） */
group('3b · 生存层 vs game.js DEFAULTS.survival', '6 条造价 + 6 个速率');
var costs = GD.survivalCostsForGame();
Object.keys(EXPECTED_SURVIVAL_COSTS).forEach(function (id) {
  eq('survival.' + id + '.cost', costs[id], EXPECTED_SURVIVAL_COSTS[id]);
});
eq('survival 速率常量', GD.survivalRatesForGame(), EXPECTED_SURVIVAL_RATES);

/* --- 4. spawnWeight 之和 = 12 ---------------------------------------- */

group('4 · 海面刷新池权重', 'game.js: Math.random() * 12');
var weightSum = 0;
kinds.forEach(function (k) { weightSum += k.spawnWeight; });
eq('7 条 spawnWeight 之和', Math.round(weightSum * 10000) / 10000, EXPECTED_WEIGHT_TOTAL);
eq('spawnWeightTotal() 与逐项求和一致', GD.spawnWeightTotal(), EXPECTED_WEIGHT_TOTAL);
/* 权重口径来自 resources.json 的 basePool（进基础刷新池的 7 条） */
var basePool = GD.surfaceResources({ implementedOnly: true });
eq('basePool 条目数 = 7', basePool.length, 7);
var basePoolSum = 0;
basePool.forEach(function (i) { basePoolSum += i.spawnWeight; });
eq('basePool 条目权重之和', Math.round(basePoolSum * 10000) / 10000, EXPECTED_WEIGHT_TOTAL);

/* --- 5. validate() 返回 ok:true -------------------------------------- */

group('5 · validate()', '结构 + 枚举 + 引用 + 转换产物自检');
var v = GD.validate();
check('validate().ok === true', v.ok === true, (v.problems || []).join(' | '));
eq('validate().problems 为空', v.problems, []);
check('validate() 的 warnings 全部是已知的「未实现条目」提示',
  (v.warnings || []).every(function (w) { return w.indexOf('尚未在 game.js 实现') >= 0; }),
  show(v.warnings));

/* 反证：喂一份坏数据，确认 validate 真的会报错。
 * 没有这一段，一个「永远返回 ok:true」的实现也能通过第 5 项验收。 */
var realResources = deepClone(GD.resources());
var realBuildings = deepClone(GD.buildings());

var badWeight = deepClone(realResources);
badWeight[0].spawnWeight = 3.6; /* 塑料瓶 2.6 -> 3.6，权重和变成 13 */
var r1 = GD.reload({ resources: { schema: 'drift-town.resources', version: 1, items: badWeight } });
GD.reload(); /* 立刻恢复内联数据，别让后面的断言读到坏表 */
check('反证 · 权重和不为 12 时 validate 报 ok:false 并指出权重',
  r1.ok === false && r1.problems.some(function (p) { return p.indexOf('权重之和') >= 0; }),
  show(r1.problems));

var badYield = deepClone(realResources);
badYield[1].yield = { unsupportedKey: 1 }; /* 非法 yield 键，且抽掉了 metal */
var r2 = GD.reload({ resources: { schema: 'drift-town.resources', version: 1, items: badYield } });
GD.reload();
check('反证 · yield 键不在 enums.yieldKeys 内时 validate 报 ok:false',
  r2.ok === false && r2.problems.some(function (p) { return p.indexOf('enums.yieldKeys') >= 0; }),
  show(r2.problems));

var badCost = deepClone(realBuildings);
badCost.filter(function (b) { return b.id === 'cabin'; })[0].cost = { wood: 4, plastic: 0 }; /* 少 metal 键 */
var r3 = GD.reload({ buildings: { schema: 'drift-town.buildings', version: 1, buildings: badCost } });
GD.reload();
check('反证 · 建筑造价缺 metal 键时 validate 报 ok:false（game.js 会算出 NaN）',
  r3.ok === false && r3.problems.some(function (p) { return p.indexOf('cost.metal') >= 0; }),
  show(r3.problems));

var badIndex = deepClone(realResources);
badIndex[0].gameBinding.pickupKindIndex = 1; /* 与易拉罐撞下标 */
var r4 = GD.reload({ resources: { schema: 'drift-town.resources', version: 1, items: badIndex } });
GD.reload();
check('反证 · gameBinding 下标重复时 validate 报 ok:false',
  r4.ok === false && r4.problems.some(function (p) { return p.indexOf('pickupKindIndex') >= 0; }),
  show(r4.problems));

/* 收尾：恢复正式数据并再确认一次 */
var restored = GD.reload();
check('reload() 恢复内联数据后重新 ok:true', restored.ok === true, show(restored.problems));
eq('恢复后 pickupKinds 仍是 7 条', GD.pickupKindsForGame().length, 7);

/* --- 6. game.js 的加载契约 ------------------------------------------- */

group('6 · 微信小游戏运行约束', '无 Node / 文件 / 网络 / DOM 依赖');
var source = fs.readFileSync(path.join(ROOT, 'game-data.js'), 'utf8');
/* 去掉注释再扫描，避免把本段说明文字本身当成违规 */
var code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
var forbidden = [
  { pattern: /\brequire\s*\(/, label: 'require(' },
  { pattern: /\bconst\s+fs\b|\bimport\s+fs\b/, label: 'fs' },
  { pattern: /\bprocess\s*\.\s*(env|argv|cwd|exit)/, label: 'process.*' },
  { pattern: /\bfetch\s*\(/, label: 'fetch(' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bdocument\s*\./, label: 'document.' },
  { pattern: /\blocalStorage\b/, label: 'localStorage' },
  { pattern: /\bwindow\s*\.\s*(addEventListener|location|navigator)/, label: 'window.*' },
  { pattern: /\beval\s*\(/, label: 'eval(' },
  { pattern: /\bnew\s+Function\b/, label: 'new Function' }
];
forbidden.forEach(function (f) {
  var m = f.pattern.exec(code);
  check('源码不含 ' + f.label, m === null, m ? '命中：' + m[0] : '');
});
/* 全局只挂一个 GameData，不污染其它命名 */
check('导出接口齐全（init/reload/查询/转换/validate）',
  ['init', 'reload', 'resources', 'resourceById', 'buildings', 'buildingById',
    'recipes', 'npcs', 'pickupKindsForGame', 'buildingSpecsForGame', 'validate']
    .every(function (k) { return typeof GD[k] === 'function'; }),
  show(Object.keys(GD)));

/* --- 7. 体积（微信主包 4 MB 上限） ----------------------------------- */

group('7 · 体积评估', '微信小游戏主包上限 4.00 MB');
var moduleBytes = Buffer.byteLength(source, 'utf8');
var tableBytes = 0;
['resources', 'buildings', 'recipes', 'npcs'].forEach(function (name) {
  tableBytes += fs.statSync(path.join(ROOT, 'data', name + '.json')).size;
});
check('game-data.js < 100 KB（实际 ' + (moduleBytes / 1024).toFixed(1) + ' KB）', moduleBytes < 100 * 1024, moduleBytes + ' bytes');
check('内联后小于四张表原文（省掉空白）', moduleBytes - 30000 < tableBytes,
  'game-data.js ' + moduleBytes + ' / data ' + tableBytes);
var budget = 4 * 1024 * 1024;
var used = budget * 0.21;
check('加入后主包占用约 ' + ((used + moduleBytes) / budget * 100).toFixed(1) + '%（< 4.00 MB）',
  used + moduleBytes < budget, '超限');

/* --- 输出 ------------------------------------------------------------- */

console.log('漂流小镇 · 数据表接入层验收测试（node test-data.js）');
console.log('目标：drift-town/game-data.js   数据：drift-town/data/*.json');
var passed = printReport();
process.exitCode = passed ? 0 : 1;
