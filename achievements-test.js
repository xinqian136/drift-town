#!/usr/bin/env node
/* 漂流小镇 · 成就系统 + 排行榜 验收测试 achievements-test.js
 * ===========================================================================
 * 只跑 node，不联网、不依赖测试框架：
 *   node achievements-test.js
 *
 * 覆盖任务书要求的 5 项验收：
 *   1. 至少 5 个不同的 gameState 快照（空状态 / 新手 / 中期 / 全解锁 / 畸形数据）
 *   2. 所有成就的 check/progress 对每个快照都不抛异常，返回值形状合法
 *   3. 成就判定正确（逐条断言「这个快照应该解锁哪些、不该解锁哪些」）
 *   4. 进度计算正确（0-100，且 pct 与 check 口径一致）
 *   5. 排行榜排序正确（含分数 / 进度完全相同时的并列与跳号）
 *
 * 期望值为什么是手写的常量，而不是从 achievements.js 里读出来自证：
 *   如果「期望 == 被测模块自己算出来的东西」，那测试永远绿，等于没测。
 *   所以 EXPECT_* 是照着 game.js 的 __gameState() 手抄的独立副本，任何一侧
 *   改动都会让测试红。
 * ---------------------------------------------------------------------------
 */
'use strict';

var path = require('path');

var ROOT = __dirname;
var Achievements = require(path.join(ROOT, 'achievements.js'));
var Leaderboard = require(path.join(ROOT, 'leaderboard.js'));

/* === 0. 极简断言器 =================================================== */

var results = [];
var failures = 0;
var current = null;

function group(name) {
  current = { name: name, asserts: 0, fails: [] };
  results.push(current);
}

function ok(cond, msg, detail) {
  current.asserts++;
  if (!cond) {
    failures++;
    current.fails.push(msg + (detail !== undefined ? '  [' + detail + ']' : ''));
  }
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function eqJSON(actual, expected, msg) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, msg, 'actual=' + a + ' expected=' + b);
}

function noThrow(fn, msg) {
  try { fn(); ok(true, msg); return true; }
  catch (e) { ok(false, msg + ' → 抛出：' + (e && e.message)); return false; }
}

/* 每次跑测试前清掉存档，避免上一轮残留影响判定。
 * 注意：achievements.js 在没有 localStorage 时用内存兜底，node 里就是这种情况，
 * 所以 _resetAll() 足以保证干净的起点。 */
function resetAll() {
  Achievements._resetAll();
  Leaderboard._resetLocal();
}

/* === 1. gameState 快照（手写，形状严格照 game.js 的 __gameState()） ===
 *
 * 字段清单来自 game.js:6497-6531（读代码时逐字段抄下来的），故意不多不少。
 * 每个快照都带一句「这是模拟什么阶段」的注释。
 * ------------------------------------------------------------------- */

/* --- 快照 A：空状态 / 标题页。全部是初始值，什么都没做。 --- */
var SNAP_EMPTY = {
  phase: 'title', paused: false, score: 0, best: 0, target: 26,
  buildings: 0, town: 0, townTarget: 6, combo: 0, dashCd: 0,
  time: 240, hearts: 4, shield: 0,
  water: 100, maxWater: 100, pop: 0,
  food: 100, maxFood: 100, hungerOn: false,
  survival: [], next: 'workbench', offerable: ['workbench'],
  buildBtnVisible: false, buildOpen: false,
  diveBtnVisible: false, manageBtnVisible: false, manageOpen: false,
  shipParts: [], castaways: [], recruited: [], recruitAvailable: false,
  docked: false, fishReady: false, fishTimer: 0,
  dockBtnVisible: false, fishBtnVisible: false,
  diveExitVisible: false, diveExitBanner: 0,
  canOpenBuild: true, selfSustain: 0, townReady: false,
  diving: false, divePhase: null, diveState: null,
  offer: null,
  zone: { x: 14.2, z: -9.7, r: 6 },
  hero: { x: 0, y: 0 },
  pickups: [], enemies: [],
  fps: 60, renderer: 'webgl', heroMode: 'voxel',
  world: { size: 'infinite', chunk: 12, chunksLoaded: 9 },
  heroOnScreen: true
};

/* --- 快照 B：新手。刚捞了几件、造出工作台，正在攒庇护所。 --- */
var SNAP_NEWBIE = {
  phase: 'playing', paused: false, score: 9, best: 0, target: 26,
  buildings: 0, town: 0, townTarget: 6, combo: 2, dashCd: 0.4,
  time: 205.5, hearts: 4, shield: 0,
  water: 78, maxWater: 100, pop: 0,
  food: 100, maxFood: 100, hungerOn: false,
  survival: ['workbench'], next: 'shelter', offerable: ['shelter'],
  buildBtnVisible: true, buildOpen: false,
  diveBtnVisible: true, manageBtnVisible: true, manageOpen: false,
  shipParts: ['工作台'], castaways: [], recruited: [], recruitAvailable: false,
  docked: false, fishReady: false, fishTimer: 0,
  dockBtnVisible: true, fishBtnVisible: false,
  diveExitVisible: false, diveExitBanner: 0,
  canOpenBuild: true, selfSustain: 0, townReady: false,
  diving: false, divePhase: null, diveState: null,
  offer: null,
  zone: { x: 14.2, z: -9.7, r: 6 },
  hero: { x: -3.4, y: 1.2 },
  pickups: [{ x: 2, y: 3, kind: '塑料瓶' }, { x: -5, y: 0.5, kind: '易拉罐' }],
  enemies: [{ x: 12, y: -7 }],
  fps: 58, renderer: 'webgl', heroMode: 'voxel',
  world: { size: 'infinite', chunk: 12, chunksLoaded: 12 },
  heroOnScreen: true
};

/* --- 快照 C：中期。生存装备齐了、造了 4 座城镇建筑、招了 3 个人、下潜过。 --- */
var SNAP_MID = {
  phase: 'playing', paused: false, score: 128, best: 96, target: 26,
  buildings: 4, town: 5, townTarget: 6, combo: 6, dashCd: 0,
  time: 152.3, hearts: 3, shield: 2.1,
  water: 64, maxWater: 125, pop: 6,
  food: 47, maxFood: 100, hungerOn: true,
  survival: ['workbench', 'shelter', 'rainCatcher', 'fishBasket', 'scoopNet', 'purifier'],
  next: null, offerable: [],
  buildBtnVisible: true, buildOpen: false,
  diveBtnVisible: true, manageBtnVisible: true, manageOpen: false,
  shipParts: ['工作台', '庇护所', '集雨器', '鱼篓', '捞网', '净水器', '小屋', '水塔', '温室', '灯塔'],
  castaways: [{ name: '莉莉', perk: '垃圾分值 +1' }],
  recruited: ['老陈', '阿海', '小满'],
  recruitAvailable: true,
  docked: true, fishReady: false, fishTimer: 1.4,
  dockBtnVisible: true, fishBtnVisible: true,
  diveExitVisible: false, diveExitBanner: 0,
  canOpenBuild: true, selfSustain: 12.4, townReady: true,
  diving: false, divePhase: null,
  diveState: { phase: 'settled', oxygen: 21, depth: 2, collected: 6, totalValue: 34 },
  offer: null,
  zone: { x: 14.2, z: -9.7, r: 6 },
  hero: { x: 14.6, y: -9.1 },   // 在巡逻区里
  pickups: [{ x: 1, y: 1, kind: '木箱' }],
  enemies: [{ x: 12, y: -7 }],
  fps: 55, renderer: 'webgl', heroMode: 'voxel',
  world: { size: 'infinite', chunk: 12, chunksLoaded: 14 },
  heroOnScreen: true
};

