/**
 * 漂流小镇 · 登船模式（第三人称船上角色）
 * =============================================================================
 * 这是用户从最开始就要的核心：「进入城镇 = 可以进入船上操控角色（人物）
 * 进行活动（第三人称视角）」，而不是把镜头拉近看甲板。
 *
 * 本模块负责「状态与规则」，不碰渲染：
 *   - 一个可操控的船员角色（位置、朝向、行走、跑动）
 *   - 甲板上的可交互点（寿司店 / 工作台 / 水塔 / 庇护所 / 招募的 NPC）
 *   - 第三人称相机参数（给 game.js 的 placeCamera 用）
 *   - 靠近交互点时的提示文字与按键语义
 *   - 船员踱步巡逻（每人有岗位 + 巡航点，甲板上是活人不是雕塑）
 *   - 交互动作的回执状态（过夜睡多久、寿司店兑换账本 —— game.js 落地动作）
 *
 * 渲染由 game.js 用 three.js 画（体素小人 + 建筑模型），本模块只给数据。
 * 零 DOM / 零网络 / 零 require，window.ShipCrew + module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.ShipCrew = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = '1.1.0';

  /* 甲板上的交互点。坐标是船体局部坐标（与 BUILDING_POS 同一套基准），
   * y 是甲板高度。radius 是可互动距离。 */
  var SPOTS = [
    { id: 'workbench', name: '工作台',   x: 2.6,  z: 6.0,  y: 1.8, radius: 1.6, action: 'build',   hint: '打开建造菜单' },
    { id: 'shelter',   name: '庇护所',   x: -2.6, z: 6.0,  y: 1.8, radius: 1.6, action: 'rest',    hint: '休息存档 · 过夜' },
    { id: 'sushi',     name: '寿司店',   x: 2.2,  z: -1.0, y: 1.8, radius: 1.8, action: 'sushi',   hint: '经营寿司店', needs: 'sushiOpen' },
    { id: 'tower',     name: '水塔',     x: -2.4, z: -2.0, y: 1.8, radius: 1.5, action: 'tower',   hint: '接水 · 供水结算' },
    { id: 'market',    name: '市集',     x: 2.2,  z: -5.0, y: 1.8, radius: 1.6, action: 'market',  hint: '材料兑换' },
    { id: 'dock',      name: '舷梯',     x: 0,    z: 11.0, y: 1.8, radius: 1.8, action: 'dive',    hint: '下潜 / 钓鱼' },
    { id: 'bridge',    name: '船桥',     x: 0,    z: 8.5,  y: 3.6, radius: 1.8, action: 'sail',    hint: '回到航行' }
  ];

  /* 可招募的船员：登船后他们会在甲板上站着/走动，让船上有「人」。
   * 每条带完整外观配色，供程序化角色拼装使用（无外部资产模式）。
   * home：岗位（站在哪）；patrol：踱步巡航点（局部坐标，按甲板缩放）。
   * 不招募时不出现在甲板上；招募后在自己的岗位与巡航点之间踱步。 */
  var CREW_DEFS = [
    { id: 'laochen',   name: '老陈',   color: '#8fb8d8', job: '打捞', x: -1.8, z: 3.2,
      skin: '#d9a97c', hair: '#c8c8c8', hat: '#5a6a78', pants: '#4a5560', shoe: '#3a3a3a',
      patrol: [[-1.8, 3.2], [-2.4, 0.4], [-1.0, 5.2]] },
    { id: 'ahai',      name: '阿海',   color: '#7fd8e8', job: '潜水', x: 1.9,  z: 4.0,
      skin: '#e8c39a', hair: '#2a3a4a', hat: null,      pants: '#3a5a6a', shoe: '#2a3a3a',
      patrol: [[1.9, 4.0], [1.2, 8.2], [2.6, 2.0]] },
    { id: 'xiaoman',   name: '小满',   color: '#e8b87f', job: '寿司', x: 2.2,  z: -1.4,
      skin: '#f0d0aa', hair: '#4a3020', hat: '#e8e0d0', pants: '#7a5a40', shoe: '#5a4030',
      patrol: [[2.2, -1.4], [3.0, -1.8]] },
    { id: 'bo',        name: '铁匠波', color: '#b8a090', job: '建造', x: -2.0, z: -3.4,
      skin: '#c89878', hair: null,      hat: '#6a4a3a', pants: '#5a4a40', shoe: '#3a302a',
      patrol: [[-2.0, -3.4], [-2.6, -6.0], [-1.4, -4.6]] },
    { id: 'lili',      name: '莉莉',   color: '#d8a0c8', job: '买卖', x: 2.4,  z: -5.2,
      skin: '#f5dcc0', hair: '#7a3a5a', hat: null,      pants: '#8a5a7a', shoe: '#6a4050',
      patrol: [[2.4, -5.2], [3.0, -6.4], [1.6, -4.2]] }
  ];

  var state = {
    active: false,           // 是否处于登船模式
    x: 0, z: 9.0,           // 角色在船体局部坐标中的位置（从船尾上船）
    facing: Math.PI,         // 朝向（弧度）
    vx: 0, vz: 0,
    walkT: 0,                // 步态动画相位
    recruited: [],           // 已招募船员 id
    sushiOpen: false,
    nearSpot: null,          // 当前靠近的交互点
    lastAction: null,        // { spot, at }
    deckLen: 13, deckBeam: 4.2,
    deckY: 1.8,              // 甲板局部高度（木筏 0.55 / 大船 1.8）
    scale: 1,                // 坐标缩放 = deckLen / 13，小木筏上所有点收缩到筏面
    /* ---- R3：船员踱步巡逻 ---- */
    patrol: true,            // 船员是否在岗位上踱步
    /* ---- R3：交互动作回执（game.js 消费） ---- */
    sleepUntil: 0,           // 过夜：到这个游戏时刻才醒（由 game.js 推进并读取）
    exchangeLog: [],         // 市集兑换流水（最近 10 条，供 HUD / 测试读取）
    lastSettle: null         // 最近一次水塔供水结算（game.js 填，供 HUD 读）
  };

  /** 把基准坐标（邮轮 13 长 / 4.2 宽）缩放到当前甲板尺寸。 */
  function sx(x) { return x * (state.deckBeam / 4.2); }
  function sz(z) { return z * (state.deckLen / 13); }
  function sy(y) { return state.deckY + (y - 1.8); }   // 保留点间相对高差，整体抬到当前甲板

  /* ==== 开关 ==== */
  function enter(recruitedIds, sushiOpen) {
    state.active = true;
    state.x = 0; state.z = sz(9.0); state.facing = Math.PI;
    state.vx = state.vz = 0; state.walkT = 0;
    state.recruited = (recruitedIds || []).slice();
    state.sushiOpen = !!sushiOpen;
    state.nearSpot = null;
    return true;
  }
  function exit() { state.active = false; state.nearSpot = null; state.lastAction = null; return false; }
  function isActive() { return state.active; }

  /* ==== 移动 ==== */
  /** dir: {x, z} 归一化的摇杆方向（船体局部坐标）。dt 秒。 */
  function move(dir, dt, run) {
    if (!state.active) return;
    var speed = run ? 3.6 : 2.2;
    var dx = (dir.x || 0), dz = (dir.z || 0);
    var len = Math.hypot(dx, dz);
    if (len > 0.001) {
      dx /= len; dz /= len;
      state.vx = dx * speed; state.vz = dz * speed;
      state.facing = Math.atan2(dx, dz);
      state.walkT += dt * (run ? 12 : 8);
    } else {
      state.vx = 0; state.vz = 0;
    }
    state.x += state.vx * dt;
    state.z += state.vz * dt;
    // 限制在甲板范围内（船体椭圆的保守矩形）
    var halfL = state.deckLen * 0.86, halfB = state.deckBeam * 0.78;
    state.x = Math.max(-halfB, Math.min(halfB, state.x));
    state.z = Math.max(-halfL, Math.min(halfL, state.z));
    // 建筑/装备避让：不能走进实体里（这是「穿模、卡在里面」的根因）
    resolveObstacles();
    // 更新靠近的交互点
    state.nearSpot = nearestSpot();
  }

  /** 甲板上的实体障碍（由 game.js 每帧同步进来）：{x,z,r} 圆形碰撞体。 */
  var obstacles = [];
  function setObstacles(list) { obstacles = list || []; }
  var PERSON_RADIUS = 0.34;
  /** 把角色推出所有重叠的圆柱体——用「沿最近方向推出」而不是阻挡，
   *  这样贴着建筑走不会卡死，只会被滑开。船员的踱步也走同一套避让。 */
  function resolveObstacles() {
    for (var iter = 0; iter < 2; iter++) {
      for (var i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        var dx = state.x - o.x, dz = state.z - o.z;
        var d = Math.hypot(dx, dz);
        var minD = (o.r || 0.5) + PERSON_RADIUS;
        if (d < minD && d > 0.0001) {
          var push = (minD - d);
          state.x += (dx / d) * push;
          state.z += (dz / d) * push;
        } else if (d <= 0.0001) {
          state.x += minD;   // 正好重合，随便推一个方向
        }
      }
    }
  }
  function setDeck(deckLen, deckBeam, deckY) {
    state.deckLen = deckLen || state.deckLen;
    state.deckBeam = deckBeam || state.deckBeam;
    if (deckY !== undefined) state.deckY = deckY;
  }

  function nearestSpot() {
    var best = null, bestD = 1e9;
    for (var i = 0; i < SPOTS.length; i++) {
      var s = SPOTS[i];
      if (s.needs === 'sushiOpen' && !state.sushiOpen) continue;
      var d = Math.hypot(state.x - sx(s.x), state.z - sz(s.z));
      if (d < s.radius && d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  /** 按下互动键：返回 { ok, spot, action } 或 { ok:false, reason }。 */
  function interact() {
    if (!state.active) return { ok: false, reason: 'not-onboard' };
    var s = state.nearSpot || nearestSpot();
    if (!s) return { ok: false, reason: 'nothing-nearby' };
    state.lastAction = { spot: s.id, action: s.action, at: Date.now() };
    return { ok: true, spot: s, action: s.action, hint: s.hint };
  }

  /* ==== 船员踱步巡逻（R3） ====
   * 每名船员有自己的运行时状态：位置、朝向、步态相位、巡航索引、
   * 「站一会儿再走」的停顿计时。game.js 每帧调 tickCrew(dt, t) 推进，
   * 再用 crewList() 拿到实时位置去摆 three.js 的小人。 */
  var crewRun = {};   // id -> { x, z, facing, walkT, pi, wait, px, pz }
  function crewRuntime(id, def) {
    var r = crewRun[id];
    if (!r) {
      r = crewRun[id] = {
        x: sx(def.x), z: sz(def.z),
        facing: 0, walkT: 0,
        pi: 0,        // 当前巡航点索引
        wait: 1 + (def.x % 1 + 1) % 1,   // 每人错开，别齐步走
        px: sx(def.x), pz: sz(def.z)
      };
    }
    return r;
  }
  /** 推进所有已招募船员的踱步。t 是游戏内秒（给呼吸浮动用）。
   *  睡觉的船员（sleep 集合内）站着不动，醒来继续巡逻。 */
  function tickCrew(dt, t) {
    if (!state.active || !state.patrol) return;
    for (var i = 0; i < CREW_DEFS.length; i++) {
      var c = CREW_DEFS[i];
      if (state.recruited.indexOf(c.id) < 0) continue;
      var r = crewRuntime(c.id, c);
      // 睡觉（过夜后仍在补眠的船员）：站着，偶尔转身
      if (state.sleepers && state.sleepers[c.id]) {
        r.walkT = 0;
        r.facing += Math.sin((t || 0) * 0.6 + i * 2.1) * 0.002;
        r.px = r.x; r.pz = r.z;
        continue;
      }
      var route = c.patrol || [[c.x, c.z]];
      var target = route[r.pi % route.length];
      var tx = sx(target[0]), tz = sz(target[1]);
      var dx = tx - r.x, dz = tz - r.z;
      var d = Math.hypot(dx, dz);
      var SPEED = 0.75;   // 踱步速度，比玩家慢，只是「活着」
      r.spd = 0;          // 本帧默认没在走（给 game.js 摆腿幅度用）
      if (d < 0.14) {
        // 到点了：站一会儿，下次换一个巡航点
        r.wait -= dt;
        r.px = r.x; r.pz = r.z;
        if (r.wait <= 0) { r.pi = (r.pi + 1) % route.length; r.wait = 1.2 + (i * 0.7); }
      } else {
        r.wait = Math.min(r.wait, 1.2 + (i * 0.7));   // 被打断就重新计时
        var vx = dx / d * SPEED, vz = dz / d * SPEED;
        r.x += vx * dt; r.z += vz * dt;
        r.facing = Math.atan2(vx, vz);
        r.walkT += dt * 7;
        r.spd = SPEED;
        r.px = r.x; r.pz = r.z;
      }
      // 避让障碍与彼此（复用玩家的推出逻辑，借一个临时 state 快照）
      dodgeFor(r, i);
    }
  }
  /** 给单个船员做圆避让：推离障碍物和其他船员。不改玩家自己的 state。 */
  function dodgeFor(r, selfIdx) {
    for (var iter = 0; iter < 2; iter++) {
      for (var i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        var dx = r.x - o.x, dz = r.z - o.z;
        var d = Math.hypot(dx, dz);
        var minD = (o.r || 0.5) + PERSON_RADIUS;
        if (d < minD && d > 0.0001) { var push = minD - d; r.x += dx / d * push; r.z += dz / d * push; }
        else if (d <= 0.0001) { r.x += minD; }
      }
      // 别叠在其他船员身上
      for (var j = 0; j < CREW_DEFS.length; j++) {
        if (j === selfIdx || state.recruited.indexOf(CREW_DEFS[j].id) < 0) continue;
        var o2 = crewRuntime(CREW_DEFS[j].id, CREW_DEFS[j]);
        if (o2 === r) continue;
        var dx2 = r.x - o2.x, dz2 = r.z - o2.z;
        var d2 = Math.hypot(dx2, dz2), minD2 = PERSON_RADIUS * 2.1;
        if (d2 < minD2 && d2 > 0.0001) { var push2 = (minD2 - d2) * 0.5; r.x += dx2 / d2 * push2; r.z += dz2 / d2 * push2; }
        else if (d2 <= 0.0001) { r.x += PERSON_RADIUS; }
      }
      // 别走出甲板
      var halfL = state.deckLen * 0.86, halfB = state.deckBeam * 0.78;
      r.x = Math.max(-halfB, Math.min(halfB, r.x));
      r.z = Math.max(-halfL, Math.min(halfL, r.z));
    }
  }
  function setPatrol(on) { state.patrol = !!on; }

  /* ==== 船员（让船上有人） ==== */
  function crewList() {
    var out = [];
    for (var i = 0; i < CREW_DEFS.length; i++) {
      var c = CREW_DEFS[i];
      if (state.recruited.indexOf(c.id) < 0) continue;
      var r = crewRuntime(c.id, c);
      var asleep = !!(state.sleepers && state.sleepers[c.id]);
      out.push({
        id: c.id, name: c.name, color: c.color, job: c.job,
        skin: c.skin, hair: c.hair, hat: c.hat, pants: c.pants, shoe: c.shoe,
        x: r.x, z: r.z,
        facing: r.facing, walkT: r.walkT,
        moving: (r.spd || 0) > 0, asleep: asleep,
        bob: Math.sin(state.walkT * 0.5 + i) * 0.06
      });
    }
    return out;
  }
  function setRecruited(ids) { state.recruited = (ids || []).slice(); }
  function setSushiOpen(v) { state.sushiOpen = !!v; }

  /* ==== R3：过夜（庇护所） ====
   * game.js 在 doCrewInteract('rest') 时调用 beginSleep(wakeAt)：随机 1-2 名
   * 船员回去补眠；游戏时间推进过 wakeAt 后调 wakeUp() 让他们回岗。
   * 这些只是状态标记，渲染（闭眼/弯腰）由 game.js 决定怎么画。 */
  function beginSleep(wakeAt) {
    state.sleepers = {};
    var ids = state.recruited.slice();
    // 打乱后取 1-2 名去补眠
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    }
    var n = Math.min(ids.length, 1 + Math.floor(Math.random() * 2));
    for (var k = 0; k < n; k++) state.sleepers[ids[k]] = true;
    state.sleepWakeAt = wakeAt || 0;
    return Object.keys(state.sleepers);
  }
  /** 到点叫醒所有补眠船员。返回本此叫醒的 id 数组（空的表示都醒着）。 */
  function wakeUp() {
    if (!state.sleepers) return [];
    var woken = Object.keys(state.sleepers);
    state.sleepers = null;
    state.sleepWakeAt = 0;
    return woken;
  }
  function sleepers() { return state.sleepers ? Object.keys(state.sleepers) : []; }
  /** 游戏时间是否已过叫醒点（game.js 每帧问一次）。 */
  function sleepDue(now) {
    return !!(state.sleepers && state.sleepWakeAt && now >= state.sleepWakeAt);
  }

  /* ==== R3：市集材料兑换（账本记在船员侧，成交由 game.js 落地） ====
   * EXCHANGES 的 cost/yield 键与游戏资源一致（wood/plastic/metal）。
   * rate 由市集建筑等级（tradeBonus）提升：rate = 1 + 0.25 * bonus。 */
  var EXCHANGES = [
    { id: 'wood2plastic', name: '木板换塑板', cost: { wood: 4 },      yield: { plastic: 3 }, trade: 'lili' },
    { id: 'plastic2wood',  name: '塑板换木板', cost: { plastic: 3 },   yield: { wood: 3 },    trade: 'lili' },
    { id: 'wood2metal',    name: '木板换铁料', cost: { wood: 6 },      yield: { metal: 2 },   trade: 'bo' },
    { id: 'metal2wood',    name: '铁料换木板', cost: { metal: 1 },     yield: { wood: 2 },    trade: 'bo' }
  ];
  /** 市集可用的兑换单（含按 tradeBonus 折算后的数量）。bonus 是市集建筑加成。 */
  function exchangeOffers(tradeBonus) {
    var b = Math.max(0, tradeBonus | 0);
    return EXCHANGES.map(function (e) {
      function grow(n) { return Math.max(1, Math.round(n * (1 + 0.25 * b))); }
      var y = {};
      for (var k in e.yield) y[k] = grow(e.yield[k]);
      return { id: e.id, name: e.name, cost: cloneObj(e.cost), yield: y, trade: e.trade };
    });
  }
  /** 记一笔兑换流水（game.js 扣材料成功后调用，供 HUD / 测试核对）。 */
  function logExchange(id, ok, detail) {
    state.exchangeLog.unshift({ id: id, ok: !!ok, detail: detail || '', at: Date.now() });
    if (state.exchangeLog.length > 10) state.exchangeLog.pop();
  }
  function cloneObj(o) {
    var out = {};
    for (var k in o) out[k] = o[k];
    return out;
  }

  /* ==== 第三人称相机 ==== */
  /** 返回第三人称相机相对角色的偏移（世界/船体局部一致）。 */
  function cameraRig() {
    // 相机距离随甲板缩放，小木筏上不会拉太远。
    var back = 6.2 * (state.deckLen / 13) + 2.0;
    var up = 3.1 * (state.deckLen / 13) + 1.0;
    var fx = Math.sin(state.facing), fz = Math.cos(state.facing);
    return {
      x: state.x - fx * back,
      y: up,
      z: state.z - fz * back,
      lookX: state.x + fx * 1.4,
      lookY: state.deckY + 0.2,
      lookZ: state.z + fz * 1.4
    };
  }

  /* ==== 状态快照（给 HUD / 测试） ==== */
  function snapshot() {
    return {
      active: state.active, x: Math.round(state.x * 100) / 100, z: Math.round(state.z * 100) / 100,
      facing: Math.round(state.facing * 100) / 100,
      nearSpot: state.nearSpot ? state.nearSpot.id : null,
      crew: crewList().map(function (c) { return c.id; }),
      sushiOpen: state.sushiOpen,
      patrolling: !!state.patrol && state.active,
      sleepers: sleepers(),
      lastExchange: state.exchangeLog.length ? state.exchangeLog[0] : null
    };
  }

  function selfTest() {
    var problems = [];
    // 结构完整
    for (var i = 0; i < SPOTS.length; i++) {
      var s = SPOTS[i];
      if (!s.id || !s.name || !s.action) problems.push('spot[' + i + '] 字段不全');
      if (!(s.radius > 0)) problems.push(s.id + ' radius 非法');
    }
    // 进入/移动/互动
    try {
      enter(['laochen', 'xiaoman'], true);
      if (!isActive()) problems.push('enter 后 active 应为 true');
      move({ x: 0, z: 0 }, 0.016);
      // 走到寿司店附近
      state.x = 2.2; state.z = -1.0;
      state.nearSpot = nearestSpot();
      if (!state.nearSpot) problems.push('站在寿司店前应检测到交互点');
      var r = interact();
      if (!r.ok || r.action !== 'sushi') problems.push('寿司店互动应返回 action=sushi');
      if (crewList().length !== 2) problems.push('应返回 2 名已招募船员');
      if (cameraRig().y <= 0) problems.push('相机高度应为正');
      // R3：巡逻
      tickCrew(0.5, 1.0);
      var cl = crewList();
      if (!cl[0] || typeof cl[0].x !== 'number') problems.push('crewList 应带实时坐标');
      setPatrol(false);
      tickCrew(0.5, 2.0);
      setPatrol(true);
      // R3：过夜状态
      var slept = beginSleep(100);
      if (!slept.length || slept.length > 2) problems.push('过夜应安排 1-2 名船员补眠');
      if (state.sleepWakeAt !== 100) problems.push('beginSleep 应记录叫醒时刻');
      if (!sleepDue(101)) problems.push('过 wakeAt 后 sleepDue 应为 true');
      var woken = wakeUp();
      if (woken.length !== slept.length) problems.push('叫醒人数应与补眠人数一致');
      if (sleepers().length) problems.push('叫醒后不应还有人睡着');
      // R3：兑换单
      var offers = exchangeOffers(0);
      if (offers.length !== 4) problems.push('市集默认应有 4 张兑换单');
      var up = exchangeOffers(2);
      if (up[0].yield.plastic !== Math.round(3 * 1.5)) problems.push('tradeBonus 应提升兑换产出');
      exit();
      if (isActive()) problems.push('exit 后 active 应为 false');
      // 越界钳制
      enter([], false);
      move({ x: 99, z: 99 }, 1.0);
      if (Math.abs(state.x) > 10 || Math.abs(state.z) > 20) problems.push('移动应被甲板范围钳制');
      exit();
    } catch (e) { problems.push('运行时异常: ' + e.message); }
    return { passed: problems.length === 0, problems: problems, spots: SPOTS.length, crew: CREW_DEFS.length, version: VERSION };
  }

  return {
    VERSION: VERSION,
    SPOTS: SPOTS.map(function (s) { return { id: s.id, name: s.name, action: s.action }; }),
    CREW_DEFS: CREW_DEFS.map(function (c) { return { id: c.id, name: c.name, job: c.job }; }),
    enter: enter, exit: exit, isActive: isActive,
    move: move, setDeck: setDeck, setObstacles: setObstacles,
    nearestSpot: nearestSpot, interact: interact,
    crewList: crewList, setRecruited: setRecruited, setSushiOpen: setSushiOpen,
    cameraRig: cameraRig, snapshot: snapshot, selfTest: selfTest,
    /* R3 新增 */
    tickCrew: tickCrew, setPatrol: setPatrol,
    beginSleep: beginSleep, wakeUp: wakeUp, sleepers: sleepers, sleepDue: sleepDue,
    exchangeOffers: exchangeOffers, logExchange: logExchange, EXCHANGES: EXCHANGES
  };
});
