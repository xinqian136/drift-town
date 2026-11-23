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

  var VERSION = '1.0.0';

  /* 甲板上的交互点。坐标是船体局部坐标（与 BUILDING_POS 同一套基准），
   * y 是甲板高度。radius 是可互动距离。 */
  var SPOTS = [
    { id: 'workbench', name: '工作台',   x: 2.6,  z: 6.0,  y: 1.8, radius: 1.6, action: 'build',   hint: '打开建造菜单' },
    { id: 'shelter',   name: '庇护所',   x: -2.6, z: 6.0,  y: 1.8, radius: 1.6, action: 'rest',    hint: '休息 / 存档' },
    { id: 'sushi',     name: '寿司店',   x: 2.2,  z: -1.0, y: 1.8, radius: 1.8, action: 'sushi',   hint: '经营寿司店', needs: 'sushiOpen' },
    { id: 'tower',     name: '水塔',     x: -2.4, z: -2.0, y: 1.8, radius: 1.5, action: 'tower',   hint: '查看供水' },
    { id: 'market',    name: '市集',     x: 2.2,  z: -5.0, y: 1.8, radius: 1.6, action: 'market',  hint: '买卖材料' },
    { id: 'dock',      name: '舷梯',     x: 0,    z: 11.0, y: 1.8, radius: 1.8, action: 'dive',    hint: '下潜 / 钓鱼' },
    { id: 'bridge',    name: '船桥',     x: 0,    z: 8.5,  y: 3.6, radius: 1.8, action: 'sail',    hint: '回到航行' }
  ];

  /* 可招募的船员：登船后他们会在甲板上站着/走动，让船上有「人」。
   * 每条带完整外观配色，供程序化角色拼装使用（无外部资产模式）。 */
  var CREW_DEFS = [
    { id: 'laochen',   name: '老陈',   color: '#8fb8d8', job: '打捞', x: -1.8, z: 3.2,
      skin: '#d9a97c', hair: '#c8c8c8', hat: '#5a6a78', pants: '#4a5560', shoe: '#3a3a3a' },
    { id: 'ahai',      name: '阿海',   color: '#7fd8e8', job: '潜水', x: 1.9,  z: 4.0,
      skin: '#e8c39a', hair: '#2a3a4a', hat: null,      pants: '#3a5a6a', shoe: '#2a3a3a' },
    { id: 'xiaoman',   name: '小满',   color: '#e8b87f', job: '寿司', x: 2.2,  z: -1.4,
      skin: '#f0d0aa', hair: '#4a3020', hat: '#e8e0d0', pants: '#7a5a40', shoe: '#5a4030' },
    { id: 'bo',        name: '铁匠波', color: '#b8a090', job: '建造', x: -2.0, z: -3.4,
      skin: '#c89878', hair: null,      hat: '#6a4a3a', pants: '#5a4a40', shoe: '#3a302a' },
    { id: 'lili',      name: '莉莉',   color: '#d8a0c8', job: '买卖', x: 2.4,  z: -5.2,
      skin: '#f5dcc0', hair: '#7a3a5a', hat: null,      pants: '#8a5a7a', shoe: '#6a4050' }
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
    scale: 1                 // 坐标缩放 = deckLen / 13，小木筏上所有点收缩到筏面
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
    // 更新靠近的交互点
    state.nearSpot = nearestSpot();
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

  /* ==== 船员（让船上有人） ==== */
  function crewList() {
    var out = [];
    for (var i = 0; i < CREW_DEFS.length; i++) {
      var c = CREW_DEFS[i];
      if (state.recruited.indexOf(c.id) < 0) continue;
      out.push({
        id: c.id, name: c.name, color: c.color, job: c.job,
        skin: c.skin, hair: c.hair, hat: c.hat, pants: c.pants, shoe: c.shoe,
        x: sx(c.x), z: sz(c.z),
        // 轻微待机摆动，让甲板不是死的
        bob: Math.sin(state.walkT * 0.5 + i) * 0.06
      });
    }
    return out;
  }
  function setRecruited(ids) { state.recruited = (ids || []).slice(); }
  function setSushiOpen(v) { state.sushiOpen = !!v; }

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
      sushiOpen: state.sushiOpen
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
    move: move, setDeck: setDeck,
    nearestSpot: nearestSpot, interact: interact,
    crewList: crewList, setRecruited: setRecruited, setSushiOpen: setSushiOpen,
    cameraRig: cameraRig, snapshot: snapshot, selfTest: selfTest
  };
});