/* --- 快照 D：全解锁。6 座建筑齐、5 人全招、满血、深潜 3 层带 7 件。 --- */
var SNAP_MAX = {
  phase: 'won', paused: false, score: 412, best: 412, target: 26,
  buildings: 6, town: 7, townTarget: 6, combo: 14, dashCd: 0,
  time: 3.1, hearts: 5, shield: 0,
  water: 100, maxWater: 125, pop: 9,
  food: 88, maxFood: 100, hungerOn: true,
  survival: ['workbench', 'shelter', 'rainCatcher', 'fishBasket', 'scoopNet', 'purifier'],
  next: null, offerable: [],
  buildBtnVisible: true, buildOpen: false,
  diveBtnVisible: true, manageBtnVisible: true, manageOpen: false,
  shipParts: ['工作台', '庇护所', '集雨器', '鱼篓', '捞网', '净水器',
              '小屋', '水塔', '温室', '灯塔', '市集', '风车'],
  castaways: [],
  recruited: ['老陈', '阿海', '小满', '铁匠波', '莉莉'],
  recruitAvailable: false,
  docked: true, fishReady: false, fishTimer: 0,
  dockBtnVisible: true, fishBtnVisible: true,
  diveExitVisible: false, diveExitBanner: 0,
  canOpenBuild: true, selfSustain: 60, townReady: true,
  diving: false, divePhase: null,
  diveState: { phase: 'settled', oxygen: 4, depth: 3, collected: 7, totalValue: 61 },
  offer: null,
  zone: { x: 14.2, z: -9.7, r: 6 },
  hero: { x: -2, y: 8 },
  pickups: [], enemies: [],
  fps: 61, renderer: 'webgl', heroMode: 'voxel',
  world: { size: 'infinite', chunk: 12, chunksLoaded: 16 },
  heroOnScreen: true
};

/* --- 快照 E：畸形数据。字段类型全错、该有的没有、数组里塞垃圾。
 *     这是最重要的一个：它证明所有成就的 check/progress 都不会抛异常。 --- */
var SNAP_MALFORMED = {
  phase: 42,                        // 应该是 string
  paused: 'yes', score: NaN,        // 应该是 number
  best: 'high', target: null,
  buildings: 'six',                 // 应该是 number
  town: undefined, townTarget: {} , combo: 'lots', dashCd: -1,
  time: Infinity, hearts: null, shield: 'shield',
  water: 'full', maxWater: 0,
  pop: [], food: {}, maxFood: 'x', hungerOn: 1,
  survival: [null, undefined, 7, { id: 'workbench' }, 'shelter', 'bogusId'],
  next: 99, offerable: 'none',
  buildBtnVisible: 'true', buildOpen: 0,
  diveBtnVisible: [], manageBtnVisible: {}, manageOpen: null,
  shipParts: 'parts',
  castaways: [null, {}],
  recruited: [null, {}, 'x', 5],     // 混了垃圾
  recruitAvailable: 'maybe',
  docked: 'no', fishReady: 'yes', fishTimer: {},
  dockBtnVisible: 1, fishBtnVisible: 0,
  diveExitVisible: null, diveExitBanner: 'long',
  canOpenBuild: 'function', selfSustain: 'forever', townReady: 'yes',
  diving: 'true', divePhase: 3,
  diveState: { phase: 1, oxygen: 'low', depth: 'deep', collected: 'many', totalValue: [] },
  offer: 'x',
  zone: [],                         // 应该是 object
  hero: null,
  pickups: 'a,b,c', enemies: {},
  fps: 'fast', renderer: null, heroMode: 7,
  world: null, heroOnScreen: 'maybe'
};

/* --- 快照 F：极端值。数值巨大 / 负数 / 超长数组，测试上限与钳制。
 *     额外要求：不存在的字段一个都没有（只有 3 个字段）。 --- */
var SNAP_EXTREME = {
  score: 999999999,
  survival: ['workbench', 'shelter', 'rainCatcher', 'fishBasket', 'scoopNet',
             'purifier', 'workbench', 'shelter'],   // 重复项不能重复计数
  selfSustain: 1e9
};

var SNAPSHOTS = [
  { name: 'A 空状态（标题页）', state: SNAP_EMPTY },
  { name: 'B 新手（刚造工作台）', state: SNAP_NEWBIE },
  { name: 'C 中期（装备齐/4 建筑/3 招募）', state: SNAP_MID },
  { name: 'D 全解锁（6 建筑/5 招募/深潜）', state: SNAP_MAX },
  { name: 'E 畸形数据（类型全错）', state: SNAP_MALFORMED },
  { name: 'F 极端值（巨数/重复/仅 3 字段）', state: SNAP_EXTREME }
];

/* === 2. 测试 1：定义与结构 =========================================== */

(function testDefinitions() {
  group('1. 成就定义与结构');

  var list = Achievements.list();
  ok(list.length >= 15, '成就总数 ≥ 15', '实际 ' + list.length);
  eq(list.length, 21, '成就总数恰为 21（本版本）');

  // id 唯一
  var seen = {};
  var dup = [];
  list.forEach(function (a) {
    if (seen[a.id]) dup.push(a.id);
    seen[a.id] = 1;
  });
  eq(dup.length, 0, '成就 id 无重复', dup.join(','));

  // 五个类别都要有
  var cats = {};
  list.forEach(function (a) { cats[a.category] = (cats[a.category] || 0) + 1; });
  ['打捞', '建造', '生存', '社交', '探索'].forEach(function (c) {
    ok((cats[c] || 0) >= 1, '类别「' + c + '」至少有 1 个成就', '实际 ' + (cats[c] || 0));
  });

  // 每个成就字段完整
  var bad = [];
  Achievements.ACHIEVEMENTS.forEach(function (a) {
    if (typeof a.id !== 'string' || !a.id) bad.push('id');
    if (typeof a.name !== 'string' || !a.name) bad.push(a.id + '.name');
    if (typeof a.desc !== 'string' || !a.desc) bad.push(a.id + '.desc');
    if (typeof a.check !== 'function') bad.push(a.id + '.check');
    if (typeof a.progress !== 'function') bad.push(a.id + '.progress');
    if (typeof a.hidden !== 'boolean') bad.push(a.id + '.hidden');
  });
  eq(bad.length, 0, '每个成就的 id/name/desc/check/progress/hidden 都合法', bad.join(','));

  // 不能有彩色 emoji（微信 Canvas 会渲染成方块）
  var emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  var withEmoji = list.filter(function (a) { return emojiRe.test(a.name + a.desc); });
  eq(withEmoji.length, 0, '成就文案不含彩色 emoji',
     withEmoji.map(function (a) { return a.id; }).join(','));

  // 任务书点名的类别覆盖情况：打捞 4 项 / 建造 3 项 / 生存 2 项 / 社交 2 项 / 探索 3 项
  eq(cats['打捞'], 5, '打捞类 5 个（首次/50/200/连击10/得分300）');
  eq(cats['建造'], 5, '建造类 5 个');
  eq(cats['生存'], 4, '生存类 4 个');
  eq(cats['社交'], 3, '社交类 3 个');
  eq(cats['探索'], 4, '探索类 4 个');

  // 任务书点名的成就 id 必须都在
  var required = ['salvage_first', 'salvage_50', 'salvage_200', 'combo_10',
                  'build_workbench', 'build_shelter', 'build_all_survival',
                  'survive_selfsustain', 'social_first', 'social_all',
                  'explore_dive_first', 'explore_dive_loot', 'explore_dive_deep'];
  var missing = required.filter(function (id) { return !Achievements.byId(id); });
  eq(missing.length, 0, '任务书点名的 13 个成就 id 都存在', missing.join(','));
})();

/* === 3. 测试 2：防御性（不抛异常 + 返回值形状） ======================= */

