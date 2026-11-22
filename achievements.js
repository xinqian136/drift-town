/* 漂流小镇 · 成就系统 achievements.js
 * ===========================================================================
 * 一个文件、零依赖、零 DOM：浏览器与微信小游戏通用。
 *
 * 职责
 *   1. 定义 21 个成就（打捞 5 / 建造 5 / 生存 4 / 社交 3 / 探索 4）
 *   2. 用一个「累计统计器」把每帧的 __gameState() 快照折算成跨局累计值
 *   3. 解锁判定 + localStorage 持久化 + 解锁队列（给游戏弹提示用）
 *   4. 成就面板 / 解锁横幅的 Canvas 2D 绘制（传入 ctx，不碰 DOM）
 *
 * 为什么要有统计器
 *   __gameState() 给的是「本局当前值」：score 是本局分，combo 是当前连击，
 *   pickups 是场上还没捞的物件数组。成就需要的是「累计捞了 200 件」这类
 *   跨局总量，所以必须由本模块 tick() 每帧累加并落盘。tick() 是幂等的：
 *   同一份快照喂两次不会重复计数（用「本局已计入的件数」做水位线）。
 *
 * 硬约束
 *   - 不加载 Node 模块、不读写文件、不请求网络、不操作 DOM
 *   - 不使用彩色 emoji（微信 Canvas 会渲染成方块）
 *   - 所有 check/progress 必须防御性：字段缺失、类型错误、null 都不能抛
 *
 * 用法（游戏侧）
 *   Achievements.load();                              // 读存档
 *   // 在 update(dt) 里，拿到 state 之后：
 *   Achievements.tick(state, dt);
 *   // HUD 里（ctx 已经是 dpr 变换过的 2D 上下文）：
 *   Achievements.drawPanel(ctx, w, h, font, fontFamily);
 *   Achievements.drawToast(ctx, w, h, font, fontFamily);
 * ===========================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.Achievements = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var MODULE_VERSION = '1.0.0';
  var STORE_KEY = 'dsh-game-studio:drift-town:achievements:v1';

  /* === 1. 常量与枚举值 ================================================== */

  /* game.js 的 6 座城镇建筑（BUILDING_SPECS 的名字，顺序即建造顺序）。
   * 不引用 game.js 的常量：这是独立的验收副本，game.js 改了名字这里会红。 */
  var TOWN_BUILDINGS = ['小屋', '水塔', '温室', '灯塔', '市集', '风车'];

  /* game.js 的 6 个生存步骤 id（SURVIVAL_STEPS[].id）。 */
  var SURVIVAL_IDS = ['workbench', 'shelter', 'rainCatcher', 'fishBasket', 'scoopNet', 'purifier'];

  /* game.js 的 5 位可招募漂流者（CASTAWAY_DEFS[].name）。 */
  var CASTAWAY_NAMES = ['老陈', '阿海', '小满', '铁匠波', '莉莉'];

  /* 潜水深度层数：dive-canvas.js 里 depth 1=浅水 2=中层 3=深水。 */
  var DEEP_LAYER = 3;

  /* 自持解锁城镇所需的秒数（game.json rules.survival.selfSustainSec）。 */
  var SELF_SUSTAIN_SEC = 60;

  /* === 2. 工具函数（全部防御性） ======================================== */

  function isObj(v) { return !!v && typeof v === 'object'; }

  /** 读一个数字字段；缺失 / NaN / 字符串 / null 都退化成 fallback。 */
  function num(v, fallback) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && isFinite(Number(v))) return Number(v);
    return typeof fallback === 'number' ? fallback : 0;
  }

  /** 读一个数组字段；非数组一律当空数组。 */
  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }

  /** 把 v 钳到 [lo, hi]，并把非数字变成 lo。 */
  function clamp(v, lo, hi) {
    var n = num(v, lo);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /** 百分比进度：四舍五入到整数，恒在 0-100。 */
  function pct(current, target) {
    var t = num(target, 0);
    if (t <= 0) return 100;              // 没有目标视为已完成，避免 NaN
    return Math.round(clamp(num(current, 0) / t * 100, 0, 100));
  }

  /** progress 的统一形状：{ current, target, pct }。target<=0 时 pct=100。 */
  function prog(current, target) {
    var c = num(current, 0), t = num(target, 0);
    return { current: c, target: t, pct: t > 0 ? pct(c, t) : 100 };
  }

  /** 统计器里一个「只增不减」的累计项。 */
  function bump(stats, key, value) {
    var v = num(value, 0);
    if (!isFinite(v) || v <= 0) return;
    stats[key] = num(stats[key], 0) + v;
  }

  /** 把 stats[key] 抬到至少 value（用于「本局最高值」这类取最大值的水位线）。 */
  function raise(stats, key, value) {
    var v = num(value, 0);
    if (v > num(stats[key], 0)) stats[key] = v;
  }

  /* 从 state 里安全地取潜水状态。__gameState().diveState 可能为 null。 */
  function diveStateOf(state) {
    if (!isObj(state)) return null;
    var d = state.diveState;
    return isObj(d) ? d : null;
  }

  /* === 3. 成就定义 ======================================================
   * 每个成就：
   *   id        稳定标识（存档用，不要改）
   *   name      中文名（≤6 字，HUD 一行放得下）
   *   desc      解锁条件的人话描述
   *   category  打捞 / 建造 / 生存 / 社交 / 探索
   *   hidden    未解锁时在面板里是否隐藏描述（隐藏成就不剧透）
   *   check(state, stats) -> boolean
   *   progress(state, stats) -> { current, target, pct }
   *
   * 约定：check 与 progress 必须用同一套口径，测试会逐条交叉验证
   *        「progress.pct === 100  <=>  check === true」（对非 0/1 型成就）。
   * ------------------------------------------------------------------- */

  var ACHIEVEMENTS = [
    /* --- 打捞类 5 个 --- */
    {
      id: 'salvage_first',
      name: '第一件漂流物',
      desc: '打捞出第一件垃圾',
      category: '打捞', hidden: false,
      check: function (s, st) { return num(st.salvaged) >= 1; },
      progress: function (s, st) { return prog(num(st.salvaged), 1); }
    },
    {
      id: 'salvage_50',
      name: '熟练的捞手',
      desc: '累计打捞 50 件',
      category: '打捞', hidden: false,
      check: function (s, st) { return num(st.salvaged) >= 50; },
      progress: function (s, st) { return prog(num(st.salvaged), 50); }
    },
    {
      id: 'salvage_200',
      name: '海上清道夫',
      desc: '累计打捞 200 件',
      category: '打捞', hidden: false,
      check: function (s, st) { return num(st.salvaged) >= 200; },
      progress: function (s, st) { return prog(num(st.salvaged), 200); }
    },
    {
      id: 'combo_10',
      name: '手感来了',
      desc: '单局连击达到 10',
      category: '打捞', hidden: false,
      check: function (s, st) { return num(st.bestCombo) >= 10; },
      progress: function (s, st) { return prog(num(st.bestCombo), 10); }
    },
    {
      id: 'score_300',
      name: '满载而归',
      desc: '单局得分达到 300',
      category: '打捞', hidden: false,
      check: function (s, st) { return num(st.bestScore) >= 300; },
      progress: function (s, st) { return prog(num(st.bestScore), 300); }
    },

    /* --- 建造类 5 个 --- */
    {
      id: 'build_workbench',
      name: '动手的人',
      desc: '造出工作台',
      category: '建造', hidden: false,
      check: function (s) { return hasSurvival(s, 'workbench'); },
      progress: function () { return prog(0, 1); } // 见下方 progressForBuild 覆盖
    },
    {
      id: 'build_shelter',
      name: '有了个家',
      desc: '造出庇护所',
      category: '建造', hidden: false,
      check: function (s) { return hasSurvival(s, 'shelter'); },
      progress: function () { return prog(0, 1); }
    },
    {
      id: 'build_all_survival',
      name: '生存装备齐备',
      desc: '造齐 6 件生存装备',
      category: '建造', hidden: false,
      check: function (s) { return survivalCount(s) >= SURVIVAL_IDS.length; },
      progress: function (s) { return prog(survivalCount(s), SURVIVAL_IDS.length); }
    },
    {
      id: 'build_town_4',
      name: '小镇成形',
      desc: '建成 4 座城镇建筑',
      category: '建造', hidden: false,
      check: function (s, st) { return num(st.bestTown) >= 4; },
      progress: function (s, st) { return prog(num(st.bestTown), 4); }
    },
    {
      id: 'build_town_all',
      name: '六座齐了',
      desc: '建成全部 6 座城镇建筑',
      category: '建造', hidden: false,
      check: function (s, st) { return num(st.bestTown) >= TOWN_BUILDINGS.length; },
      progress: function (s, st) { return prog(num(st.bestTown), TOWN_BUILDINGS.length); }
    },

    /* --- 生存类 4 个 --- */
    {
      id: 'survive_selfsustain',
      name: '可以住下来了',
      desc: '首次达成生存自持',
      category: '生存', hidden: false,
      check: function (s) { return selfSustainOf(s) >= 3 || townReadyOf(s); },
      progress: function (s) {
        // selfSustain 是「已连续自持多少秒」，3 秒起步算入门。
        // townReady 时至少已经自持满 60 秒，当然也满足 3 秒。
        return prog(townReadyOf(s) ? 3 : selfSustainOf(s), 3);
      }
    },
    {
      id: 'survive_town_ready',
      name: '可以建立城镇了',
      desc: '自持满 60 秒，解锁城镇',
      category: '生存', hidden: false,
      check: function (s) { return townReadyOf(s); },
      progress: function (s) {
        // 这一项的唯一权威判据是 townReady（game.js 在自持满 60 秒时置 true）。
        // 因此 progress 也以它为口径：townReady 就是 60/60，否则按实际计时。
        // 注意 selfSustain 在 townReady 之前不会达到 60（到 60 就置 true 了），
        // 所以这里对 selfSustain 再钳一次上限 59，保证「pct 100 ⟺ townReady」。
        if (townReadyOf(s)) return prog(SELF_SUSTAIN_SEC, SELF_SUSTAIN_SEC);
        return prog(Math.min(selfSustainOf(s), SELF_SUSTAIN_SEC - 1), SELF_SUSTAIN_SEC);
      }
    },
    {
      id: 'survive_all_hearts',
      name: '一滴血没掉',
      desc: '单局满血通关',
      category: '生存', hidden: false,
      check: function (s, st) { return num(st.flawlessRuns) >= 1; },
      progress: function (s, st) { return prog(num(st.flawlessRuns), 1); }
    },
    {
      id: 'survive_dry_run',
      name: '滴水未进',
      desc: '水壶见底后仍活过 3 秒',
      category: '生存', hidden: true,
      check: function (s, st) { return num(st.bestDryRun) >= 3; },
      progress: function (s, st) { return prog(num(st.bestDryRun), 3); }
    },

    /* --- 社交类 3 个 --- */
    {
      id: 'social_first',
      name: '不是一个人',
      desc: '招募第一位漂流者',
      category: '社交', hidden: false,
      check: function (s, st) { return num(st.bestRecruited) >= 1; },
      progress: function (s, st) { return prog(num(st.bestRecruited), 1); }
    },
    {
      id: 'social_all',
      name: '全员到齐',
      desc: '招募全部 5 位漂流者',
      category: '社交', hidden: false,
      check: function (s, st) { return num(st.bestRecruited) >= CASTAWAY_NAMES.length; },
      progress: function (s, st) { return prog(num(st.bestRecruited), CASTAWAY_NAMES.length); }
    },
    {
      id: 'social_fish',
      name: '钓上一条',
      desc: '第一次在甲板上钓到鱼',
      category: '社交', hidden: false,
      check: function (s, st) { return num(st.fishCaught) >= 1; },
      progress: function (s, st) { return prog(num(st.fishCaught), 1); }
    },

    /* --- 探索类 4 个 --- */
    {
      id: 'explore_dive_first',
      name: '第一次下潜',
      desc: '完成第一次潜水',
      category: '探索', hidden: false,
      check: function (s, st) { return num(st.divesStarted) >= 1; },
      progress: function (s, st) { return prog(num(st.divesStarted), 1); }
    },
    {
      id: 'explore_dive_deep',
      name: '深海来客',
      desc: '到达深水层（第 3 层）',
      category: '探索', hidden: false,
      check: function (s) { return deepestLayerOf(s) >= DEEP_LAYER; },
      progress: function (s) { return prog(deepestLayerOf(s), DEEP_LAYER); }
    },
    {
      id: 'explore_dive_loot',
      name: '论筐称重',
      desc: '单次潜水带回 5 件以上食材',
      category: '探索', hidden: false,
      check: function (s) { return diveLootOf(s) >= 5; },
      progress: function (s) { return prog(diveLootOf(s), 5); }
    },
    {
      id: 'explore_zone',
      name: '闯进鲨鱼的地盘',
      desc: '进入过鲨鱼巡逻区',
      category: '探索', hidden: true,
      check: function (s, st) { return num(st.zoneVisits) >= 1; },
      progress: function (s, st) { return prog(num(st.zoneVisits), 1); }
    }
  ];

  /* --- 两个建造成就的 progress 需要专用逻辑，单独赋值，避免上面写重复 --- */
  (function patchBuildProgress() {
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      if (a.id === 'build_workbench') {
        a.progress = function (s) { return prog(hasSurvival(s, 'workbench') ? 1 : 0, 1); };
      } else if (a.id === 'build_shelter') {
        a.progress = function (s) { return prog(hasSurvival(s, 'shelter') ? 1 : 0, 1); };
      }
    }
  })();

  /* === 4. 从 state 读数的适配层 ======================================== */
  /* 全部字段都从 __gameState() 的实际返回值来；任何一处缺失都退化成 0。 */

  /** 已建成的生存装备 id 列表（state.survival 是 id 字符串数组）。 */
  function survivalList(s) {
    if (!isObj(s)) return [];
    var raw = arr(s.survival), out = [], i;
    for (i = 0; i < raw.length; i++) {
      if (typeof raw[i] === 'string') out.push(raw[i]);
      else if (isObj(raw[i]) && typeof raw[i].id === 'string') out.push(raw[i].id);
    }
    return out;
  }

  function hasSurvival(s, id) { return survivalList(s).indexOf(id) >= 0; }

  /** 自持计时（秒）。game.js 里 selfSustain 是「已连续自持多久」，上限就是
   *  game.json rules.survival.selfSustainSec = 60 秒（到点即 townReady）。
   *  这里钳到 60：一来字段可能是脏数据（1e9 之类），二来保持
   *  「pct 满 ⟺ 真的解锁」的口径一致——自持满 60 就等价于 townReady。 */
  function selfSustainOf(s) {
    if (!isObj(s)) return 0;
    var v = Math.max(0, num(s.selfSustain, 0));
    return Math.min(v, SELF_SUSTAIN_SEC);
  }

  /** 城镇是否已解锁（自持满 60 秒）。只认 === true，'yes' 这类不算。 */
  function townReadyOf(s) {
    return isObj(s) && s.townReady === true;
  }

  /** 到过的最深潜水层：取「历史最深」与「当前这一帧的层数」的较大者。
   *  这样即使成就还没被 tick() 记账，只要眼下正处在深水层也能判对。 */
  function deepestLayerOf(s) {
    var fromStats = num(_stats.deepestLayer, 0);
    var ds = diveStateOf(s);
    var fromState = ds ? num(ds.depth, 0) : 0;
    return Math.max(fromStats, fromState);
  }

  /** 单次潜水带回的件数：历史最好与当前这趟的较大者。
   *  diveState.collected 在 game.js 里被折算成件数（数字）；也兼容传数组。 */
  function diveLootOf(s) {
    var fromStats = num(_stats.bestDiveLoot, 0);
    var fromState = 0;
    var ds = diveStateOf(s);
    if (ds) {
      if (Object.prototype.toString.call(ds.collected) === '[object Array]') fromState = ds.collected.length;
      else fromState = num(ds.collected, 0);
    }
    return Math.max(fromStats, fromState);
  }

  /** 已建成的生存装备件数（只数 SURVIVAL_IDS 里认识的，防止未知 id 灌水）。 */
  function survivalCount(s) {
    var list = survivalList(s), n = 0, i;
    for (i = 0; i < SURVIVAL_IDS.length; i++) {
      if (list.indexOf(SURVIVAL_IDS[i]) >= 0) n++;
    }
    return n;
  }

  /** 本局城镇建筑数。state.buildings 是数字（buildings.length）；
   *  也兼容它被传成数组的畸形情况。同时用 state.town 兜底。 */
  function townCount(s) {
    if (!isObj(s)) return 0;
    if (Array.isArray(s.buildings)) {
      var n = 0, i;
      for (i = 0; i < s.buildings.length; i++) {
        // 生存装备也可能混在数组里，只数不认识 SURVIVAL_IDS 的
        var id = isObj(s.buildings[i]) ? s.buildings[i].id : s.buildings[i];
        if (typeof id === 'string' && SURVIVAL_IDS.indexOf(id) < 0) n++;
      }
      return n;
    }
    var b = num(s.buildings, -1);
    if (b >= 0) return b;
    // state.town 里含庇护所（game.js: townCount() = buildings + 是否有庇护所），
    // 所以要把庇护所减回去，保持与 buildings 同口径。
    var t = num(s.town, 0);
    return Math.max(0, t - (hasSurvival(s, 'shelter') ? 1 : 0));
  }

  /** 本局已招募人数。state.recruited 是名字数组。 */
  function recruitedCount(s) {
    if (!isObj(s)) return 0;
    var r = arr(s.recruited), n = 0, i;
    for (i = 0; i < r.length; i++) {
      if (typeof r[i] === 'string' || isObj(r[i])) n++;
    }
    return n;
  }

  /** 本局得分。优先 score，退化到 best（重开瞬间 score 会归零）。 */
  function scoreOf(s) {
    if (!isObj(s)) return 0;
    return Math.max(0, num(s.score, 0));
  }

  /** 本局连击。 */
  function comboOf(s) {
    if (!isObj(s)) return 0;
    return Math.max(0, num(s.combo, 0));
  }

  /** 本局是否在「鲨鱼巡逻区」里。state.zone 是 {x,z,r}，state.hero 是 {x,y}。
   *  注意 hero.y 是 world z，zone.z 也是 world z（见 __gameState 注释）。 */
  function inZoneNow(s) {
    if (!isObj(s) || !isObj(s.zone) || !isObj(s.hero)) return false;
    var r = num(s.zone.r, 0);
    if (r <= 0) return false;
    var dx = num(s.hero.x, 0) - num(s.zone.x, 0);
    var dz = num(s.hero.y, 0) - num(s.zone.z, 0);
    return (dx * dx + dz * dz) <= r * r;
  }

  /* === 5. 累计统计器 =================================================== */  /* 存档结构：
   * {
   *   v: 1,
   *   unlocked: { <achievementId>: <unix ms> },
   *   stats: { salvaged, bestCombo, ... },
   *   run:   { pieces, recruited, town, flawless, diveLoot, ... }   // 本局水位线
   * }
   * run 里的值是「本局已经计入 stats 的水位线」，用来让 tick() 幂等。
   */

  function freshRun() {
    return {
      pieces: 0,          // 本局已计入的累计打捞件数
      recruited: 0,       // 本局已计入的招募人数
      town: 0,            // 本局已计入的城镇建筑数
      survival: 0,        // 本局已计入的生存装备件数
      diveLoot: 0,        // 本局上一次看到的潜水收获件数
      diveStarted: false, // 本局是否已经计过一次「开始潜水」
      dryRun: 0,          // 本局连续缺水秒数
      lastScore: 0,       // 上一帧的 score（打捞事件代理的水位线）
      prevHearts: null,   // 上一帧血量，用来判定「没掉过血」
      tookDamage: false,  // 本局是否掉过血
      wasInZone: false,   // 上一帧是否在巡逻区
      prevFishReady: false, // 上一帧 fishReady
      endCounted: false,  // 本局的结算是否已经记过（防同局多次结算重复计）
      lastPhase: null     // 上一帧 phase
    };
  }

  function freshStats() {
    return {
      salvaged: 0,        // 累计打捞件数
      bestCombo: 0,       // 历史单局最高连击
      bestScore: 0,       // 历史单局最高分
      bestTown: 0,        // 历史单局最多城镇建筑
      bestRecruited: 0,   // 历史单局最多招募人数
      bestDiveLoot: 0,    // 历史单次潜水最多收获件数
      deepestLayer: 0,    // 到过的最深潜水层
      flawlessRuns: 0,    // 满血通关次数
      bestDryRun: 0,      // 最长缺水存活秒数
      fishCaught: 0,      // 累计钓鱼次数（用收竿跳变计）
      divesStarted: 0,    // 累计开始潜水次数
      zoneVisits: 0,      // 累计进入巡逻区次数（按「从外到内」跳变计）
      runs: 0             // 累计开局次数
    };
  }

  /* === 6. 存储层（localStorage / wx 存储，特性检测） ==================== */

  function storage() {
    // 微信小游戏：本地存储走 wx.setStorageSync，容量与 key 规则和 Web 一致。
    if (typeof wx !== 'undefined' && wx && typeof wx.setStorageSync === 'function'
        && typeof wx.getStorageSync === 'function') {
      return {
        get: function (k) { try { return wx.getStorageSync(k); } catch (e) { return null; } },
        set: function (k, v) { try { wx.setStorageSync(k, v); return true; } catch (e) { return false; } }
      };
    }
    // Web / 浏览器：localStorage（可能被无痕模式或沙箱禁掉，全部 try 包住）
    try {
      var ls = typeof localStorage !== 'undefined' ? localStorage : null;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
        return {
          get: function (k) { try { return ls.getItem(k); } catch (e) { return null; } },
          set: function (k, v) { try { ls.setItem(k, v); return true; } catch (e) { return false; } }
        };
      }
    } catch (e) { /* 沙箱里访问 localStorage 会抛，忽略 */ }
    // 内存兜底：不持久化，但保证功能可跑完这一局。
    var mem = {};
    return {
      get: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      set: function (k, v) { mem[k] = v; return true; },
      memoryOnly: true
    };
  }

  /* === 7. 模块状态 ===================================================== */

  var _store = null;          // 存储后端（惰性初始化）
  var _unlocked = {};         // { id: unlockMs }
  var _stats = freshStats();
  var _run = freshRun();
  var _queue = [];            // 待弹提示的解锁队列 [{ id, name, desc, at }]
  var _toast = null;          // 当前正在显示的提示 { id, name, desc, t, max }
  var _loaded = false;
  var _dirty = false;
  var _levelUpSink = null;    // 可选回调：解锁时通知外部

  function store() {
    if (!_store) _store = storage();
    return _store;
  }

  /** 读存档。坏 JSON / 版本不符 / 缺字段都不能抛，一律回落到空存档。 */
  function load() {
    var raw = null;
    try { raw = store().get(STORE_KEY); } catch (e) { raw = null; }

    var data = null;
    if (typeof raw === 'string' && raw) {
      try { data = JSON.parse(raw); } catch (e) { data = null; }
    } else if (isObj(raw)) {
      // 某些实现会自动反序列化（微信的 storage 就会存对象）
      data = raw;
    }

    _unlocked = {};
    _stats = freshStats();
    _run = freshRun();

    if (isObj(data)) {
      // unlocked：只接受字符串 key，值统一成数字时间戳
      if (isObj(data.unlocked)) {
        for (var k in data.unlocked) {
          if (!Object.prototype.hasOwnProperty.call(data.unlocked, k)) continue;
          if (typeof k === 'string' && k) _unlocked[k] = num(data.unlocked[k], Date.now());
        }
      }
      // stats：只接受已知 key，值必须是有限数字（防止存档被手改成字符串）
      if (isObj(data.stats)) {
        var defs = freshStats();
        for (var sk in defs) {
          if (!Object.prototype.hasOwnProperty.call(defs, sk)) continue;
          if (Object.prototype.hasOwnProperty.call(data.stats, sk)) {
            var v = data.stats[sk];
            if (typeof v === 'number' && isFinite(v) && v >= 0) defs[sk] = v;
          }
        }
        _stats = defs;
      }
    }
    _loaded = true;
    _dirty = false;
    return snapshot(false);
  }

  /** 落盘。失败（存储满 / 被禁）不抛，只记 dirty 等下次再试。 */
  function save() {
    if (!_loaded) load();
    var payload = {
      v: 1,
      unlocked: _unlocked,
      stats: _stats,
      savedAt: Date.now()
    };
    var ok = false;
    try { ok = store().set(STORE_KEY, JSON.stringify(payload)); } catch (e) { ok = false; }
    _dirty = !ok;
    return ok;
  }

  /* === 8. tick —— 每帧把 state 折进累计值 ============================== */

  /**
   * 每帧调用。dt 单位秒，可省略（省略时按 0 处理，只做不依赖时间的累加）。
   * 返回本帧新解锁的成就数组（通常为空）。
   *
   * 幂等性：同一份 state 重复喂不会重复计数——所有「本局计数」都走
   * run.* 水位线比较，只有 state 的值比水位线更高时才把差值累加进 stats。
   */
  function tick(state, dt) {
    if (!_loaded) load();
    var s = isObj(state) ? state : {};
    var step = num(dt, 0);
    if (step < 0) step = 0;
    if (step > 1) step = 1;   // 掉帧 / 切后台回来时不要一次跳太多

    /* --- 8.0 换局检测：必须放在所有计数之前。
     * 否则「本局水位线重置」会把紧接着刚累加的那一步抹掉，
     * 导致同一份快照被重复计数（测试实测到过这个 bug）。 --- */
    var ph = typeof s.phase === 'string' ? s.phase : '';
    if (ph && ph !== _run.lastPhase) {
      var wasEnded = _run.lastPhase === 'won' || _run.lastPhase === 'lost';
      var startingFresh = ph === 'playing' && (_run.lastPhase === null || _run.lastPhase === 'title' || wasEnded);
      if (startingFresh) _run = freshRun();
      _run.lastPhase = ph;
    }

    /* --- 8.1 打捞件数：__gameState() 里没有「本局累计件数」字段
     * （game.js 内部有 pieces，但没暴露出来）。
     *
     * 降级口径（默认）：数「得分跳变的次数」，而不是得分增量。
     *   game.js 里每次拾取都会执行 score += ...（至少 +1），所以一次拾取
     *   对应一次 score 上涨；数事件数比加增量更接近真实件数
     *   （一次拾取 +1~6 分，加增量会把件数放大好几倍）。
     *   误差来源：同一帧里同时拾取多件只会计 1 次——这是保守的少计，
     *   不会让成就提前解锁。
     *
     * 精确口径（推荐游戏侧启用）：在真正的拾取点调用
     *   Achievements.note({ picked: 1 })   或   note({ pieces: 本局pieces })
     * 一旦启用，下面的得分代理永久停用。 */
    if (!_exactPieces) {
      var sc = scoreOf(s);
      if (sc > num(_run.lastScore, 0)) {
        bump(_stats, 'salvaged', 1);              // 一次上涨 = 一次打捞事件
        _run.pieces = num(_run.pieces, 0) + 1;
        _run.lastScore = sc;
      } else if (sc < num(_run.lastScore, 0)) {
        _run.lastScore = sc;                       // 重开，水位线跟着回落
      }
    }

    /* --- 8.2 单局最高值：连击 / 分数 / 建筑 / 招募 / 潜水收获 --- */
    raise(_stats, 'bestCombo', comboOf(s));
    raise(_stats, 'bestScore', scoreOf(s));

    var tCount = townCount(s);
    raise(_stats, 'bestTown', tCount);
    raise(_run, 'town', tCount);

    var rCount = recruitedCount(s);
    raise(_stats, 'bestRecruited', rCount);
    raise(_run, 'recruited', rCount);

    var sCount = survivalCount(s);
    raise(_run, 'survival', sCount);

    /* --- 8.3 生存：缺水存活 / 满血 --- */
    var maxWaterVal = num(s.maxWater, 0), waterVal = num(s.water, 0);
    if (maxWaterVal > 0 && waterVal <= 0) {
      _run.dryRun = num(_run.dryRun, 0) + step;
      raise(_stats, 'bestDryRun', _run.dryRun);
    } else {
      _run.dryRun = 0;
    }

    var hearts = num(s.hearts, -1);
    if (hearts >= 0) {
      // 「没掉过血」：看血量相对上一帧是否下降。保命道具回血不影响判定。
      if (_run.prevHearts !== null && hearts < _run.prevHearts) _run.tookDamage = true;
      _run.prevHearts = hearts;
    }
    /* 满血通关：phase 从 playing 变成 won，且全程血量没下降过。
     * game.js 的 finish() 把 town/partial 记成 won、其它记成 lost。
     * 换局检测在 8.0 已经做完了，这里直接看本帧阶段。
     * endCounted 保证同一局的结算只记一次（结算画面会连续 tick 很多帧）。 */
    if ((ph === 'won' || ph === 'lost') && !_run.endCounted) {
      _run.endCounted = true;
      if (ph === 'won' && !_run.tookDamage) bump(_stats, 'flawlessRuns', 1);
    }

    /* --- 8.4 潜水：开始次数 / 最深到达 / 单次收获 --- */
    var ds = diveStateOf(s);
    var diveActive = s.diving === true || (ds && ds.phase && ds.phase !== 'title');    if (diveActive && !_run.diveStarted) {
      _run.diveStarted = true;
      bump(_stats, 'divesStarted', 1);
      _run.diveLoot = 0;
    }
    if (!diveActive && _run.diveStarted) {
      // 潜水结束（结算或退出）：记录这一趟的收获
      raise(_stats, 'bestDiveLoot', num(_run.diveLoot, 0));
      _run.diveStarted = false;
      _run.diveLoot = 0;
    }
    if (ds) {
      var layer = num(ds.depth, 0);
      raise(_stats, 'deepestLayer', layer);
      var loot = num(ds.collected, Array.isArray(ds.collected) ? ds.collected.length : 0);
      if (loot > num(_run.diveLoot, 0)) _run.diveLoot = loot;
      raise(_stats, 'bestDiveLoot', loot);
    }

    /* --- 8.5 巡逻区：从外面进入里面算一次 --- */
    var inZone = inZoneNow(s);
    if (inZone && !_run.wasInZone) bump(_stats, 'zoneVisits', 1);
    _run.wasInZone = inZone;

    /* --- 8.6 钓鱼：__gameState() 给了 fishReady（有鱼咬钩）/ fishTimer
     * （距离咬钩还有几秒），但「收竿成功」这一事件没有独立标志位。
     * 从 fishReady: true → false 且 fishTimer 同时归零，可以推断收竿成功，
     * 但「玩家点了收竿」和「鱼脱钩」在这个信号上无法区分，所以这里只做
     * 保守推断：把 fishReady 的 true→false 跳变记一次「收竿」。
     * 想要精确口径请在 game.js 的 reelIn() 里调用 Achievements.note({ fished: 1 })，
     * 此时下面的推断自动停用（_exactFishing）。 */
    if (!_exactFishing) {
      var fr = s.fishReady === true;
      if (_run.prevFishReady === true && !fr && s.docked === true) {
        bump(_stats, 'fishCaught', 1);
      }
      _run.prevFishReady = fr;
    }

    /* --- 8.7 判定解锁 --- */
    var newly = [];
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      if (_unlocked[a.id]) continue;
      var ok = false;
      try { ok = a.check(s, _stats) === true; } catch (e) { ok = false; }
      if (ok) {
        _unlocked[a.id] = Date.now();
        var entry = { id: a.id, name: a.name, desc: a.desc, at: _unlocked[a.id] };
        newly.push(entry);
        _queue.push(entry);
      }
    }
    if (newly.length) {
      save();
      for (var q = 0; q < newly.length; q++) {
        if (typeof _levelUpSink === 'function') {
          try { _levelUpSink(newly[q]); } catch (e) { /* 外部回调不能拖垮游戏 */ }
        }
      }
    } else if (_dirty) {
      save();
    }
    return newly;
  }

  /* 精确计数开关：游戏侧调用 note() 后自动打开，代理推断随之停用。 */
  var _exactPieces = false;
  var _exactFishing = false;

  /**
   * 精确事件上报。游戏侧在真正的拾取点 / 钓鱼点调用，比 tick 的代理推断准。
   *   Achievements.note({ picked: 1 })            // 精确 +1 件
   *   Achievements.note({ pieces: gamePieces })   // 直接给本局件数（幂等）
   *   Achievements.note({ fished: 1 })            // 钓上来一条
   */
  function note(ev) {
    if (!_loaded) load();
    if (!isObj(ev)) return false;
    var changed = false;
    if (typeof ev.picked === 'number' && isFinite(ev.picked) && ev.picked > 0) {
      _exactPieces = true;
      bump(_stats, 'salvaged', ev.picked);
      // picked 与 pieces 共用同一个本局水位线，否则两种口径混用会双计
      _run.pieces = num(_run.pieces, 0) + ev.picked;
      changed = true;
    }
    if (typeof ev.pieces === 'number' && isFinite(ev.pieces) && ev.pieces >= 0) {
      _exactPieces = true;
      var delta = ev.pieces - num(_run.pieces, 0);
      if (delta > 0) { bump(_stats, 'salvaged', delta); _run.pieces = ev.pieces; changed = true; }
    }
    if (typeof ev.fished === 'number' && isFinite(ev.fished) && ev.fished > 0) {
      _exactFishing = true;
      bump(_stats, 'fishCaught', ev.fished);
      changed = true;
    }
    if (typeof ev.bestCombo === 'number' && isFinite(ev.bestCombo)) {
      raise(_stats, 'bestCombo', ev.bestCombo); changed = true;
    }
    if (typeof ev.bestScore === 'number' && isFinite(ev.bestScore)) {
      raise(_stats, 'bestScore', ev.bestScore); changed = true;
    }
    if (changed) {
      _dirty = true;
      // 只跑解锁判定，不跑整个 tick()：tick 会消费 state 的水位线，
      // 拿 null 调会把本局的 lastPhase / 潜水状态等打断。
      evaluateStatsOnly();
      save();
    }
    return changed;
  }

  /** 只用统计器判定一次解锁（不碰 state）。note() 内部用。 */
  function evaluateStatsOnly() {
    var empty = {};
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      if (_unlocked[a.id]) continue;
      var ok = false;
      try { ok = a.check(empty, _stats) === true; } catch (e) { ok = false; }
      if (ok) {
        _unlocked[a.id] = Date.now();
        var entry = { id: a.id, name: a.name, desc: a.desc, at: _unlocked[a.id] };
        _queue.push(entry);
        if (typeof _levelUpSink === 'function') {
          try { _levelUpSink(entry); } catch (e2) { /* 外部回调不能拖垮游戏 */ }
        }
      }
    }
  }

  /** 一局开始 / 结束时的重置。game.js 的 start() 里调用。 */
  function resetRun() {
    _run = freshRun();
    bump(_stats, 'runs', 1);
    _dirty = true;
    save();
    return snapshot(false);
  }

  /* === 9. 查询接口 ===================================================== */

  function list() {
    var out = [], i;
    for (i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      out.push({
        id: a.id,
        name: a.name,
        desc: a.desc,
        category: a.category,
        hidden: a.hidden === true,
        unlocked: !!_unlocked[a.id],
        unlockedAt: num(_unlocked[a.id], 0)
      });
    }
    return out;
  }

  /** 一个成就的进度。永远返回合法对象，绝不抛。 */
  function progressOf(id, state) {
    var a = byId(id);
    if (!a) return { id: String(id), unknown: true, current: 0, target: 1, pct: 0 };
    var s = isObj(state) ? state : {};
    var p = null;
    try { p = a.progress(s, _stats); } catch (e) { p = null; }
    if (!isObj(p)) p = prog(0, 1);
    return {
      id: a.id,
      name: a.name,
      current: num(p.current, 0),
      target: num(p.target, 1),
      pct: clamp(p.pct !== undefined ? p.pct : pct(p.current, p.target), 0, 100),
      unlocked: !!_unlocked[a.id]
    };
  }

  function byId(id) {
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      if (ACHIEVEMENTS[i].id === id) return ACHIEVEMENTS[i];
    }
    return null;
  }

  /** 总体成就进度（0-100 整数），给排行榜用。 */
  function overallProgress() {
    if (!ACHIEVEMENTS.length) return 0;
    return Math.round(Object.keys(_unlocked).length / ACHIEVEMENTS.length * 100);
  }

  function unlockedCount() {
    var n = 0;
    for (var i = 0; i < ACHIEVEMENTS.length; i++) if (_unlocked[ACHIEVEMENTS[i].id]) n++;
    return n;
  }

  /** 面板要显示的行：[{ id, name, desc, category, hidden, unlocked, pct, current, target }] */
  function panelRows(state) {
    var out = [], raw = list(), i;
    for (i = 0; i < raw.length; i++) {
      var r = raw[i];
      var p = progressOf(r.id, state);
      out.push({
        id: r.id, name: r.name,
        // 隐藏成就在解锁前不给描述，只给「??」
        desc: (r.hidden && !r.unlocked) ? '隐藏成就' : r.desc,
        category: r.category,
        hidden: r.hidden,
        unlocked: r.unlocked,
        current: p.current, target: p.target,
        pct: r.unlocked ? 100 : p.pct
      });
    }
    return out;
  }

  function snapshot(includeState) {
    return {
      version: MODULE_VERSION,
      loaded: _loaded,
      memoryOnly: !!store().memoryOnly,
      total: ACHIEVEMENTS.length,
      unlocked: unlockedCount(),
      overall: overallProgress(),
      stats: copyObj(_stats),
      unlockedIds: Object.keys(_unlocked)
    };
  }

  function copyObj(o) {
    var out = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  /* === 10. 解锁提示队列 ================================================ */

  /** 弹出下一条提示（游戏在拿到 newly 后可以直接推）。返回是否还在显示。 */
  function showToast(entry, seconds) {
    if (!entry) return false;
    _toast = { id: entry.id, name: entry.name || String(entry.id), desc: entry.desc || '',
               t: 0, max: num(seconds, 3.2) };
    return true;
  }

  /** 从队列里取一条待弹提示（游戏侧每帧调用一次即可）。 */
  function nextToast() {
    if (_toast) return null;
    if (!_queue.length) return null;
    var e = _queue.shift();
    showToast(e);
    return e;
  }

  /** 推进提示的生命周期。dt 秒。 */
  function updateToast(dt) {
    if (!_toast) return false;
    _toast.t += num(dt, 0);
    if (_toast.t >= _toast.max) { _toast = null; return false; }
    return true;
  }

  function activeToast() { return _toast ? copyObj(_toast) : null; }

  /* === 11. Canvas 2D 绘制（零 DOM；ctx 由调用方给） ====================
   * 风格对齐 game.js 的 drawPill / roundRect：半透明深色药丸 + 极细白描边，
   * 只用 rgba 与 #hex 颜色，不用彩色 emoji。
   * ------------------------------------------------------------------- */

  var FONT_DEFAULT = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';

  function drawRoundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** 提前退出：ctx 不像 Canvas 2D 上下文时直接不画，绝不让 UI 拖垮游戏。 */
  function usable(ctx) {
    return !!ctx && typeof ctx.fillText === 'function' && typeof ctx.measureText === 'function';
  }

  /** 一条进度条。返回高度，方便面板往下排。 */
  function drawProgressBar(ctx, x, y, w, h, percent, colorOn, colorOff) {
    if (!usable(ctx)) return h;
    var frac = clamp(percent, 0, 100) / 100;
    ctx.fillStyle = 'rgba(14,18,40,0.6)';
    drawRoundRect(ctx, x, y, w, h, h / 2); ctx.fill();
    if (frac > 0) {
      ctx.fillStyle = colorOn || '#8fd86a';
      drawRoundRect(ctx, x + 1, y + 1, Math.max(0, (w - 2) * frac), Math.max(1, h - 2), (h - 2) / 2);
      ctx.fill();
    }
    ctx.strokeStyle = colorOff || 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    drawRoundRect(ctx, x, y, w, h, h / 2); ctx.stroke();
    return h;
  }

  /**
   * 成就面板。居中大卡片，按类别分组，每行「名称 · 描述 · 进度条 · 百分比」。
   *   ctx    Canvas 2D 上下文（调用方负责 setTransform 的 dpr 缩放）
   *   w, h   逻辑宽高（CSS 像素）
   *   opts   { font, fontFamily, scroll, rows }
   * 返回 { x, y, w, h } 面板矩形，供点击命中判断；不可绘制时返回 null。
   */
  function drawPanel(ctx, w, h, opts) {
    if (!usable(ctx)) return null;
    var o = isObj(opts) ? opts : {};
    var W = num(w, 0), H = num(h, 0);
    if (W <= 0 || H <= 0) return null;
    var font = Math.max(11, num(o.font, Math.max(14, Math.min(22, Math.min(W, H) * 0.024))));
    var FONT = typeof o.fontFamily === 'string' && o.fontFamily ? o.fontFamily : FONT_DEFAULT;
    var scroll = num(o.scroll, 0);

    var pW = Math.min(W * 0.86, 640), pH = Math.min(H * 0.82, 720);
    var pX = (W - pW) / 2, pY = (H - pH) / 2;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // 遮罩
    ctx.fillStyle = 'rgba(8,14,26,0.62)';
    ctx.fillRect(0, 0, W, H);
    // 卡片
    ctx.fillStyle = 'rgba(18,26,44,0.97)';
    drawRoundRect(ctx, pX, pY, pW, pH, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(255,214,140,0.45)';
    ctx.lineWidth = 2;
    drawRoundRect(ctx, pX, pY, pW, pH, 16); ctx.stroke();

    // 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe2a8';
    ctx.font = '800 ' + (font * 1.25) + 'px ' + FONT;
    ctx.fillText('成就', W / 2, pY + font * 1.7);
    ctx.font = '700 ' + (font * 0.74) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(223,242,255,0.8)';
    var done = unlockedCount(), total = ACHIEVEMENTS.length;
    ctx.fillText('已解锁 ' + done + '/' + total + ' · ' + overallProgress() + '%', W / 2, pY + font * 2.75);

    // 列表区
    var listX = pX + font * 1.2;
    var listW = pW - font * 2.4;
    var listTop = pY + font * 3.4;
    var listBottom = pY + pH - font * 1.6;
    var rowH = font * 2.5;
    var rows = panelRows(o.state);
    var visible = Math.max(1, Math.floor((listBottom - listTop) / rowH));
    var maxScroll = Math.max(0, rows.length - visible);
    var sc = clamp(scroll, 0, maxScroll);

    // 裁剪列表区，避免滚出卡片
    ctx.save();
    ctx.beginPath();
    ctx.rect(listX - 4, listTop - 4, listW + 8, listBottom - listTop + 8);
    ctx.clip();

    var lastCat = null, yy = listTop;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (i < sc) { lastCat = r.category; continue; }
      if (yy + rowH > listBottom + rowH) break;

      // 类别分隔标题
      if (r.category !== lastCat) {
        lastCat = r.category;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,226,168,0.85)';
        ctx.font = '700 ' + (font * 0.72) + 'px ' + FONT;
        ctx.fillText('— ' + r.category + ' —', listX + 2, yy + font * 0.7);
        yy += font * 1.05;
        if (yy + rowH > listBottom) break;
      }

      // 行底色
      ctx.fillStyle = r.unlocked ? 'rgba(120,200,140,0.10)' : 'rgba(255,255,255,0.045)';
      drawRoundRect(ctx, listX, yy, listW, rowH - 4, 8); ctx.fill();
      if (r.unlocked) {
        ctx.strokeStyle = 'rgba(150,235,180,0.35)';
        ctx.lineWidth = 1;
        drawRoundRect(ctx, listX, yy, listW, rowH - 4, 8); ctx.stroke();
      }

      // 名称
      ctx.textAlign = 'left';
      ctx.fillStyle = r.unlocked ? '#dfffe8' : '#ffffff';
      ctx.font = '700 ' + (font * 0.88) + 'px ' + FONT;
      ctx.fillText(r.name, listX + 10, yy + font * 0.95);

      // 状态徽标（右对齐）
      ctx.textAlign = 'right';
      ctx.font = '700 ' + (font * 0.7) + 'px ' + FONT;
      if (r.unlocked) {
        ctx.fillStyle = '#9ff0b8';
        ctx.fillText('已解锁', listX + listW - 10, yy + font * 0.95);
      } else {
        ctx.fillStyle = 'rgba(200,230,255,0.7)';
        ctx.fillText(r.pct + '%', listX + listW - 10, yy + font * 0.95);
      }

      // 描述
      ctx.textAlign = 'left';
      ctx.fillStyle = r.unlocked ? 'rgba(200,240,210,0.72)' : 'rgba(200,230,255,0.6)';
      ctx.font = '600 ' + (font * 0.68) + 'px ' + FONT;
      var descText = r.desc;
      // 按宽度截断，加省略号（Canvas 没有 text-overflow，只能自己截）
      var badgeW = font * 3.4;
      var maxDescW = listW - 20 - badgeW;
      if (ctx.measureText(descText).width > maxDescW) {
        var cut = descText;
        while (cut.length > 1 && ctx.measureText(cut + '…').width > maxDescW) cut = cut.slice(0, -1);
        descText = cut + '…';
      }
      ctx.fillText(descText, listX + 10, yy + font * 1.6);

      // 进度条
      var barW = listW - 20, barH = font * 0.34;
      drawProgressBar(ctx, listX + 10, yy + rowH - 4 - barH - font * 0.28, barW, barH,
                      r.unlocked ? 100 : r.pct,
                      r.unlocked ? '#8fd86a' : '#5fb6d8');

      yy += rowH;
    }
    ctx.restore();

    // 底部提示
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,226,168,0.8)';
    ctx.font = '700 ' + (font * 0.7) + 'px ' + FONT;
    var hint = maxScroll > 0 ? ('上下滑动浏览 · 共 ' + rows.length + ' 项 · 解锁即存档')
                             : ('共 ' + rows.length + ' 项 · 解锁即存档');
    ctx.fillText(hint, W / 2, pY + pH - font * 0.6);

    // 右上角小关闭提示（圆形 X 的纯文本版），返回矩形给命中用
    var cxW = font * 2.2, cxH = font * 1.6;
    var cxX = pX + pW - cxW - font * 0.8, cxY = pY + font * 0.7;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    drawRoundRect(ctx, cxX, cxY, cxW, cxH, cxH / 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 ' + (font * 0.78) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText('关闭', cxX + cxW / 2, cxY + cxH * 0.72);

    ctx.restore();
    return { x: pX, y: pY, w: pW, h: pH, close: { x: cxX, y: cxY, w: cxW, h: cxH },
             scroll: sc, rowH: rowH, visible: visible, maxScroll: maxScroll };
  }

  /**
   * 解锁横幅：顶部居中的一条药丸，滑入 / 停留 / 滑出都由 _toast.t 驱动。
   * 不显示时不画任何东西。
   */
  function drawToast(ctx, w, h, opts) {
    if (!usable(ctx) || !_toast) return null;
    var o = isObj(opts) ? opts : {};
    var W = num(w, 0), H = num(h, 0);
    if (W <= 0 || H <= 0) return null;
    var font = Math.max(11, num(o.font, Math.max(14, Math.min(22, Math.min(W, H) * 0.024))));
    var FONT = typeof o.fontFamily === 'string' && o.fontFamily ? o.fontFamily : FONT_DEFAULT;

    var max = Math.max(0.1, num(_toast.max, 3.2));
    var t = num(_toast.t, 0);
    // 0→0.28s 滑入，末尾 0.5s 滑出
    var enter = Math.min(1, t / 0.28);
    var exit = Math.min(1, Math.max(0, (max - t) / 0.5));
    var ease = Math.min(enter, exit);
    if (ease <= 0) return null;

    var pillW = Math.min(W * 0.9, font * 20);
    var pillH = font * 3.5;
    var x = (W - pillW) / 2;
    var y = -pillH + (pillH + font * 0.9) * ease;   // 从屏幕上方滑下来

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(20,46,30,0.94)';
    drawRoundRect(ctx, x, y, pillW, pillH, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(150,235,180,0.75)';
    ctx.lineWidth = 2;
    drawRoundRect(ctx, x, y, pillW, pillH, 12); ctx.stroke();

    // 左侧色块（代替 emoji 图标）
    ctx.fillStyle = '#9ff0b8';
    drawRoundRect(ctx, x + font * 0.55, y + pillH / 2 - font * 0.5, font * 0.22, font, font * 0.11);
    ctx.fill();

    ctx.fillStyle = '#cfffe0';
    ctx.font = '800 ' + (font * 0.64) + 'px ' + FONT;
    ctx.fillText('成就解锁', x + font * 1.15, y + font * 1.15);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 ' + (font * 0.95) + 'px ' + FONT;
    ctx.fillText(_toast.name, x + font * 1.15, y + font * 2.2);
    if (_toast.desc) {
      ctx.fillStyle = 'rgba(200,240,210,0.78)';
      ctx.font = '600 ' + (font * 0.66) + 'px ' + FONT;
      var d = _toast.desc;
      var maxW = pillW - font * 2.2;
      if (ctx.measureText(d).width > maxW) {
        while (d.length > 1 && ctx.measureText(d + '…').width > maxW) d = d.slice(0, -1);
        d = d + '…';
      }
      ctx.fillText(d, x + font * 1.15, y + font * 3.0);
    }
    ctx.restore();
    return { x: x, y: y, w: pillW, h: pillH, alpha: ease };
  }

  /* === 12. 自检（node 与游戏内都能跑） ================================= */

  /** 三个畸形快照跑一遍全部 check/progress，报告任何异常。 */
  function selfTest() {
    var problems = [];
    var malformed = [
      {},
      null,
      undefined,
      { survival: 'not-an-array', recruited: 42, buildings: 'x', zone: [], hero: null,
        diveState: 'nope', phase: 3, score: NaN, combo: 'abc', hearts: {}, water: null },
      { survival: [null, undefined, 7, { id: 'workbench' }, 'shelter'],
        buildings: [null, { id: 'cabin' }, 'shed'], recruited: [null, {}, 'x'],
        selfSustain: 'long', townReady: 'yes', pickups: 'x', diveState: { depth: 'deep', collected: 'x' } }
    ];
    for (var m = 0; m < malformed.length; m++) {
      for (var i = 0; i < ACHIEVEMENTS.length; i++) {
        var a = ACHIEVEMENTS[i];
        try {
          var c = a.check(malformed[m], freshStats());
          if (typeof c !== 'boolean') problems.push(a.id + '.check 返回非 boolean：' + typeof c);
        } catch (e) { problems.push(a.id + '.check 抛异常：' + (e && e.message)); }
        try {
          var p = a.progress(malformed[m], freshStats());
          if (!isObj(p)) problems.push(a.id + '.progress 返回非对象');
          else {
            if (typeof p.current !== 'number' || !isFinite(p.current)) problems.push(a.id + '.progress.current 非法');
            if (typeof p.target !== 'number' || !isFinite(p.target)) problems.push(a.id + '.progress.target 非法');
            if (typeof p.pct !== 'number' || p.pct < 0 || p.pct > 100) problems.push(a.id + '.progress.pct 越界：' + p.pct);
          }
        } catch (e) { problems.push(a.id + '.progress 抛异常：' + (e && e.message)); }
      }
    }
    // 唯一性
    var seen = {};
    for (var u = 0; u < ACHIEVEMENTS.length; u++) {
      if (seen[ACHIEVEMENTS[u].id]) problems.push('成就 id 重复：' + ACHIEVEMENTS[u].id);
      seen[ACHIEVEMENTS[u].id] = 1;
    }
    return { passed: problems.length === 0, problems: problems };
  }

  /* === 13. 导出 ======================================================== */

  var api = {
    VERSION: MODULE_VERSION,
    STORE_KEY: STORE_KEY,
    ACHIEVEMENTS: ACHIEVEMENTS,
    TOWN_BUILDINGS: TOWN_BUILDINGS,
    SURVIVAL_IDS: SURVIVAL_IDS,
    CASTAWAY_NAMES: CASTAWAY_NAMES,

    load: load,
    save: save,
    tick: tick,
    note: note,
    resetRun: resetRun,

    list: list,
    byId: byId,
    progressOf: progressOf,
    overallProgress: overallProgress,
    unlockedCount: unlockedCount,
    panelRows: panelRows,
    snapshot: snapshot,
    selfTest: selfTest,

    drawPanel: drawPanel,
    drawToast: drawToast,
    showToast: showToast,
    nextToast: nextToast,
    updateToast: updateToast,
    activeToast: activeToast,

    /* 测试与调试用：直接塞一份统计器（不改存档，除非随后 save()） */
    _setStats: function (stats) {
      if (isObj(stats)) { _stats = stats; _dirty = true; }
    },
    _getStats: function () { return copyObj(_stats); },
    _resetAll: function () {
      _unlocked = {}; _stats = freshStats(); _run = freshRun();
      _queue = []; _toast = null; _loaded = true; _dirty = true;
      save();
    },
    _unlockedMap: function () { return copyObj(_unlocked); }
  };

  return api;
});