(function testDefensive() {
  group('2. 防御性：所有 check/progress 对 6 个快照都不抛异常');

  var stats = Achievements._getStats();
  var problems = [];
  var checked = 0;

  SNAPSHOTS.forEach(function (snap) {
    Achievements.ACHIEVEMENTS.forEach(function (a) {
      // check
      checked++;
      var c;
      try { c = a.check(snap.state, stats); }
      catch (e) { problems.push(snap.name + ' · ' + a.id + '.check 抛出：' + e.message); return; }
      if (typeof c !== 'boolean') {
        problems.push(snap.name + ' · ' + a.id + '.check 返回 ' + typeof c + '（应为 boolean）');
      }

      // progress
      var p;
      try { p = a.progress(snap.state, stats); }
      catch (e) { problems.push(snap.name + ' · ' + a.id + '.progress 抛出：' + e.message); return; }
      if (!p || typeof p !== 'object') {
        problems.push(snap.name + ' · ' + a.id + '.progress 返回非对象');
        return;
      }
      if (typeof p.current !== 'number' || !isFinite(p.current)) {
        problems.push(snap.name + ' · ' + a.id + '.progress.current 非法：' + p.current);
      }
      if (typeof p.target !== 'number' || !isFinite(p.target)) {
        problems.push(snap.name + ' · ' + a.id + '.progress.target 非法：' + p.target);
      }
      if (typeof p.pct !== 'number' || !isFinite(p.pct) || p.pct < 0 || p.pct > 100) {
        problems.push(snap.name + ' · ' + a.id + '.progress.pct 越界：' + p.pct);
      }
    });
  });

  eq(problems.length, 0, '6 快照 × 21 成就 的 check+progress 全部无异常且形状合法',
     problems.slice(0, 5).join(' | '));
  ok(checked >= 126, '至少执行了 126 次 check', '实际 ' + checked);

  // 额外：null / undefined / 原始值 也不能抛
  var weird = [null, undefined, 0, '', 'str', true, [], function () {}];
  var weirdProblems = [];
  weird.forEach(function (w, wi) {
    Achievements.ACHIEVEMENTS.forEach(function (a) {
      try {
        var c = a.check(w, stats);
        if (typeof c !== 'boolean') weirdProblems.push('第' + wi + '个 · ' + a.id + '.check 返回非 boolean');
      } catch (e) { weirdProblems.push('第' + wi + '个 · ' + a.id + '.check 抛出'); }
      try {
        var p = a.progress(w, stats);
        if (!p || typeof p.pct !== 'number') weirdProblems.push('第' + wi + '个 · ' + a.id + '.progress 形状不对');
      } catch (e) { weirdProblems.push('第' + wi + '个 · ' + a.id + '.progress 抛出'); }
    });
  });
  eq(weirdProblems.length, 0, 'null/undefined/0/""/true/[]/function 作为 state 也不抛',
     weirdProblems.slice(0, 5).join(' | '));

  // progressOf 对未知 id 也不抛
  noThrow(function () { Achievements.progressOf('不存在的成就', SNAP_MID); }, 'progressOf(未知 id) 不抛');
  var unknownP = Achievements.progressOf('不存在的成就', SNAP_MID);
  eq(unknownP.unknown, true, 'progressOf(未知 id) 标记 unknown:true');
  noThrow(function () { Achievements.progressOf(null, null); }, 'progressOf(null,null) 不抛');

  // selfTest 自身必须通过
  var st = Achievements.selfTest();
  eq(st.passed, true, 'Achievements.selfTest() 通过', (st.problems || []).join(' | '));
})();

/* === 4. 测试 3：判定正确性（逐条断言「该解锁 / 不该解锁」） ========== */

(function testJudgement() {
  group('3. 成就判定正确性（每个快照应该解锁哪些）');

  var stats = Achievements._getStats();

  /* 辅助：在给定快照下，哪些成就 check 为 true */
  function checksFor(state) {
    var out = {};
    Achievements.ACHIEVEMENTS.forEach(function (a) {
      var v = false;
      try { v = a.check(state, stats) === true; } catch (e) { v = false; }
      if (v) out[a.id] = true;
    });
    return out;
  }

  /* --- 快照 A：空状态。除了「构造上就为真」的，什么都不该解锁 --- */
  var A = checksFor(SNAP_EMPTY);
  eq(A['salvage_first'], undefined, 'A 空状态：未解锁「第一件漂流物」');
  eq(A['build_workbench'], undefined, 'A 空状态：未解锁「动手的人」');
  eq(A['survive_town_ready'], undefined, 'A 空状态：未解锁「可以建立城镇了」');
  eq(A['explore_dive_first'], undefined, 'A 空状态：未解锁「第一次下潜」');
  eq(Object.keys(A).length, 0, 'A 空状态：一个成就都不解锁', Object.keys(A).join(','));

  /* --- 快照 B：新手。只解锁「动手的人」（造了工作台） --- */
  var B = checksFor(SNAP_NEWBIE);
  eq(B['build_workbench'], true, 'B 新手：解锁「动手的人」（survival 含 workbench）');
  eq(B['build_shelter'], undefined, 'B 新手：未解锁「有了个家」');
  eq(B['salvage_first'], undefined, 'B 新手：未解锁「第一件漂流物」（stats.salvaged=0）');
  eq(B['combo_10'], undefined, 'B 新手：连击 2 未达 10');
  eq(B['explore_dive_first'], undefined, 'B 新手：还没下潜');

  /* --- 快照 C：中期 --- */
  var C = checksFor(SNAP_MID);
  eq(C['build_workbench'], true, 'C 中期：工作台');
  eq(C['build_shelter'], true, 'C 中期：庇护所');
  eq(C['build_all_survival'], true, 'C 中期：6 件生存装备齐');
  eq(C['survive_town_ready'], true, 'C 中期：townReady=true');
  eq(C['survive_selfsustain'], true, 'C 中期：selfSustain=12.4 > 0');
  eq(C['explore_dive_deep'], undefined, 'C 中期：最深只到第 2 层，未解锁「深海来客」');
  eq(C['build_town_4'], undefined, 'C 中期：本局 4 座建筑，但 stats.bestTown 还没被 tick 记账');

  /* --- 快照 D：全解锁 --- */
  var D = checksFor(SNAP_MAX);
  eq(D['build_workbench'], true, 'D 全解锁：工作台');
  eq(D['build_shelter'], true, 'D 全解锁：庇护所');
  eq(D['build_all_survival'], true, 'D 全解锁：生存装备齐');
  eq(D['survive_selfsustain'], true, 'D 全解锁：自持');
  eq(D['survive_town_ready'], true, 'D 全解锁：城镇已解锁');
  eq(D['explore_dive_deep'], true, 'D 全解锁：diveState.depth=3 达深水层');

  /* --- 快照 E：畸形数据。全部 check 必须返回 false（不能误判解锁） ---
   *     例外：没有任何一项应该在畸形输入下被判定为 true。 */
  var E = checksFor(SNAP_MALFORMED);
  /* survival 数组里有 {id:'workbench'}，这个是合法条目，会被识别 → 允许 true。
   * 除此之外的「build_shelter」也来自同一个数组里的 'shelter'，同样合法。 */
  var allowedInE = { build_workbench: true, build_shelter: true };
  var unexpectedE = Object.keys(E).filter(function (id) { return !allowedInE[id]; });
  eq(unexpectedE.length, 0, 'E 畸形数据：只识别出数组里合法的 workbench/shelter，其余不误判',
     unexpectedE.join(','));
  eq(E['survive_town_ready'], undefined, 'E 畸形数据：townReady="yes"（字符串）不算 true');
  eq(E['explore_dive_deep'], undefined, 'E 畸形数据：diveState.depth="deep" 不算到达深水层');
  eq(E['social_all'], undefined, 'E 畸形数据：recruited 混垃圾不会凑满 5 人');

  /* --- 快照 F：极端值。重复项不重复计数、巨数被钳制 --- */
  var F = checksFor(SNAP_EXTREME);
  eq(F['build_all_survival'], true, 'F 极端值：6 件（含重复）算齐');
  eq(F['survive_town_ready'], undefined, 'F 极端值：townReady 缺失 → 不解锁城镇');
  var pWorkbench = Achievements.progressOf('build_all_survival', SNAP_EXTREME);
  eq(pWorkbench.current, 6, 'F 极端值：重复的 survival 项不被重复计数（仍是 6）');
  eq(pWorkbench.pct, 100, 'F 极端值：6/6 = 100%');
})();

/* === 5. 测试 4：进度计算口径 ========================================= */

(function testProgress() {
  group('4. 进度计算正确（0-100，且与 check 口径一致）');

  var stats = Achievements._getStats();

  /* 4.1 所有成就的 pct 都在 [0,100] 且是整数 */
  var bad = [];
  SNAPSHOTS.forEach(function (snap) {
    Achievements.ACHIEVEMENTS.forEach(function (a) {
      var p = a.progress(snap.state, stats);
      if (!(p.pct >= 0 && p.pct <= 100)) bad.push(a.id + '@' + snap.name + '=' + p.pct);
      if (Math.round(p.pct) !== p.pct) bad.push(a.id + ' 不是整数：' + p.pct);
    });
  });
  eq(bad.length, 0, '所有 pct 都是 0-100 的整数', bad.slice(0, 5).join(','));

  /* 4.2 progressOf 的 pct 与 progress().pct 一致 */
  var mismatch = [];
  SNAPSHOTS.forEach(function (snap) {
    Achievements.ACHIEVEMENTS.forEach(function (a) {
      var direct = a.progress(snap.state, stats).pct;
      var viaApi = Achievements.progressOf(a.id, snap.state).pct;
      if (valclamp(direct) !== viaApi) mismatch.push(a.id + ' direct=' + direct + ' api=' + viaApi);
    });
  });
  function valcclamp(v) { return Math.max(0, Math.min(100, v)); }
  function valclamp(v) { return Math.max(0, Math.min(100, v)); }
  eq(mismatch.length, 0, 'progressOf().pct 与 progress().pct 一致', mismatch.slice(0, 5).join(' | '));

  /* 4.3 「pct===100 等价于 check===true」—— 这是最重要的口径一致性检查。
   *     只对「阈值型」成就检查：有 current/target 的单调累计类。
   *     pct 恒为 100 的（target<=0）与布尔型跳过。 */
  var inconsistent = [];
  var examined = 0;
  SNAPSHOTS.forEach(function (snap) {
    Achievements.ACHIEVEMENTS.forEach(function (a) {
      var p = a.progress(snap.state, stats);
      if (!(p.target > 0)) return;            // 跳过布尔型 / 无目标型
      examined++;
      var c = a.check(snap.state, stats) === true;
      var at100 = p.pct === 100;
      if (at100 !== c) {
        inconsistent.push(a.id + '@' + snap.name + ' pct=' + p.pct + ' check=' + c);
      }
    });
  });
  ok(examined >= 60, '有足够多元检查（≥60 次）', '实际 ' + examined);
  eq(inconsistent.length, 0,
     '对阈值型成就：pct===100 与 check===true 完全等价', inconsistent.slice(0, 5).join(' | '));

  /* 4.4 具体数值抽查（手算的期望值） */
  // build_all_survival：C 快照 6 件 / 目标 6 → 100%
  eq(Achievements.progressOf('build_all_survival', SNAP_MID).current, 6, 'C：生存装备 6 件');
  eq(Achievements.progressOf('build_all_survival', SNAP_MID).pct, 100, 'C：6/6 = 100%');
  // B 快照只有 1 件 → 1/6 = 16.67% → 四舍五入 17%
  eq(Achievements.progressOf('build_all_survival', SNAP_NEWBIE).current, 1, 'B：生存装备 1 件');
  eq(Achievements.progressOf('build_all_survival', SNAP_NEWBIE).pct, 17, 'B：1/6 四舍五入为 17%');
  // A 快照 0 件
  eq(Achievements.progressOf('build_all_survival', SNAP_EMPTY).pct, 0, 'A：0/6 = 0%');
  // survive_town_ready：C 快照 townReady → 60/60 = 100%
  eq(Achievements.progressOf('survive_town_ready', SNAP_MID).pct, 100, 'C：townReady → 100%');
  // selfSustain 12.4 / 60 → 20.67% → 21%
  eq(Achievements.progressOf('survive_town_ready', SNAP_MID).current, 60,
     'C：townReady 时 current 直接顶到 60');
  // B 快照 selfSustain=0 → 0%
  eq(Achievements.progressOf('survive_town_ready', SNAP_NEWBIE).pct, 0, 'B：自持 0/60 = 0%');
  // explore_dive_deep：D 快照 depth 3 / 目标 3 = 100%
  eq(Achievements.progressOf('explore_dive_deep', SNAP_MAX).pct, 100, 'D：第 3 层 = 100%');
  // C 快照 depth 2 / 3 = 66.67% → 67%
  eq(Achievements.progressOf('explore_dive_deep', SNAP_MID).pct, 67, 'C：第 2/3 层 = 67%');
  // explore_dive_loot：D 快照 7 件 / 目标 5 → 封顶 100%
  eq(Achievements.progressOf('explore_dive_loot', SNAP_MID).pct, 100,
     'C：带回 6 件已超过目标 5 → 100%（不溢出）');

  /* 4.5 隐藏成就在未解锁时不给描述（不剧透） */
  var rows = Achievements.panelRows(SNAP_MAX);
  var hiddenRows = rows.filter(function (r) { return r.hidden; });
  ok(hiddenRows.length >= 1, '至少有 1 个隐藏成就', '实际 ' + hiddenRows.length);
  resetAll();
  var rowsFresh = Achievements.panelRows(SNAP_MID);
  var hiddenFresh = rowsFresh.filter(function (r) { return r.hidden; });
  var hiddenLeak = hiddenFresh.filter(function (r) { return r.desc !== '隐藏成就'; });
  eq(hiddenLeak.length, 0, '未解锁的隐藏成就描述显示为「隐藏成就」',
     hiddenLeak.map(function (r) { return r.id; }).join(','));
})();

/* === 6. 测试 5：tick 累积与解锁流程 ================================== */

(function testTick() {
  group('5. tick 累积 / 解锁队列 / 幂等性');

  resetAll();

  eq(Achievements.unlockedCount(), 0, '清档后已解锁 0 个');
  eq(Achievements.overallProgress(), 0, '清档后总进度 0%');

  // 第一次 tick：空状态，不应解锁任何东西
  var newly1 = Achievements.tick(SNAP_EMPTY, 0.016);
  eq(newly1.length, 0, '空状态 tick 不解锁任何成就');

  // 幂等性：同一份快照连喂 5 次，只应记录 1 次打捞事件（score 9 → 上涨一次）
  // 这里用 SNAP_NEWBIE（score=9）
  var before = Achievements._getStats().salvaged;
  for (var i = 0; i < 5; i++) Achievements.tick(SNAP_NEWBIE, 0.016);
  var after = Achievements._getStats().salvaged;
  eq(after - before, 1, '同一份快照重复喂 5 次，只计 1 次打捞事件（幂等）',
     'before=' + before + ' after=' + after);
  ok(after >= 1, 'tick 后累计打捞 ≥ 1');
  ok(Achievements._unlockedMap()['salvage_first'] !== undefined,
     '累计打捞 ≥1 →「第一件漂流物」已解锁');

  // score 继续上涨 → 继续计数
  var upd = Object.assign({}, SNAP_NEWBIE, { score: 15 });
  for (var j = 0; j < 3; j++) Achievements.tick(upd, 0.016);
  var after2 = Achievements._getStats().salvaged;
  ok(after2 > after, 'score 上涨后累计打捞继续增加', after + ' → ' + after2);

  // 重开（score 回落）后水位线跟着回落，下一步上涨能正确计数
  var restart = Object.assign({}, SNAP_NEWBIE, { score: 0, phase: 'playing' });
  Achievements.tick(restart, 0.016);
  Achievements.tick(Object.assign({}, restart, { score: 4 }), 0.016);
  var after3 = Achievements._getStats().salvaged;
  eq(after3, after2 + 1, '重开后 score 从 0 涨到 4 只计 1 次（水位线正确回落）',
     'after2=' + after2 + ' after3=' + after3);

  // 潜水：开始 → 记录次数
  var divesBefore = Achievements._getStats().divesStarted;
  Achievements.tick(Object.assign({}, SNAP_MID, { diving: true, diveState: { phase: 'diving', depth: 2, collected: 3 } }), 0.016);
  eq(Achievements._getStats().divesStarted, divesBefore + 1, '开始潜水 → divesStarted +1');
  eq(Achievements._unlockedMap()['explore_dive_first'] !== undefined, true,
     '首次潜水 →「第一次下潜」已解锁');
  // 同一趟潜水继续 tick 不重复计数
  Achievements.tick(Object.assign({}, SNAP_MID, { diving: true, diveState: { phase: 'diving', depth: 2, collected: 5 } }), 0.016);
  eq(Achievements._getStats().divesStarted, divesBefore + 1, '同一趟潜水不重复计 divesStarted');
  // 结束潜水 → 本轮收获入账
  Achievements.tick(Object.assign({}, SNAP_MID, { diving: false, diveState: null }), 0.016);
  eq(Achievements._getStats().bestDiveLoot, 5, '潜水结束记下本次带 5 件');
  eq(Achievements._unlockedMap()['explore_dive_loot'] !== undefined, true,
     '带回 5 件 →「论筐称重」已解锁');

  // 深水层
  Achievements.tick(Object.assign({}, SNAP_MAX, { diving: true, diveState: { phase: 'diving', depth: 3, collected: 1 } }), 0.016);
  eq(Achievements._getStats().deepestLayer, 3, '最深到达第 3 层');
  eq(Achievements._unlockedMap()['explore_dive_deep'] !== undefined, true,
     '到达第 3 层 →「深海来客」已解锁');

  // 巡逻区：从外进入只计一次
  var zoneBefore = Achievements._getStats().zoneVisits;
  Achievements.tick(SNAP_MID, 0.016);          // hero 在区内
  eq(Achievements._getStats().zoneVisits, zoneBefore + 1, '进入巡逻区 +1');
  Achievements.tick(SNAP_MID, 0.016);          // 仍在区内
  eq(Achievements._getStats().zoneVisits, zoneBefore + 1, '一直待在区内不重复计数');
  Achievements.tick(Object.assign({}, SNAP_MID, { hero: { x: -30, y: -30 } }), 0.016); // 出去
  Achievements.tick(SNAP_MID, 0.016);          // 再进来
  eq(Achievements._getStats().zoneVisits, zoneBefore + 2, '出去再进来 → 再 +1');
  eq(Achievements._unlockedMap()['explore_zone'] !== undefined, true,
     '进入过巡逻区 →「闯进鲨鱼的地盘」已解锁');

  // note() 精确计数
  resetAll();
  Achievements.note({ picked: 3 });
  eq(Achievements._getStats().salvaged, 3, 'note({picked:3}) → 累计 3 件');
  Achievements.note({ picked: 2 });
  eq(Achievements._getStats().salvaged, 5, 'note({picked:2}) → 累计 5 件');
  Achievements.note({ fished: 1 });
  eq(Achievements._getStats().fishCaught, 1, 'note({fished:1}) → 钓鱼 1 次');
  eq(Achievements._unlockedMap()['social_fish'] !== undefined, true, '钓到鱼 →「钓上一条」已解锁');

  /* pieces 口径：给的是「本局累计件数」，按水位线增量记账，所以幂等。
   * 上面已经 picked 到 5，本局水位线也是 5。 */
  Achievements.note({ pieces: 10 });
  eq(Achievements._getStats().salvaged, 10, 'note({pieces:10})：本局 5 → 10，累计补 5 到 10');
  Achievements.note({ pieces: 10 });
  eq(Achievements._getStats().salvaged, 10, 'note({pieces:10}) 重复调用不重复计数（幂等）');
  Achievements.note({ pieces: 12 });
  eq(Achievements._getStats().salvaged, 12, 'note({pieces:12})：增量 2 被正确累加');

  // 解锁队列与提示
  resetAll();
  Achievements.note({ picked: 1 });
  var t1 = Achievements.nextToast();
  ok(!!t1, '解锁后有排队中的提示可弹');
  ok(Achievements.activeToast() !== null, 'nextToast 之后 activeToast 有值');
  Achievements.updateToast(99);
  eq(Achievements.activeToast(), null, '提示超时后自动消失');
  var t2 = Achievements.nextToast();
  ok(t2 === null || !!t2, '队列空了之后 nextToast 返回 null 而不是抛异常');

  // 持久化：save 再 load，已解锁状态还在
  resetAll();
  Achievements.note({ picked: 1 });
  var unlockedBefore = Object.keys(Achievements._unlockedMap());
  Achievements.save();
  Achievements.load();
  var unlockedAfter = Object.keys(Achievements._unlockedMap());
  eqJSON(unlockedAfter.sort(), unlockedBefore.sort(), '存档后重新 load，已解锁成就保持一致');
})();

/* === 7. 测试 6：排行榜排序 =========================================== */

(function testLeaderboardOrder() {
  group('6. 排行榜排序（含完成相同 / 全同的并列与跳号）');

  /* 6.1 主键顺序：建造进度 > 成就进度 > 分数 > 时间 > id */
  var list = [
    { playerId: 'p_low',  nickname: '低建',  buildProgress: 10, achievementProgress: 90, score: 900, at: 100 },
    { playerId: 'p_high', nickname: '高建',  buildProgress: 90, achievementProgress: 10, score: 100, at: 100 },
    { playerId: 'p_mid',  nickname: '中建',  buildProgress: 50, achievementProgress: 50, score: 500, at: 100 }
  ];
  var ranked = Leaderboard.rank(list);
  eqJSON(ranked.map(function (r) { return r.playerId; }),
         ['p_high', 'p_mid', 'p_low'],
         '按建造进度降序：90 > 50 > 10');
  eqJSON(ranked.map(function (r) { return r.rank; }), [1, 2, 3], '名次 1,2,3');

  /* 6.2 建造相同时看成就进度 */
  var tie1 = Leaderboard.rank([
    { playerId: 'a', buildProgress: 50, achievementProgress: 30, score: 0, at: 1 },
    { playerId: 'b', buildProgress: 50, achievementProgress: 70, score: 0, at: 1 }
  ]);
  eq(tie1[0].playerId, 'b', '建造相同 → 成就进度高的排前面（70 > 30）');

  /* 6.3 建造与成就都相同 → 看分数 */
  var tie2 = Leaderboard.rank([
    { playerId: 'a', buildProgress: 50, achievementProgress: 50, score: 100, at: 1 },
    { playerId: 'b', buildProgress: 50, achievementProgress: 50, score: 300, at: 1 }
  ]);
  eq(tie2[0].playerId, 'b', '建造与成就都相同 → 分数高的排前面（300 > 100）');

  /* 6.4 前三项全同 → 先达成的（at 小）排前面 */
  var tie3 = Leaderboard.rank([
    { playerId: 'late',  buildProgress: 50, achievementProgress: 50, score: 100, at: 200 },
    { playerId: 'early', buildProgress: 50, achievementProgress: 50, score: 100, at: 100 }
  ]);
  eq(tie3[0].playerId, 'early', '前三项全同 → 提交时间早的排前面');
  eq(tie3[0].rank, 1, '先达成的名次 1');
  eq(tie3[1].rank, 1, '后来但四项全同 → 并列名次 1');

  /* 6.5 ⭐ 关键：四项完全相同 → 并列同名次，下一名跳号（1,1,3 不是 1,1,2） */
  var dupList = [
    { playerId: 'x', buildProgress: 80, achievementProgress: 60, score: 500, at: 100 },
    { playerId: 'y', buildProgress: 80, achievementProgress: 60, score: 500, at: 100 },
    { playerId: 'z', buildProgress: 40, achievementProgress: 30, score: 200, at: 100 },
    { playerId: 'w', buildProgress: 20, achievementProgress: 10, score: 100, at: 100 }
  ];
  var dupRanked = Leaderboard.rank(dupList);
  eqJSON(dupRanked.map(function (r) { return r.rank; }), [1, 1, 3, 4],
         '两项完全并列 → 名次 1,1,3,4（并列后跳号）');
  eq(dupRanked[0].playerId !== dupRanked[1].playerId, true, '并列的两条是不同玩家');

  /* 6.6 三项并列 */
  var three = Leaderboard.rank([
    { playerId: 'a', buildProgress: 10, achievementProgress: 10, score: 10, at: 5 },
    { playerId: 'b', buildProgress: 10, achievementProgress: 10, score: 10, at: 5 },
    { playerId: 'c', buildProgress: 10, achievementProgress: 10, score: 10, at: 5 },
    { playerId: 'd', buildProgress: 1, achievementProgress: 1, score: 1, at: 5 }
  ]);
  eqJSON(three.map(function (r) { return r.rank; }), [1, 1, 1, 4],
         '三项全并列 → 名次 1,1,1,4');

  /* 6.7 幂等 / 确定性：同一输入两次排序结果完全一样 */
  var r1 = JSON.stringify(Leaderboard.rank(dupList));
  var r2 = JSON.stringify(Leaderboard.rank(dupList));
  eq(r1, r2, '同一输入排序两次结果完全一致（确定性排序，不是随机抖动）');

  /* 6.8 rank 不修改入参 */
  var orig = [{ playerId: 'q', buildProgress: 7 }];
  var origCopy = JSON.stringify(orig);
  Leaderboard.rank(orig);
  eq(JSON.stringify(orig), origCopy, 'rank() 不修改入参数组');

  /* 6.9 畸形记录不会把排序搞崩 */
  var messy = Leaderboard.rank([
    null, undefined, {},
    { playerId: 'ok', buildProgress: 70, achievementProgress: 40, score: 10, at: 1 },
    { buildProgress: 'abc', achievementProgress: NaN, score: 'x', at: -99 },
    { buildProgress: 999, achievementProgress: -50, score: Infinity, at: 'later' }
  ]);
  eq(messy.length, 6, '畸形记录全部被保留（规整后）');
  var outOfRange = messy.filter(function (r) {
    return r.buildProgress < 0 || r.buildProgress > 100
        || r.achievementProgress < 0 || r.achievementProgress > 100
        || r.score < 0 || !isFinite(r.score);
  });
  eq(outOfRange.length, 0, '所有 record 的 buildProgress/achievementProgress/score 被钳制到合法范围');
  var rankMono = messy.every(function (r, i) { return i === 0 || r.rank >= messy[i - 1].rank; });
  eq(rankMono, true, '名次单调不减');

  /* 6.10 rankBy 支持按成就 / 分数排序 */
  var byAch = Leaderboard.rankBy(list, 'achievement');
  eq(byAch[0].playerId, 'p_low', '按成就进度排序：90% 的排第一');
  var byScore = Leaderboard.rankBy(list, 'score');
  eq(byScore[0].playerId, 'p_low', '按分数排序：900 分的排第一');
})();

/* === 8. 测试 7：排行榜能力边界（真能用 vs 需后端） =================== */

(function testLeaderboardCapability() {
  group('7. 排行榜能力边界（真实性声明）');

  /* 这一组是异步的（fetchServerTop / fetchFriends 返回 Promise），
   * 所以整条链登记到 trackAsync，报告会等它跑完再出。 */
  var asyncChain = (function () {
  /* 7.1 本地榜：真能用，同步返回，且明确标注「不是全服」 */
  Leaderboard._resetLocal();
  var myId = Leaderboard.myPlayerId();
  Leaderboard._setRecords([
    { playerId: myId, nickname: '我', buildProgress: 50, achievementProgress: 40, score: 120, at: 1000 },
    { playerId: 'other', nickname: '别人', buildProgress: 80, achievementProgress: 60, score: 300, at: 1100 }
  ]);
  var local = Leaderboard.fetchTop(10);
  eq(local.ok, true, '本地榜 ok:true（真能用）');
  eq(local.source, 'local', 'source = local');
  eq(local.real, true, '本地榜 real:true');
  eq(local.backendRequired, false, '本地榜不需要后端');
  ok(local.label.indexOf('本地') >= 0, 'label 里明确写了「本地」', local.label);
  ok(local.label.indexOf('全服') >= 0 || local.label.indexOf('不是全服') >= 0,
     'label 里明确否认这是全服排行', local.label);
  eq(local.items.length, 2, '返回 2 条');
  eq(local.items[0].playerId, 'other', '建造进度高的排第一');
  ok(local.me !== null, 'fetchTop 返回 me（我在榜上的条目）');
  eq(local.me.playerId, myId, 'me.playerId 就是本地玩家 id');

  /* 7.2 我的最好成绩 */
  var mine = Leaderboard.myBest('build');
  ok(mine !== null, '能查到「我」的记录');
  eq(mine.playerId, Leaderboard.myPlayerId(), 'myBest 返回的正是本地玩家 id');

  /* 7.3 全服榜：明确不可用，绝不返回伪造数据 */
  Leaderboard.fetchServerTop(10).then(function (server) {
    eq(server.ok, false, '全服榜 ok:false（不可用）');
    eq(server.unavailable, true, '全服榜 unavailable:true');
    eq(server.real, false, '全服榜 real:false（不谎称真实）');
    eq(server.backendRequired, true, '全服榜 backendRequired:true');
    eq(server.reason, 'no-backend', '全服榜原因 no-backend');
    eq(server.items.length, 0, '全服榜不返回任何条目（不伪造数据）');
    eq(server.total, 0, '全服榜 total 为 0');
    ok(typeof server.note === 'string' && server.note.indexOf('后端') >= 0,
       '全服榜说明里明确写了需要后端', String(server.note).slice(0, 40));

    /* 7.4 好友榜：node 环境不是微信 → 明确说 not-wechat，不返回假好友 */
    return Leaderboard.fetchFriends();
  }).then(function (friends) {
    eq(friends.ok, false, 'node 环境好友榜 ok:false');
    eq(friends.unavailable, true, '好友榜 unavailable:true');
    eq(friends.reason, 'not-wechat', '好友榜原因 not-wechat');
    eq(friends.items.length, 0, '好友榜不编造好友条目');
    ok(friends.setup && Array.isArray(friends.setup.items) && friends.setup.items.length >= 5,
       '好友榜给出 ≥5 条配置指引', friends.setup ? friends.setup.items.length : 0);
    ok(typeof friends.note === 'string' && friends.note.length > 0, '好友榜有说明文案');

    /* 7.5 wxCapability 在 node 里正确报告「不是微信」 */
    var caps = Leaderboard.wxCapability();
    eq(caps.hasWx, false, 'wxCapability 正确识别非微信环境');
    eq(caps.openDataUsable, false, 'openDataUsable = false');
    eq(caps.platform, 'not-wechat', 'platform = not-wechat');

    /* 7.6 friendsSetup 的判定文案 */
    var setup = Leaderboard.friendsSetup();
    eq(setup.ok, false, 'friendsSetup.ok = false（环境不具备）');
    ok(setup.verdict.indexOf('不是微信') >= 0 || setup.verdict.indexOf('Web') >= 0,
       'friendsSetup.verdict 说明了原因', setup.verdict);

    /* 7.7 伪造的微信环境：验证特性检测 + 解析路径（用假的 wx 对象）
     *     这不是在假装能用——是为了证明「有 wx 时会走对分支」。 */
    var fakeCalled = false;
    global.wx = {
      getFriendCloudStorage: function (opt) {
        fakeCalled = true;
        // 扮演两个好友：一个有我们的 key，一个没有（应被 skipped）
        opt.success({
          data: [
            { openid: 'o1', nickname: '好友甲', avatarUrl: 'http://x/a.png',
              KVDataList: [{ key: 'drifttown', value: JSON.stringify({ score: 500, buildProgress: 80, achievementProgress: 60, townCount: 5, at: 900 }) }] },
            { openid: 'o2', nickname: '好友乙', avatarUrl: '',
              KVDataList: [{ key: 'drifttown', value: JSON.stringify({ score: 100, buildProgress: 20, achievementProgress: 10, townCount: 1, at: 800 }) }] },
            { openid: 'o3', nickname: '没玩过', avatarUrl: '', KVDataList: [] }
          ]
        });
      },
      setUserCloudStorage: function (opt) {
        if (opt && typeof opt.success === 'function') opt.success();
      },
      getOpenDataContext: function () { return {}; },
      getSystemInfoSync: function () { return { platform: 'android' }; }
    };

    var capsWx = Leaderboard.wxCapability();
    eq(capsWx.hasWx, true, '伪造 wx 后 hasWx = true');
    eq(capsWx.openDataUsable, true, '伪造 wx 后 openDataUsable = true');
    eq(capsWx.platform, 'android', 'platform 从 getSystemInfoSync 读到 android');

    // 解析好友数据（纯函数）
    var parsed = Leaderboard.parseFriendData({
      data: [
        { openid: 'o1', nickname: '好友甲',
          KVDataList: [{ key: 'drifttown', value: JSON.stringify({ score: 500, buildProgress: 80, achievementProgress: 60, townCount: 5, at: 900 }) }] },
        { openid: 'o2', nickname: '好友乙',
          KVDataList: [{ key: 'drifttown', value: JSON.stringify({ score: 100, buildProgress: 20, achievementProgress: 10, townCount: 1, at: 800 }) }] },
        { openid: 'o3', nickname: '没玩过', KVDataList: [] }
      ]
    });
    eq(parsed.ok, true, 'parseFriendData ok:true');
    eq(parsed.source, 'friend', 'source = friend');
    eq(parsed.items.length, 2, '3 个好友里只有 2 个有我们的数据（1 个被 skipped）');
    eq(parsed.skipped, 1, 'skipped = 1（没写过云存储的好友）');
    eq(parsed.items[0].nickname, '好友甲', '建造进度 80% 的好友甲排第一');
    eq(parsed.items[2], undefined, '只有 2 条，没有第 3 条');
    eq(parsed.emptyIsNormal, false, '有数据时 emptyIsNormal = false');
    eqJSON(parsed.items.map(function (r) { return r.rank; }), [1, 2], '好友榜名次 1,2');
    ok(parsed.label.indexOf('微信好友') >= 0, 'label 明确写「微信好友排行」', parsed.label);

    // 空好友列表 → emptyIsNormal 为 true（要当正常情况处理）
    var emptyParsed = Leaderboard.parseFriendData({ data: [] });
    eq(emptyParsed.items.length, 0, '空好友列表 → 0 条');
    eq(emptyParsed.emptyIsNormal, true, '空好友列表 → emptyIsNormal = true（不是故障）');

    // 走 fetchFriends 的真实分支
    return Leaderboard.fetchFriends().then(function (fr) {
      eq(fakeCalled, true, 'fetchFriends 在微信环境真的调了 wx.getFriendCloudStorage');
      eq(fr.ok, true, 'fetchFriends ok:true（伪造环境）');
      eq(fr.items.length, 2, 'fetchFriends 解析出 2 条');
      eq(fr.source, 'friend', 'source = friend');

      // submitToWxCloud：有 wx.setUserCloudStorage 时应调用并不报 unavailable
      var cloud = Leaderboard.submitToWxCloud(Leaderboard.normalizeRecord({
        playerId: 'me', score: 500, buildProgress: 80, achievementProgress: 60, townCount: 5
      }));
      eq(cloud.unavailable, false, 'submitToWxCloud 在微信环境可用（unavailable:false）');

      // 清理伪造环境
      delete global.wx;
      eq(Leaderboard.wxCapability().hasWx, false, '清理伪造 wx 后恢复 hasWx = false');
    });
  }).catch(function (e) {
    ok(false, '排行榜能力测试抛异常：' + (e && e.message));
  });

  return asyncChain;
  })();
  trackAsync(asyncChain);
})();

/* === 9. 测试 8：submit 上报接口 ====================================== */

(function testSubmit() {
  group('8. submit 上报接口');

  Leaderboard._resetLocal();

  var res = Leaderboard.submit({
    score: 250, buildProgress: 60, achievementProgress: 45, townCount: 4
  });
  eq(res.ok, true, 'submit 返回 ok:true');
  eq(res.localSaved, true, 'submit 写本地成功');
  eq(res.remote.ok, false, 'submit 的远端口 ok:false（没有后端）');
  eq(res.remote.unavailable, true, 'submit 的远端 unavailable:true');
  eq(res.remote.reason, 'no-backend', 'submit 的远端原因 no-backend');
  ok(typeof res.record.playerId === 'string' && res.record.playerId.length > 0,
     'submit 自动补了 playerId', res.record.playerId);
  eq(res.record.score, 250, 'record.score 保留');
  eq(res.record.buildProgress, 60, 'record.buildProgress 保留');

  // 写进去了
  var top = Leaderboard.fetchTop(10);
  eq(top.items.length, 1, '提交后本地榜有 1 条');
  eq(top.items[0].score, 250, '本地榜里分数是 250');

  // 同一时刻重复提交同一条 → 覆盖而不是追加
  var at = res.record.at;
  Leaderboard.submit({ playerId: res.record.playerId, score: 999, buildProgress: 99, at: at });
  var top2 = Leaderboard.fetchTop(10);
  eq(top2.items.length, 1, '同一玩家同一时刻重复提交 → 覆盖，不重复追加');

  // 不写本地
  Leaderboard._resetLocal();
  var res2 = Leaderboard.submit({ score: 10 }, { local: false });
  eq(res2.localSaved, false, 'opts.local=false 时不写本地');
  eq(Leaderboard.fetchTop(10).items.length, 0, '本地榜仍是空的');

  // 远端为无后端时，不会伪装成功
  eq(res2.remote.ok, false, '即使不写本地，远端仍如实报告不可用');

  // recordFromState 能把 gameState 折成一条记录
  var rec = Leaderboard.recordFromState(SNAP_MAX, Achievements);
  eq(rec.townCount, 6, 'recordFromState 从 buildings=6 拿到 townCount=6');
  ok(rec.buildProgress > 0 && rec.buildProgress <= 100, 'recordFromState 算出合法 buildProgress', rec.buildProgress);
  eq(rec.score, 412, 'recordFromState 保留 score');
  // 6 建筑 + 6 生存装备 = 12/12 = 100%
  eq(rec.buildProgress, 100, 'recordFromState：6 建筑 + 6 装备 = 12/12 = 100%');

  // 畸形 state 也不能抛
  noThrow(function () { Leaderboard.recordFromState(null, null); }, 'recordFromState(null,null) 不抛');
  noThrow(function () { Leaderboard.recordFromState(SNAP_MALFORMED, Achievements); },
          'recordFromState(畸形数据) 不抛');
})();

/* === 10. 测试 9：UI 绘制不崩（用桩 ctx） ============================= */

(function testDraw() {
  group('9. Canvas 绘制函数不崩（桩 ctx）');

  /* 一个够用的 Canvas 2D 上下文桩：只实现我们用到的成员。
   * 这不是替代真实渲染，只是证明绘制路径不会因为空值/缺方法而抛异常。 */
  function makeStubCtx() {
    var calls = { fillText: 0, measureText: 0, fill: 0, stroke: 0, save: 0, restore: 0 };
    var ctx = {
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
      textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
      save: function () { calls.save++; },
      restore: function () { calls.restore++; },
      beginPath: function () {}, closePath: function () {},
      moveTo: function () {}, lineTo: function () {}, arcTo: function () {},
      arc: function () {}, rect: function () {}, clip: function () {},
      fill: function () { calls.fill++; },
      stroke: function () { calls.stroke++; },
      fillRect: function () {},
      fillText: function () { calls.fillText++; },
      measureText: function (t) { calls.measureText++; return { width: String(t || '').length * 8 }; },
      createRadialGradient: function () { return { addColorStop: function () {} }; }
    };
    ctx._calls = calls;
    return ctx;
  }

  resetAll();
  Achievements.note({ picked: 200 });   // 解锁一堆成就，让面板有内容

  var ctx = makeStubCtx();

  // 成就面板
  var panel = null;
  noThrow(function () { panel = Achievements.drawPanel(ctx, 390, 844, { font: 16 }); },
          'drawPanel 在 390×844 上不抛');
  ok(panel !== null, 'drawPanel 返回面板矩形');
  ok(panel.w > 0 && panel.h > 0, '面板尺寸为正');
  ok(panel.close && panel.close.w > 0, '面板返回关闭按钮矩形');
  ok(ctx._calls.fillText > 10, '真的画了文字（fillText > 10 次）', ctx._calls.fillText);
  eq(ctx._calls.save, ctx._calls.restore, 'save/restore 配平（没有漏 restore）');

  // 横屏
  noThrow(function () { Achievements.drawPanel(ctx, 960, 540, {}); }, 'drawPanel 横屏不抛');
  // 极端尺寸
  noThrow(function () { Achievements.drawPanel(ctx, 1, 1, {}); }, 'drawPanel 1×1 不抛');
  noThrow(function () { Achievements.drawPanel(ctx, 0, 0, {}); }, 'drawPanel 0×0 不抛');
  noThrow(function () { Achievements.drawPanel(ctx, -10, -10, {}); }, 'drawPanel 负尺寸不抛');
  // 非 ctx
  eq(Achievements.drawPanel(null, 390, 844), null, 'drawPanel(null) 返回 null 不抛');
  eq(Achievements.drawPanel({}, 390, 844), null, 'drawPanel(假对象) 返回 null 不抛');

  // 解锁横幅
  Achievements.showToast({ id: 'x', name: '测试成就', desc: '描述文字' }, 3);
  noThrow(function () { Achievements.drawToast(ctx, 390, 844, {}); }, 'drawToast 不抛');
  noThrow(function () { Achievements.drawToast(ctx, 0, 0, {}); }, 'drawToast 0×0 不抛');
  eq(Achievements.drawToast(null, 390, 844), null, 'drawToast(null ctx) 返回 null');

  // 排行榜三页
  Leaderboard._resetLocal();
  Leaderboard.submit({ score: 300, buildProgress: 70, achievementProgress: 50, townCount: 5 });
  var localData = Leaderboard.fetchTop(10);
  var ui = null;
  noThrow(function () {
    ui = Leaderboard.drawTabbed(ctx, 390, 844, {
      tab: 'local', data: { local: localData }, font: 16
    });
  }, 'drawTabbed(本地榜) 不抛');
  ok(ui !== null, 'drawTabbed 返回热区对象');
  ok(Array.isArray(ui.tabs) && ui.tabs.length === 3, '返回 3 个 tab 热区');
  ok(ui.close && ui.close.w > 0, '返回关闭按钮热区');

  // 全服榜（不可用分支的绘制）
  var serverStub = { ok: false, unavailable: true, source: 'server',
                     label: '全服排行（不可用 · 需要后端服务器）',
                     note: '本项目是纯前端单文件游戏，没有服务器。' };
  noThrow(function () {
    Leaderboard.drawTabbed(ctx, 390, 844, { tab: 'server', data: { server: serverStub } });
  }, 'drawTabbed(全服榜 · 不可用) 不抛');

  // 好友榜空列表分支
  noThrow(function () {
    Leaderboard.drawTabbed(ctx, 390, 844, {
      tab: 'friend',
      data: { friend: { ok: true, source: 'friend', label: '微信好友排行', items: [], emptyIsNormal: true,
                        setup: Leaderboard.friendsSetup() } }
    });
  }, 'drawTabbed(好友榜 · 空列表) 不抛');

  // 缺数据 / 畸形 opts
  noThrow(function () { Leaderboard.drawTabbed(ctx, 390, 844, {}); }, 'drawTabbed(无 data) 不抛');
  noThrow(function () { Leaderboard.drawTabbed(ctx, 390, 844, null); }, 'drawTabbed(null opts) 不抛');
  noThrow(function () {
    Leaderboard.drawTabbed(ctx, 390, 844, { tab: 'local', data: { local: { items: 'not-an-array' } } });
  }, 'drawTabbed(items 非数组) 不抛');
  eq(Leaderboard.drawTabbed(null, 390, 844, {}), null, 'drawTabbed(null ctx) 返回 null');

  // hitTest
  var hit = Leaderboard.hitTest(ui, ui.close.x + 1, ui.close.y + 1);
  eq(hit, 'close', 'hitTest 命中关闭按钮');
  var hitTab = Leaderboard.hitTest(ui, ui.tabs[1].x + 1, ui.tabs[1].y + 1);
  eq(hitTab, 'friend', 'hitTest 命中「好友榜」tab');
  eq(Leaderboard.hitTest(ui, -500, -500), 'outside', 'hitTest 面板外 → outside');
  eq(Leaderboard.hitTest(null, 0, 0), 'outside', 'hitTest(null) → outside 不抛');

  // 排行榜 selfTest
  var lst = Leaderboard.selfTest();
  eq(lst.passed, true, 'Leaderboard.selfTest() 通过', (lst.problems || []).join(' | '));
})();

/* === 11. 无 DOM / 无彩色 emoji 自证 ================================== */

(function testNoDOM() {
  group('10. 无 DOM 依赖 / 无彩色 emoji');

  var fs = require('fs');

  ['achievements.js', 'leaderboard.js'].forEach(function (file) {
    var src = fs.readFileSync(path.join(ROOT, file), 'utf8');

    // 去掉注释和字符串，只看真正的代码，避免注释里提到这些词就误报
    var code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/\/\/[^\n]*/g, '')            // 行注释
      .replace(/'(?:\\.|[^'\\])*'/g, "''")   // 单引号字符串
      .replace(/"(?:\\.|[^"\\])*"/g, '""');  // 双引号字符串

    var domChars = [
      'document', 'createElement', 'querySelector', 'getElementById',
      'innerHTML', 'appendChild', 'addEventListener', 'window.location',
      'XMLHttpRequest', 'fetch(', 'require(', 'import ', 'navigator.'
    ];
    var found = domChars.filter(function (t) { return code.indexOf(t) >= 0; });
    eq(found.length, 0, file + ' 代码里没有 DOM / network / require 调用', found.join(','));

    // 彩色 emoji 检测
    var emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F0FF}]/u;
    ok(!emojiRe.test(src), file + ' 全文不含彩色 emoji');
  });

  // 模块在纯 node（无 window / 无 document）下能正常 require
  ok(typeof Achievements === 'object' && Achievements !== null, 'achievements.js 在 node 下加载成功');
  ok(typeof Leaderboard === 'object' && Leaderboard !== null, 'leaderboard.js 在 node 下加载成功');
  ok(typeof Achievements.tick === 'function', '导出 tick()');
  ok(typeof Achievements.drawPanel === 'function', '导出 drawPanel()');
  ok(typeof Leaderboard.submit === 'function', '导出 submit()');
  ok(typeof Leaderboard.fetchTop === 'function', '导出 fetchTop()');
  ok(typeof Leaderboard.fetchFriends === 'function', '导出 fetchFriends()');
  ok(typeof Leaderboard.drawTabbed === 'function', '导出 drawTabbed()');
})();

/* === 12. 输出报告 =================================================== */

function printReport() {
  var totalAsserts = 0;
  var line = '='.repeat(72);

  console.log(line);
  console.log('漂流小镇 · 成就系统 + 排行榜 · 验收测试');
  console.log('node ' + process.version + '  ·  ' + new Date().toISOString());
  console.log(line);

  results.forEach(function (g) {
    totalAsserts += g.asserts;
    var status = g.fails.length === 0 ? 'PASS' : 'FAIL';
    console.log('[' + status + '] ' + g.name + '  (' + g.asserts + ' 项断言)');
    if (g.fails.length) {
      g.fails.forEach(function (f) { console.log('        × ' + f); });
    }
  });

  console.log(line);
  console.log('断言总数：' + totalAsserts + '   失败：' + failures);
  console.log('成就总数：' + Achievements.list().length + '   快照数：' + SNAPSHOTS.length);

  // 附：成就清单
  console.log('-'.repeat(72));
  console.log('成就清单：');
  var cat = null;
  Achievements.list().forEach(function (a) {
    if (a.category !== cat) { cat = a.category; console.log('  [' + cat + ']'); }
    console.log('    ' + pad(a.id, 24) + pad(a.name, 12) + a.desc + (a.hidden ? '  (隐藏)' : ''));
  });

  console.log('-'.repeat(72));
  console.log('排行榜能力边界：');
  console.log('    本地榜     真能用（本机 localStorage 存档）');
  console.log('    微信好友榜 真能用（需 game.json 声明 openDataContext + 真机登录 + 隐私声明）');
  console.log('    全服榜     做不到（没有后端服务器；接口返回 unavailable，不伪造数据）');

  console.log(line);
  console.log(failures === 0 ? '结果：全部通过' : '结果：有 ' + failures + ' 项失败');
  console.log(line);

  return failures;
}

function pad(str, len) {
  var s = String(str);
  while (s.length < len) s += ' ';
  return s;
}

/* === 12. 等异步断言跑完再出报告 =====================================
 * 第 7 组（排行榜能力边界）里有多段 Promise 链（fetchServerTop / fetchFriends）。
 * 同步的 IIFE 跑完后，那些断言还在微任务队列里。之前用固定 setTimeout(50) 等，
 * 结果报告先出来、异步断言后落地——于是「全部通过」却被 exit code 1 打脸。
 *
 * 正确做法：把所有异步组的 Promise 收集起来，全部 settle 之后再出报告。
 * 这里用一个简单的全局登记表：异步组调用 trackAsync(promise)。 */

function trackAsync(p) {
  if (p && typeof p.then === 'function') _asyncPromises.push(p);
}

var _asyncPromises = [];

/** 把「异步测试组」里的 Promise 链登记进来，报告必须等它们全部结束。 */
function whenAllSettled() {
  return Promise.all(_asyncPromises.map(function (p) {
    return Promise.resolve(p).then(
      function () { return null; },
      function (e) {
        // 异步组自己没 catch 到的异常也要算一次失败，不能静默吞掉
        failures++;
        var g = results[results.length - 1];
        if (g) { g.fails.push('异步断言抛出未捕获异常：' + (e && e.message)); }
        return null;
      }
    );
  }));
}

Promise.resolve()
  .then(whenAllSettled)
  .then(function () {
    var code = printReport();
    process.exit(code === 0 ? 0 : 1);
  })
  .catch(function (e) {
    console.error('测试脚手架自身异常：', e && e.stack);
    process.exit(2);
  });
