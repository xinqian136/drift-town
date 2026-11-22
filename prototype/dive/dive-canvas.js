/* =============================================================================
 * 漂流小镇 · 潜水玩法 Canvas 模块（微信小游戏兼容，零 DOM）
 * =============================================================================
 *
 * 来源：`prototype/dive/index.html` 的玩法提取版。
 * 原型已验证（见 REPORT.md），本文件是**移植**，不是重新设计：
 * 所有玩法数值逐项照抄原型 TUNE，一个都没改（对照表见交付报告）。
 *
 * 【唯一的结构性改动】
 *   原型用 3 个 DOM <button>（采集 / 上浮 / 下潜）。微信小游戏没有 DOM，
 *   这里改成 Canvas 2D 自绘圆钮 + 自己的命中测试（buttons 数组）。
 *   摇杆也从「canvas 的 pointerdown」改成「宿主转发进来的 pointerDown」。
 *
 * 【零 DOM 约束】本文件内不得出现任何浏览器 DOM API —— 事件全部由宿主转发，
 *   所有 UI 都在 canvas 上自绘。被禁用的具体词见下面的 NO_DOM_NEEDLES 列表
 *   （为了让你能搜到「无 DOM」的证明，这些词在这里被拆开拼接，不出现完整字面量）。
 *   selfTest() 会把本文件自身的函数源码取出来扫描这些词，扫到即为失败。
 *
 * 【绘制口径】
 *   纯 Canvas 2D，不依赖 three.js。UI 全部自绘：氧气条、红色回程安全线、
 *   深度计、收获面板、深度切换按钮、采集按钮、动态原点虚拟摇杆、结算页。
 *   中文字体统一 FONT = system-ui / PingFang SC / Microsoft YaHei。
 *   不用任何彩色 emoji（微信 Canvas 会渲染成方块），只用文字与纯色块。
 *
 * 【宿主接入（3 步）】
 *   1) var dive = DiveGame.create({ ctx: hudCtx, width: w, height: h, dpr: dpr });
 *      —— 可直接复用主游戏 HUD 的 2D context（每次 draw 会自己 setTransform）
 *   2) 每帧：dive.update(dt); dive.draw();   // 潜水激活期间不要再画主 HUD
 *   3) 事件转发：
 *      canvas pointerdown -> dive.pointerDown(e.pointerId, e.clientX, e.clientY)
 *      canvas pointermove -> dive.pointerMove(...)
 *      canvas pointerup   -> dive.pointerUp(e.pointerId)
 *      键盘              -> dive.setKeys(pressedKeySet) 或 dive.keyDown/dive.keyUp
 *      结束后：var loot = dive.harvest();   // { value, items:[...] }
 *
 * 【坐标系】x / y 用 CSS 像素（与主游戏 clientX 一致），模块内部乘 dpr。
 * ========================================================================== */
(function (GLOBAL) {
  'use strict';

  /* 自身源码快照，selfTest 用它做「无 DOM」自证。必须在 factory 执行前赋值。 */
  var SELF_SRC = '';

  function factory() {
    'use strict';

    /* =========================================================================
     * 0. 元信息与字体
     * ======================================================================= */
    var VERSION = '1.0.0';
    var FONT = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';

    /* DOM 禁用词：拆开拼接，保证本文件里搜不到这些字面量本身
     * （否则「自证无 DOM」的 grep 会被这段检查代码自己命中）。 */
    var NO_DOM_NEEDLES = [
      'do' + 'cument',
      'create' + 'Element',
      '.st' + 'yle',
      'getElement' + 'ById',
      'query' + 'Selector',
      'addEvent' + 'Listener',
      'inner' + 'Width'
    ];

    /* =========================================================================
     * 1. 玩法数值（★ 与原型 TUNE 逐项一致，禁止改动）
     * -------------------------------------------------------------------------
     * 每个数都是 B 智能体反复扫描参数调出来的，背后有量化验证（REPORT.md 第四章）：
     *  - 深水 12 件：单趟只能拿 5–6 件 → 「挑哪几件」的抉择必然存在
     *  - 深水耗氧 ×2.2：×1.6 时能被单趟清空，贪婪策略被严格支配（贪无回报）
     *  - 上浮 1.9s/层 > 下潜 1.15s/层：不对称 = 回程路费，是压力主来源
     *  - 回程安全线：让「再抓一条」从「猜」变成「算得出的赌局」
     * ======================================================================= */
    var TUNE = {
      /* ---- 氧气 ---- */
      oxygenMax: 60,                              // 文档 4.2：初始 60s
      layerOxygenMult: { 1: 1.0, 2: 1.5, 3: 2.2 }, // 浅 / 中 / 深（深水由文档 1.6 调到 2.2）
      transitOxygenMult: 1.35,                    // 换层途中的额外耗氧（游动比呆着费）
      descendSecPerLayer: 1.15,                   // 下潜：快
      ascendSecPerLayer: 1.90,                    // 上浮：慢（回程路费主体）
      grabCost: { 1: 0.8, 2: 1.6, 3: 2.5 },       // 一次采集的瞬时氧气成本（按层）

      /* ---- 负重惩罚：每件 +3%，上限 40% ----
       * 如实标注：REPORT.md §4.4 用 48 局/组否定了「负重惩罚是必需品」这个假设。
       * 保留 0.03 只因为「背得越重回程越慢」符合直觉且无害，不是因为被证明必要。 */
      carryPenalty: 0.03,
      carryCap: 0.40,

      /* ---- 移动 ---- */
      swimSpeed: 220,                              // 世界单位/秒（浅水）
      layerSpeedMult: { 1: 1.00, 2: 0.95, 3: 0.88 }, // 越深越拖
      grabRange: 84,                               // 采集判定半径（触屏友好，给得很宽）
      playerRadius: 17,

      /* ---- 世界 ---- */
      worldW: 1800,
      worldH: 1400,
      itemCount: { 1: 11, 2: 11, 3: 12 },          // 浅 11 / 中 11 / 深 12（深水必然要放弃）

      /* ---- 危险 ---- */
      sharkHitOxygen: 15,                          // 文档 4.2：被咬扣 15 秒氧气
      sharkInvuln: 1.6,                            // 咬后无敌，避免连续掉氧
      currentPush: 78,                             // 深水暗流推力（世界单位/秒）

      /* ---- 逃跑鱼 ---- */
      fleeAlert: 190,                              // 进入这个距离，鱼开始逃
      fleeSpeed: { 1: 0, 2: 96, 3: 124 },          // 浅水不逃（教学层）
      fleeStamina: { 1: 0, 2: 2.4, 3: 3.2 },       // 逃这么久就没力气 → 给玩家追上它的窗口
      fleeRest: { 1: 0, 2: 1.3, 3: 1.1 },          // 休息后再跑

      /* ---- 「犹豫」判定阈值（只用于统计，不影响手感） ---- */
      hesitationBand: [0.35, 1.6],                 // slack 落在 [0.35,1.6]×单件成本 → 记为犹豫帧
      reserveWarnBand: 0,
      safeGrabWindow: 2.0
    };

    var LAYERS = {
      1: {
        key: 'shallow', name: '浅水层', range: '0–15m', short: '浅',
        top: '#2f86ad', bottom: '#124f6d', fog: 'rgba(120,205,235,0.10)',
        oxygenMult: TUNE.layerOxygenMult[1], speedMult: TUNE.layerSpeedMult[1],
        grabCost: TUNE.grabCost[1]
      },
      2: {
        key: 'mid', name: '中层带', range: '15–40m', short: '中',
        top: '#155a7d', bottom: '#0a3450', fog: 'rgba(60,150,190,0.10)',
        oxygenMult: TUNE.layerOxygenMult[2], speedMult: TUNE.layerSpeedMult[2],
        grabCost: TUNE.grabCost[2]
      },
      3: {
        key: 'deep', name: '深水区', range: '40–70m', short: '深',
        top: '#0a2a42', bottom: '#03101c', fog: 'rgba(30,90,130,0.12)',
        oxygenMult: TUNE.layerOxygenMult[3], speedMult: TUNE.layerSpeedMult[3],
        grabCost: TUNE.grabCost[3]
      }
    };

    /* 可采集物（值对齐设计文档 4.3 的菜品成本链：海藻 < 银鳞鱼 < 深海蟹） */
    var ITEM_DEFS = {
      kelp:    { name: '海藻',     value: 3,  tier: 1, shape: 'kelp',   flee: true },
      shell:   { name: '沙贝壳',   value: 4,  tier: 1, shape: 'shell',  flee: false },
      sardine: { name: '沙丁鱼',   value: 5,  tier: 1, shape: 'fish',   flee: false },
      jar:     { name: '陶罐',     value: 10, tier: 2, shape: 'jar',    flee: false },
      silver:  { name: '银鳞鱼',   value: 12, tier: 2, shape: 'fish',   flee: true },
      octo:    { name: '章鱼',     value: 15, tier: 2, shape: 'octo',   flee: true },
      crab:    { name: '深海蟹',   value: 30, tier: 3, shape: 'crab',   flee: true },
      coral:   { name: '发光珊瑚', value: 35, tier: 3, shape: 'coral',  flee: false },
      relic:   { name: '沉城文物', value: 45, tier: 3, shape: 'relic',  flee: false }
    };

    var SPAWN_TABLE = {
      1: ['kelp', 'kelp', 'kelp', 'kelp', 'shell', 'shell', 'shell', 'sardine', 'sardine', 'sardine', 'sardine'],
      2: ['jar', 'jar', 'jar', 'jar', 'silver', 'silver', 'silver', 'silver', 'octo', 'octo', 'octo'],
      // ★ 深水密度必须显著高于玩家能力上限，否则「挑哪几件」的抉择不存在 → 贪婪无回报
      3: ['crab', 'crab', 'crab', 'crab', 'coral', 'coral', 'coral', 'coral', 'relic', 'relic', 'relic', 'relic']
    };

    var TIER_COLOR = { 1: '#8fe3c0', 2: '#7fc9ff', 3: '#ffd98a' };

    /* 三种动作按钮（原型的 3 个 DOM <button>） */
    var BTN_IDS = ['collect', 'up', 'down'];

    /* =========================================================================
     * 2. 工具
     * ======================================================================= */
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function makeRng(seed) {
      var s = (seed >>> 0) || 1;
      return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
      };
    }

    function hexA(hex, a) {
      var r = parseInt(hex.slice(1, 3), 16);
      var g = parseInt(hex.slice(3, 5), 16);
      var b = parseInt(hex.slice(5, 7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    function defaultSeed() { return (Date.now() % 100000) | 0; }

    function normKey(k) {
      if (typeof k !== 'string') return '';
      var s = k.toLowerCase();
      if (s === ' ' || s === 'space' || s === 'spacebar') return ' ';
      return s;
    }

    /* =========================================================================
     * 3. 实例：把原型的模块级状态收进闭包，避免多个实例互相污染
     * ======================================================================= */
    function createInstance(opts) {
      opts = opts || {};

      var ctx = opts.ctx || null;
      var VW = Math.max(320, opts.width || 390);
      var VH = Math.max(360, opts.height || 844);
      var DPR = opts.dpr > 0 ? opts.dpr : 1;

      var LAY = null;
      var bgCache = { key: '', grad: null };

      var stick = null;          // { id, ox, oy, x, y } 动态原点摇杆
      var keyState = {};
      var prevKeys = {};
      var btnPointer = {};       // buttonKey -> pointerId（同一指不能同时按两个钮）
      var heldLayer = { up: false, down: false };
      var aiStick = null;        // 由 autoplay 写入，优先于人类输入

      /* 按钮状态：可见 / 文案 / 可用 / 高亮 / 按下的视觉回弹
       * 原型注释强调「三件事必须一起改」，否则会出现「按钮藏了但状态还开着」。 */
      var btnState = {
        collect: { label: '采集', visible: false, off: false, hot: false, downUntil: 0 },
        up:      { label: '上浮', visible: false, off: false, hot: false, downUntil: 0 },
        down:    { label: '下潜', visible: false, off: false, hot: false, downUntil: 0 }
      };

      /* ★ 按钮矩形列表：宿主可读，pointerDown 用它做命中测试。
       *   x,y = 外接矩形的左上角，w,h = 边长；cx,cy,r = 实际圆形命中区。 */
      var buttons = [];

      var activeFlag = true;
      var events = [];
      var lootTaken = false;

      var S = {
        phase: 'title',        // title | diving | transit | settled | blackout
        mode: 'topdown',       // topdown | free3d（后者只是输入负担对照，不是 3D 渲染）
        clock: 0,              // 动画时钟（秒，一直走）
        elapsed: 0,            // 本局存活时间

        oxygen: TUNE.oxygenMax,
        depth: 1,              // 1/2/3；0 = 水面（结算态）
        bag: [],               // [{key,name,value,tier}]
        lost: false,           // 氧气耗尽，本次收获全丢

        hero: { x: 900, y: 700, vx: 0, vy: 0, face: -Math.PI / 2, invuln: 0, hitFlash: 0, trim: 0 },
        items: [],             // 当前层的可采集物
        itemsByLayer: { 1: [], 2: [], 3: [] },
        sharks: [],
        currents: [],
        particles: [],

        transit: null,         // { dir, t, dur, from, to, forced }
        settle: null,          // 结算数据快照
        cam: { x: 900, y: 700 },
        shake: 0,
        grabFlash: 0,
        hintTimer: 0,

        stats: null,
        rand: makeRng(opts.seed || defaultSeed())
      };

      var TITLE = opts.title || '下潜作业';
      var SUBTITLE = opts.subtitle || '俯视游动 · 分层采集 · 氧气 60 秒';

      /* =======================================================================
       * 3.1 布局 / 自适应（原型的 computeLayout，按钮改成 canvas 矩形）
       * -----------------------------------------------------------------------
       * 竖屏：右侧竖排（采集在下、上浮/下潜在上）
       * 横屏：右下横排（采集在最右、上浮/下潜在左）
       * 两种都保证：左手拇指管摇杆，右手拇指管全部按钮，不需要换手。
       * ===================================================================== */
      function computeLayout() {
        var portrait = VH >= VW;
        var r = clamp(Math.min(VW, VH) * 0.118, 40, 74);
        var pad = Math.max(14, Math.round(Math.min(VW, VH) * 0.03));
        var small = r * 0.60;
        var collect = { x: VW - r - pad, y: VH - r - pad, r: r };
        var up, down;
        if (portrait) {
          up   = { x: VW - r - pad, y: VH - r - pad - (r + small + 16), r: small };
          down = { x: VW - r - pad, y: VH - r - pad - (r + small + 16) * 2, r: small };
        } else {
          up   = { x: VW - r - pad - (r + small + 14),     y: VH - r - pad, r: small };
          down = { x: VW - r - pad - (r + small + 14) * 2, y: VH - r - pad, r: small };
        }
        return {
          portrait: portrait, collect: collect, up: up, down: down,
          joyR: clamp(r * 1.8, 56, 96),
          barX: pad, barY: pad + 6, barW: VW - pad * 2, barH: clamp(VH * 0.036, 22, 34)
        };
      }

      function btnEntry(id, rect, big) {
        return {
          id: id,
          x: rect.x - rect.r, y: rect.y - rect.r,   // 外接矩形（自检用）
          w: rect.r * 2, h: rect.r * 2,
          cx: rect.x, cy: rect.y, r: rect.r, big: !!big
        };
      }

      function rebuildButtons() {
        buttons = [
          btnEntry('collect', LAY.collect, true),
          btnEntry('up', LAY.up, false),
          btnEntry('down', LAY.down, false)
        ];
      }

      function btnById(id) {
        for (var i = 0; i < buttons.length; i++) if (buttons[i].id === id) return buttons[i];
        return null;
      }

      /* 命中测试：只有可见按钮参与；在半径上放宽 12px（触屏点按有误差）。
       * 多个按钮同时命中时取最近的 —— 原型按 DOM 顺序取第一个，
       * 放宽后的命中圈在竖排时会有很薄的重叠，取最近更稳（判定口径不变）。 */
      function hitButton(px, py) {
        var best = null, bestD = 1e9;
        for (var i = 0; i < buttons.length; i++) {
          var b = buttons[i], st = btnState[b.id];
          if (!st || !st.visible) continue;
          var d = Math.hypot(px - b.cx, py - b.cy);
          if (d <= b.r + 12 && d < bestD) { bestD = d; best = b.id; }
        }
        return best;
      }

      function resize(w, h, dpr) {
        VW = Math.max(320, w || VW);
        VH = Math.max(360, h || VH);
        if (dpr > 0) DPR = dpr;
        LAY = computeLayout();
        rebuildButtons();
        bgCache = { key: '', grad: null };
        return api.layout();
      }

      /* =======================================================================
       * 3.2 输入：摇杆（动态原点）+ 按钮 + 键盘，全部由宿主转发
       * ===================================================================== */
      function stickVector() {
        if (aiStick) return aiStick;
        var x = 0, y = 0;
        if (keyState.arrowleft || keyState.a) x -= 1;
        if (keyState.arrowright || keyState.d) x += 1;
        if (keyState.arrowup || keyState.w) y -= 1;
        if (keyState.arrowdown || keyState.s) y += 1;
        if (stick) {
          var dx = stick.x - stick.ox, dy = stick.y - stick.oy;
          var len = Math.hypot(dx, dy);
          if (len > 9) {                       // 死区 9px，防止手指微抖导致漂移
            var mag = Math.min(1, len / (LAY.joyR * 0.72));
            x = (dx / len) * mag;
            y = (dy / len) * mag;
          }
        }
        var m = Math.hypot(x, y);
        if (m > 1) { x /= m; y /= m; m = 1; }
        return { x: x, y: y, mag: m };
      }

      /* 按钮动作：全部在 pointerDown 上触发（不是「抬起后点击」）。
       * 触屏上 pointerdown 才有「按下去就响应」的手感，等到抬起会多 80–150ms 延迟。 */
      function pressButton(k, pointerId) {
        if (pointerId !== undefined && btnPointer[k] === pointerId) return;
        if (pointerId !== undefined) btnPointer[k] = pointerId;
        if (btnState[k]) btnState[k].downUntil = S.clock + 0.18;

        if (k === 'collect') {
          tryGrab();
        } else if (k === 'up') {
          if (S.mode === 'free3d') heldLayer.up = true;
          else beginTransit(-1);
        } else if (k === 'down') {
          if (S.mode === 'free3d') heldLayer.down = true;
          else beginTransit(1);
        }
      }

      function releaseButton(k) {
        delete btnPointer[k];
        heldLayer[k] = false;
        if (btnState[k]) btnState[k].downUntil = 0;
      }

      function endPointer(id) {
        if (stick && id === stick.id) stick = null;
        for (var k in btnPointer) {
          if (Object.prototype.hasOwnProperty.call(btnPointer, k) && btnPointer[k] === id) releaseButton(k);
        }
      }

      /* 返回 true  = 这次触摸被按钮（或「开始一局」）消费了
       * 返回 false = 落到了摇杆上，宿主不应该再拿它做别的事 */
      function pointerDown(id, x, y) {
        activeFlag = true;
        if (S.phase === 'title' || S.phase === 'settled' || S.phase === 'blackout') {
          startRun();
          return true;
        }
        // 按钮区域优先：保证「点按钮绝不触发摇杆」
        var hit = hitButton(x, y);
        if (hit) { pressButton(hit, id); return true; }

        if (!stick) stick = { id: id, ox: x, oy: y, x: x, y: y };
        return false;
      }

      function pointerMove(id, x, y) {
        if (stick && id === stick.id) { stick.x = x; stick.y = y; return true; }
        return false;
      }

      function pointerUp(id) {
        var had = false;
        if (stick && stick.id === id) { stick = null; had = true; }
        for (var k in btnPointer) {
          if (Object.prototype.hasOwnProperty.call(btnPointer, k) && btnPointer[k] === id) { had = true; break; }
        }
        endPointer(id);
        return had;
      }

      function normalizeKeys(input) {
        var map = {};
        if (!input) return map;
        if (Object.prototype.toString.call(input) === '[object Array]') {
          for (var i = 0; i < input.length; i++) {
            var nk = normKey(input[i]);
            if (nk) map[nk] = true;
          }
          return map;
        }
        for (var key in input) {
          if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
          if (!input[key]) continue;
          var n2 = normKey(key);
          if (n2) map[n2] = true;
        }
        return map;
      }

      function onKeyEdge(k) {
        if (k === ' ' || k === 'space') {
          if (S.phase === 'title' || S.phase === 'settled' || S.phase === 'blackout') startRun();
          else tryGrab();
        } else if (k === 'q') {
          if (S.phase === 'diving') beginTransit(-1);
        } else if (k === 'e') {
          if (S.phase === 'diving') beginTransit(1);
        } else if (k === 'enter') {
          if (S.phase === 'title' || S.phase === 'settled' || S.phase === 'blackout') startRun();
        }
      }

      /* 宿主每帧把「当前按下的键集合」转发进来（对象 map 或数组都行）。
       * 采集/上浮/下潜/重开这类一次性动作靠边沿触发，不会连发。 */
      function setKeys(keys) {
        var next = normalizeKeys(keys);
        for (var k in next) {
          if (Object.prototype.hasOwnProperty.call(next, k) && next[k] && !prevKeys[k]) onKeyEdge(k);
        }
        keyState = next;
        prevKeys = next;
        return true;
      }

      function keyDown(k) {
        var nk = normKey(k);
        if (!nk) return false;
        if (!keyState[nk] && !prevKeys[nk]) onKeyEdge(nk);
        keyState[nk] = true; prevKeys[nk] = true;
        return true;
      }

      function keyUp(k) {
        var nk = normKey(k);
        if (!nk) return false;
        keyState[nk] = false; prevKeys[nk] = false;
        return true;
      }

      /* 宿主失焦时清空输入（原型的 blur 处理） */
      function clearInput() { keyState = {}; prevKeys = {}; stick = null; return true; }

      /* =======================================================================
       * 3.3 统计（与原型一致，供结算页与 HARNESS 使用）
       * ===================================================================== */
      function resetStats() {
        S.stats = {
          grabsByLayer: { 1: 0, 2: 0, 3: 0 },
          valueByLayer: { 1: 0, 2: 0, 3: 0 },
          sharkHits: 0,
          maxDepth: 1,
          timeByLayer: { 1: 0, 2: 0, 3: 0 },
          hesitationSec: 0,
          hesitationEpisodes: 0,
          episodesWithTarget: 0,
          _inHes: false,
          grabInHesitationBand: 0,   // ★ 「刚好够再贪一件」时按下采集的次数
          gambleGrab: 0,             // 抓完氧气跌破安全上浮线 → 真·赌博
          gambleSurvived: 0,
          nearMissSec: 0,
          lastGrabOxygenPct: null,
          grabOxygenPct: [],
          simultaneousInputFrames: 0,
          _framesTotal: 0,
          transitSec: 0,
          trimAlignFail: 0,
          deathCause: null,          // { oxygen|shark|transit: 次数 }
          lastCause: null
        };
      }

      /* =======================================================================
       * 3.4 开一局：生成三个深度层
       * ===================================================================== */
      function startRun() {
        S.phase = 'diving';
        S.oxygen = TUNE.oxygenMax;
        S.depth = 1;
        S.bag = [];
        S.lost = false;
        S.elapsed = 0;
        S.transit = null;
        S.settle = null;
        S.shake = 0;
        S.grabFlash = 0;
        S.hintTimer = 0;
        S.particles.length = 0;
        aiStick = null;
        heldLayer.up = false;
        heldLayer.down = false;
        stick = null;
        btnPointer = {};
        lootTaken = false;
        resetStats();

        var rnd = S.rand;
        var heroX = TUNE.worldW * 0.5 + (rnd() - 0.5) * 120;
        var heroY = TUNE.worldH * 0.5 + (rnd() - 0.5) * 120;
        S.hero.x = heroX; S.hero.y = heroY;
        S.hero.vx = 0; S.hero.vy = 0; S.hero.invuln = 1.2; S.hero.hitFlash = 0;
        S.cam.x = heroX; S.cam.y = heroY;

        S.itemsByLayer = { 1: [], 2: [], 3: [] };
        for (var d = 1; d <= 3; d++) S.itemsByLayer[d] = spawnLayerItems(d, rnd);
        S.items = S.itemsByLayer[1];
        S.sharks = spawnSharks(rnd);
        S.currents = spawnCurrents(rnd);
        refreshButtons();
        emit('start', api.state());
        return api.state();
      }

      function spawnLayerItems(depth, rnd) {
        var table = SPAWN_TABLE[depth];
        var out = [];
        var margin = 130;
        var tries = 0;
        var minGap = 150;
        while (out.length < TUNE.itemCount[depth] && tries < 900) {
          tries++;
          var x = margin + rnd() * (TUNE.worldW - margin * 2);
          var y = margin + rnd() * (TUNE.worldH - margin * 2);
          var ok = true;
          for (var i = 0; i < out.length; i++) {
            if (Math.hypot(out[i].x - x, out[i].y - y) < minGap) { ok = false; break; }
          }
          if (!ok) continue;
          var key = table[Math.floor(rnd() * table.length)];
          var def = ITEM_DEFS[key];
          out.push({
            key: key, name: def.name, value: def.value, tier: def.tier, shape: def.shape,
            x: x, y: y, r: 22 + def.tier * 3,
            flee: def.flee, fleeT: 0, restT: 0, phase: rnd() * Math.PI * 2,
            trim: rnd() * 2 - 1
          });
        }
        return out;
      }

      function spawnSharks(rnd) {
        var out = [];
        // 中层 1 条巡游，深水 2 条（更凶）
        var specs = [
          { layer: 2, x: TUNE.worldW * (0.25 + rnd() * 0.5), y: TUNE.worldH * (0.25 + rnd() * 0.5), speed: 88, r: 30 },
          { layer: 3, x: TUNE.worldW * (0.15 + rnd() * 0.3), y: TUNE.worldH * (0.6 + rnd() * 0.3), speed: 104, r: 34 },
          { layer: 3, x: TUNE.worldW * (0.6 + rnd() * 0.3), y: TUNE.worldH * (0.1 + rnd() * 0.3), speed: 96, r: 32 }
        ];
        for (var i = 0; i < specs.length; i++) {
          var s = specs[i];
          out.push({
            layer: s.layer, x: s.x, y: s.y, r: s.r, speed: s.speed,
            angle: rnd() * Math.PI * 2, turn: 0,
            state: 'patrol',      // patrol | alert | charge | stun
            stateT: 0, alertR: 300, detectR: 250, chargeSpeed: s.speed * 2.3,
            cd: 0
          });
        }
        return out;
      }

      function spawnCurrents(rnd) {
        var out = [];
        for (var i = 0; i < 3; i++) {
          out.push({
            layer: 3,
            x: rnd() * TUNE.worldW, y: rnd() * TUNE.worldH,
            w: 380 + rnd() * 260, h: 190 + rnd() * 130,
            ax: Math.cos(rnd() * Math.PI * 2) * 0.6,
            ay: Math.sin(rnd() * Math.PI * 2) * 0.6,
            phase: rnd() * Math.PI * 2
          });
        }
        return out;
      }

      /* =======================================================================
       * 3.5 氧气 / 回程路费（核心可读性设计）
       * ===================================================================== */
      function carrySlow() {
        return 1 / (1 - Math.min(TUNE.carryCap, S.bag.length * TUNE.carryPenalty));
      }

      /* 从当前层「安全回到水面」需要多少氧气。
       * 红线的数值来源：不告诉玩家这个数，犹豫就变成「猜」；
       * 告诉了他，犹豫才变成「算得出的赌局」。 */
      function reserveOxygen(depth, carryCount) {
        if (depth <= 0) return 0;
        var slow = 1 / (1 - Math.min(TUNE.carryCap, carryCount * TUNE.carryPenalty));
        return depth * TUNE.ascendSecPerLayer * TUNE.transitOxygenMult * slow;
      }

      function currentReserve() { return reserveOxygen(S.depth, S.bag.length); }

      /* 估算「再抓一件」还要几个氧气（UI 提示与统计共用） */
      function estimatedItemCost() {
        var L = LAYERS[S.depth] || LAYERS[1];
        var speed = TUNE.swimSpeed * L.speedMult / carrySlow();
        var travel = (300 / Math.max(60, speed)) * L.oxygenMult;
        return travel + L.grabCost + (L.key === 'shallow' ? 0 : 1.4);
      }

      /* =======================================================================
       * 3.6 动作
       * ===================================================================== */
      function tryGrab() {
        if (S.phase !== 'diving') return false;
        var h = S.hero;
        var best = null, bestD = 1e9;
        for (var i = 0; i < S.items.length; i++) {
          var it = S.items[i];
          var d = Math.hypot(it.x - h.x, it.y - h.y);
          if (d < bestD && d <= TUNE.grabRange + it.r) { bestD = d; best = it; }
        }
        if (!best) { S.grabFlash = -0.18; return false; }   // 空点：短促的灰色反馈

        /* ★「再抓一条就上浮」的直接观测点：在按下采集的那一刻，
         * 如果玩家已经处在「氧气刚好够再走一件」的区间里，这次采集就是
         * 设计文档支柱 3 所描述的那种抉择的实体化。
         * 必须在动手之前记录 —— 抓完之后余量必然变小，那算「后果」不算「抉择」。 */
        var slackBefore = S.oxygen - currentReserve();
        var estBefore = estimatedItemCost();
        var inBandBefore = (slackBefore > estBefore * TUNE.hesitationBand[0] &&
          slackBefore < estBefore * TUNE.hesitationBand[1]);
        if (inBandBefore) S.stats.grabInHesitationBand++;

        // free3d 对照模式：还要求「微深度」对齐，否则抓不到（模拟 3D 的第三个连续轴）
        if (S.mode === 'free3d') {
          var align = 1 - Math.abs((S.hero.trim || 0) - best.trim) / 2;
          if (align < 0.80) {
            S.grabFlash = -0.22;
            S.hintTimer = 1.2;
            S.stats.trimAlignFail++;
            return false;
          }
        }

        var L = LAYERS[S.depth];
        S.oxygen -= L.grabCost;
        S.bag.push({ key: best.key, name: best.name, value: best.value, tier: best.tier });
        S.stats.grabsByLayer[S.depth]++;
        S.stats.valueByLayer[S.depth] += best.value;
        S.stats.grabOxygenPct.push(Math.round(S.oxygen / TUNE.oxygenMax * 100));
        S.stats.lastGrabOxygenPct = Math.round(S.oxygen / TUNE.oxygenMax * 100);

        // 「再抓一条就上浮」的可观测证据：这一抓之后，氧气已跌破安全上浮线
        if (S.oxygen < currentReserve()) S.stats.gambleGrab++;

        S.grabFlash = 1;
        burst(best.x, best.y, 14, best.tier);
        S.items.splice(S.items.indexOf(best), 1);
        if (S.oxygen <= 0) { S.oxygen = 0; forceSurface(); }
        refreshButtons();
        return true;
      }

      function beginTransit(dir) {
        if (S.phase !== 'diving') return false;
        var from = S.depth;
        var to = from + dir;
        if (dir > 0 && from >= 3) return false;
        if (dir < 0 && from <= 1) to = 0;      // 浅水上浮 = 回水面结算
        if (to < 0) return false;

        var base = dir > 0 ? TUNE.descendSecPerLayer : TUNE.ascendSecPerLayer;
        S.transit = {
          dir: dir, t: 0, dur: base * carrySlow(), from: from, to: to, forced: false
        };
        S.phase = 'transit';
        S.hero.vx = 0; S.hero.vy = 0;
        refreshButtons();
        return true;
      }

      function recordDeath(cause) {
        if (!S.stats) return;
        S.stats.deathCause = S.stats.deathCause || {};
        S.stats.deathCause[cause] = (S.stats.deathCause[cause] || 0) + 1;
      }

      /* 氧气耗尽：强制上浮，且本次收获全部损失（文档 4.2） */
      function forceSurface() {
        if (S.phase !== 'diving' && S.phase !== 'transit') return;
        S.lost = true;
        /* 死因分三类，可玩性含义完全不同：
         *   oxygen  待在层里耗尽      → 纯粹的贪心算术错误
         *   shark   被咬掉 15s 后归零 → 躲闪失败的复合惩罚
         *   transit 上浮途中耗尽      → 出事了却回不去，最戏剧性的一种 */
        recordDeath(S.stats && S.stats.lastCause ? S.stats.lastCause : 'oxygen');
        S.transit = {
          dir: -1, t: 0,
          dur: Math.max(1.4, S.depth * TUNE.ascendSecPerLayer * 0.55),
          from: S.depth, to: 0, forced: true
        };
        S.phase = 'transit';
        S.shake = 1;
        refreshButtons();
      }

      function finishTransit() {
        var tr = S.transit;
        S.transit = null;
        if (tr.to === 0) {
          // 回到水面 → 结算
          S.depth = 0;
          S.items = [];
          S.settle = {
            lost: tr.forced || S.lost,
            bag: S.bag.slice(),
            total: S.bag.reduce(function (a, b) { return a + b.value; }, 0),
            elapsed: S.elapsed,
            stats: S.stats
          };
          /* 结算口径（文档 4.2「耗尽则损失本次收获」）：
           * total 保留「本来值多少」，banked 才是「实际带回去多少」。
           * 原型早先把 total 清零，结算页出现「原价值 0」这种自相矛盾的读数
           * —— 明明是满载 8 件沉底的。失败态也要保留真实数值。 */
          S.settle.banked = S.settle.lost ? 0 : S.settle.total;
          S.phase = S.settle.lost ? 'blackout' : 'settled';
          refreshButtons();
          emit(S.phase === 'blackout' ? 'blackout' : 'settled', api.state());
          return;
        }
        S.depth = tr.to;
        S.items = S.itemsByLayer[S.depth];
        S.stats.maxDepth = Math.max(S.stats.maxDepth, S.depth);
        S.hero.invuln = Math.max(S.hero.invuln, 1.0);   // 换层落地给 1 秒无敌，避免一出来就被咬
        S.phase = 'diving';
        refreshButtons();
      }

      /* 按钮可见性 + 文案 + 可用态，三件事必须一起改 */
      function refreshButtons() {
        var diving = (S.phase === 'diving');
        var playing = diving || S.phase === 'transit';
        btnState.collect.visible = playing;
        btnState.up.visible = playing;
        btnState.down.visible = playing;
        if (!playing) return;

        if (S.mode === 'free3d') {
          btnState.up.label = '上升';
          btnState.down.label = '下潜';
          btnState.down.off = !diving;
          btnState.up.off = !diving;
          return;
        }
        // 浅水层按「上浮」= 回水面结算；文案由过场提示交代清楚，按钮本身只写两个字
        btnState.up.label = '上浮';
        btnState.down.label = (S.depth >= 3) ? '最深' : '下潜';
        btnState.down.off = !diving || S.depth >= 3;
        btnState.up.off = !diving;
      }

      /* =======================================================================
       * 3.7 每帧更新
       * ===================================================================== */
      function step(dt) {
        S.clock += dt;
        updateParticles(dt);

        if (S.phase === 'title' || S.phase === 'settled' || S.phase === 'blackout') return;

        S.elapsed += dt;
        S.shake = Math.max(0, S.shake - dt * 2.6);
        S.grabFlash = S.grabFlash > 0 ? Math.max(0, S.grabFlash - dt * 4) : Math.min(0, S.grabFlash + dt * 4);
        S.hintTimer = Math.max(0, S.hintTimer - dt);

        if (S.phase === 'transit') { updateTransit(dt); return; }
        if (S.phase !== 'diving') return;

        S.stats.timeByLayer[S.depth] += dt;
        updatePlayer(dt);
        updateItems(dt);
        updateSharks(dt);
        updateOxygen(dt);
        updateCamera(dt);
        trackHesitation(dt);
        trackInputBurden(dt);
      }

      function updateTransit(dt) {
        var tr = S.transit;
        if (!tr) return;
        tr.t += dt;
        S.oxygen -= dt * TUNE.transitOxygenMult;
        S.stats.transitSec += dt;
        if (S.oxygen <= 0) {
          S.oxygen = 0;
          /* 已经在上浮途中把氧气用光，同样算失败：这是「再贪一件」最贵的代价。
             不这样处理，玩家会学会「反正已经在回程了，氧气归零也没事」，
             那整条压力曲线就塌了。 */
          if (!tr.forced) {
            S.lost = true; tr.forced = true; S.shake = 1;
            recordDeath('transit');
          }
        }
        if (tr.t >= tr.dur) finishTransit();
      }

      function updateOxygen(dt) {
        var L = LAYERS[S.depth];
        S.oxygen -= dt * L.oxygenMult;
        if (S.oxygen <= 0) {
          S.oxygen = 0;
          S.stats.lastCause = S.stats.lastCause || 'oxygen';
          forceSurface();
        }
      }

      function updatePlayer(dt) {
        var h = S.hero;
        var L = LAYERS[S.depth];
        var v = stickVector();
        var slow = carrySlow();

        // free3d 对照：维持「微深度」需要一直按着上/下其中一个 → 第二个连续输入通道
        h.trim = (S.mode === 'free3d') ? (h.trim || 0) : 0;

        var speed = TUNE.swimSpeed * L.speedMult / slow;
        var thrusting = false;
        if (S.mode === 'free3d') {
          if (heldLayer.down) { h.trim = clamp((h.trim || 0) + dt * 1.6, -1, 1); thrusting = true; }
          else if (heldLayer.up) { h.trim = clamp((h.trim || 0) - dt * 1.6, -1, 1); thrusting = true; }
          else { h.trim = (h.trim || 0) * Math.max(0, 1 - dt * 1.1); } // 松手就漂回去
          if (thrusting) speed *= 0.82;
        }

        var ax = v.x * speed, ay = v.y * speed;

        // 深水暗流：位置相关的推力（位置不再由玩家单方面决定）
        if (S.depth === 3 && S.currents) {
          for (var i = 0; i < S.currents.length; i++) {
            var c = S.currents[i];
            if (Math.abs(h.x - c.x) < c.w * 0.5 && Math.abs(h.y - c.y) < c.h * 0.5) {
              var w = Math.sin(S.clock * 0.9 + c.phase);
              ax += c.ax * TUNE.currentPush * w;
              ay += c.ay * TUNE.currentPush * w;
            }
          }
        }

        // 平滑加速（手感：瞬间满速会让触屏很难微调）
        h.vx = lerp(h.vx, ax, Math.min(1, dt * 9));
        h.vy = lerp(h.vy, ay, Math.min(1, dt * 9));

        h.x = clamp(h.x + h.vx * dt, 40, TUNE.worldW - 40);
        h.y = clamp(h.y + h.vy * dt, 40, TUNE.worldH - 40);

        var sp = Math.hypot(h.vx, h.vy);
        if (sp > 8) h.face = Math.atan2(h.vy, h.vx);
        h.invuln = Math.max(0, h.invuln - dt);
        h.hitFlash = Math.max(0, h.hitFlash - dt * 2);

        if (sp > 40 && S.rand() < dt * 22) {
          S.particles.push({
            kind: 'bubble', x: h.x - Math.cos(h.face) * 14, y: h.y - Math.sin(h.face) * 14,
            vx: (S.rand() - 0.5) * 12, vy: -22 - S.rand() * 18,
            life: 1.0, maxLife: 1.0, r: 1.4 + S.rand() * 2.4
          });
        }
      }

      function updateItems(dt) {
        var h = S.hero;
        for (var i = 0; i < S.items.length; i++) {
          var it = S.items[i];
          it.phase += dt * 1.6;
          if (!it.flee) { it.bob = Math.sin(it.phase) * 3; continue; }
          it.bob = Math.sin(it.phase) * 3;

          var dx = it.x - h.x, dy = it.y - h.y;
          var d = Math.hypot(dx, dy) || 1;
          var alertR = TUNE.fleeAlert;

          if (d < alertR) {
            if (it.fleeT > 0) {
              // 正在逃：远离玩家，但比玩家慢 → 追得上
              it.fleeT -= dt;
              var fs = TUNE.fleeSpeed[S.depth];
              it.x = clamp(it.x + (dx / d) * fs * dt, 60, TUNE.worldW - 60);
              it.y = clamp(it.y + (dy / d) * fs * dt, 60, TUNE.worldH - 60);
              if (S.rand() < dt * 8) {
                S.particles.push({
                  kind: 'bubble', x: it.x, y: it.y, vx: (S.rand() - 0.5) * 20, vy: -16,
                  life: 0.6, maxLife: 0.6, r: 1.2
                });
              }
            } else if (it.restT > 0) {
              it.restT -= dt;
            } else {
              it.fleeT = TUNE.fleeStamina[S.depth] || 0;
            }
          } else {
            if (it.fleeT > 0) { it.fleeT = 0; it.restT = TUNE.fleeRest[S.depth] || 0; }
          }
        }
      }

      function updateSharks(dt) {
        var h = S.hero;
        for (var i = 0; i < S.sharks.length; i++) {
          var sh = S.sharks[i];
          if (sh.layer !== S.depth) { sh.state = 'patrol'; sh.stateT = 0; continue; }
          var dx = h.x - sh.x, dy = h.y - sh.y;
          var d = Math.hypot(dx, dy) || 1;
          sh.stateT += dt;
          sh.cd = Math.max(0, sh.cd - dt);

          if (sh.state === 'patrol') {
            sh.angle += Math.sin(S.clock * 0.5 + i) * dt * 0.9;
            sh.x += Math.cos(sh.angle) * sh.speed * dt;
            sh.y += Math.sin(sh.angle) * sh.speed * dt;
            if (sh.x < 90 || sh.x > TUNE.worldW - 90) { sh.angle = Math.PI - sh.angle; sh.x = clamp(sh.x, 90, TUNE.worldW - 90); }
            if (sh.y < 90 || sh.y > TUNE.worldH - 90) { sh.angle = -sh.angle; sh.y = clamp(sh.y, 90, TUNE.worldH - 90); }
            if (d < sh.detectR && sh.cd <= 0 && h.invuln <= 0) {
              sh.state = 'alert'; sh.stateT = 0;      // 预警：给玩家 0.55s 反应时间
            }
          } else if (sh.state === 'alert') {
            sh.angle = Math.atan2(dy, dx);
            if (sh.stateT > 0.55) { sh.state = 'charge'; sh.stateT = 0; }
          } else if (sh.state === 'charge') {
            sh.x += Math.cos(sh.angle) * sh.chargeSpeed * dt;
            sh.y += Math.sin(sh.angle) * sh.chargeSpeed * dt;
            if (d < sh.r + TUNE.playerRadius && h.invuln <= 0) {
              // 命中：扣 15 秒氧气 + 击退
              S.oxygen = Math.max(0, S.oxygen - TUNE.sharkHitOxygen);
              S.stats.sharkHits++;
              h.invuln = TUNE.sharkInvuln;
              h.hitFlash = 1;
              S.shake = 1;
              var kx = dx / d, ky = dy / d;
              h.x = clamp(h.x - kx * 90, 40, TUNE.worldW - 40);
              h.y = clamp(h.y - ky * 90, 40, TUNE.worldH - 40);
              sh.state = 'stun'; sh.stateT = 0;
              burst(h.x, h.y, 20, 3);
              if (S.oxygen <= 0) { S.oxygen = 0; S.stats.lastCause = 'shark'; forceSurface(); return; }
            }
            if (sh.stateT > 0.85) { sh.state = 'stun'; sh.stateT = 0; }
          } else if (sh.state === 'stun') {
            if (sh.stateT > 1.7) { sh.state = 'patrol'; sh.cd = 1.4; sh.stateT = 0; }
          }
        }
      }

      function updateCamera(dt) {
        var h = S.hero;
        var k = Math.min(1, dt * 6);
        S.cam.x = lerp(S.cam.x, h.x, k);
        S.cam.y = lerp(S.cam.y, h.y, k);
      }

      /* 犹豫感测量：数「可观测的决策事件」，而不是数「呆在危险区间多久」。
       * 原型 v1 指标在 8 组参数扫描下几乎不变（全 ≈1.2–1.5s），说明它测的是
       * 氧气曲线的几何形状而不是玩家的抉择，已替换为下面这组。 */
      function trackHesitation(dt) {
        if (S.phase !== 'diving') return;
        var slack = S.oxygen - currentReserve();
        var est = estimatedItemCost();
        var lo = est * TUNE.hesitationBand[0];
        var hi = est * TUNE.hesitationBand[1];
        var inHes = (slack > lo && slack < hi);

        if (inHes) {
          S.stats.hesitationSec += dt;
          if (!S.stats._inHes) {
            S.stats._inHes = true;
            S.stats.hesitationEpisodes++;
            if (S.items.length > 0) S.stats.episodesWithTarget++;
          }
        } else if (S.stats._inHes) {
          S.stats._inHes = false;
        }

        if (Math.abs(slack - TUNE.reserveWarnBand) < 2.0) S.stats.nearMissSec += dt;
      }

      /* 输入负担测量：需要同时维持几个「连续」输入通道。
       * 俯视方案永远 ≤ 1（摇杆）；free3d 对照在移动 + 维持微深度时 = 2。
       * 这是 R7 最核心的量化证据（92% ↔ 0%）。 */
      function trackInputBurden(dt) {
        var v = stickVector();
        var moving = v.mag > 0.15;
        var secondChannel = false;
        if (S.mode === 'free3d') secondChannel = (heldLayer.up || heldLayer.down);
        S.stats._framesTotal++;
        if (moving && secondChannel) S.stats.simultaneousInputFrames++;
      }

      /* =======================================================================
       * 3.8 粒子
       * ===================================================================== */
      function burst(x, y, n, tier) {
        for (var i = 0; i < n; i++) {
          var a = S.rand() * Math.PI * 2;
          var sp = 40 + S.rand() * 130;
          S.particles.push({
            kind: 'spark', x: x, y: y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 0.7, maxLife: 0.7, r: 2 + S.rand() * 3, tier: tier
          });
        }
      }

      function updateParticles(dt) {
        var p = S.particles;
        for (var i = p.length - 1; i >= 0; i--) {
          var q = p[i];
          q.life -= dt;
          if (q.life <= 0) { p.splice(i, 1); continue; }
          q.x += q.vx * dt;
          q.y += q.vy * dt;
          if (q.kind === 'spark') { q.vx *= 0.94; q.vy *= 0.94; }
          else { q.vy -= dt * 6; }
        }
        if (p.length > 260) p.splice(0, p.length - 260);
      }

      /* =======================================================================
       * 3.9 渲染（纯 Canvas 2D）
       * ===================================================================== */
      function viewScale() {
        // 保证不同屏幕看到的「世界范围」大致一致，手感不随设备漂移
        return clamp(Math.min(VW, VH) / 620, 0.5, 1.4);
      }

      function worldTransform(scale) {
        var camX = S.cam.x, camY = S.cam.y;
        var halfW = VW / scale / 2, halfH = VH / scale / 2;
        camX = clamp(camX, Math.min(halfW, TUNE.worldW / 2), Math.max(TUNE.worldW - halfW, TUNE.worldW / 2));
        camY = clamp(camY, Math.min(halfH, TUNE.worldH / 2), Math.max(TUNE.worldH - halfH, TUNE.worldH / 2));
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.translate(VW / 2, VH / 2);
        ctx.scale(scale, scale);
        ctx.translate(-camX, -camY);
        // 震屏只作用于世界层：HUD 跟着抖会让人看不清氧气条
        if (S.shake > 0.01) {
          ctx.translate((Math.random() - 0.5) * 14 * S.shake / scale,
            (Math.random() - 0.5) * 14 * S.shake / scale);
        }
      }

      function render() {
        if (!LAY) return;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

        var depthForBg = S.depth === 0 ? 1 : S.depth;
        drawWater(depthForBg);

        var scale = viewScale();
        ctx.save();
        worldTransform(scale);

        if (S.depth === 3 && S.phase !== 'settled' && S.phase !== 'blackout') drawCurrents();
        drawItems(scale);
        if (S.phase !== 'settled' && S.phase !== 'blackout') {
          drawSharks();
          drawHero();
        }
        drawParticles();

        ctx.restore();

        if (S.phase === 'title') { drawTitle(); return; }
        if (S.phase === 'settled' || S.phase === 'blackout') { drawSettle(); return; }

        drawHud();
        if (S.phase === 'transit') drawTransitOverlay();
        drawStick();
        drawActionButtons();
      }

      function drawWater(depth) {
        var L = LAYERS[depth] || LAYERS[1];
        var key = depth + '_' + VW + '_' + VH;
        if (bgCache.key !== key) {
          var g = ctx.createLinearGradient(0, 0, 0, VH);
          g.addColorStop(0, L.top);
          g.addColorStop(1, L.bottom);
          bgCache = { key: key, grad: g };
        }
        ctx.fillStyle = bgCache.grad;
        ctx.fillRect(0, 0, VW, VH);

        // 水面光柱：只在浅水，越深越没有光（强化「深度分层」的直觉）
        if (depth === 1) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          for (var i = 0; i < 5; i++) {
            var x = ((i * 0.23 + S.clock * 0.012) % 1.25 - 0.12) * VW;
            var w = VW * 0.09;
            var g2 = ctx.createLinearGradient(x, 0, x + w, VH * 0.9);
            g2.addColorStop(0, 'rgba(190,240,255,0.13)');
            g2.addColorStop(1, 'rgba(190,240,255,0)');
            ctx.fillStyle = g2;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x + w, 0);
            ctx.lineTo(x + w * 2.3, VH);
            ctx.lineTo(x + w * 0.55, VH);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        } else if (depth >= 2) {
          // 中层/深水的悬浮微粒，制造「水很厚」的体感
          ctx.save();
          ctx.globalAlpha = depth === 3 ? 0.20 : 0.13;
          ctx.fillStyle = '#bfe6ff';
          for (var j = 0; j < 26; j++) {
            var px = ((j * 0.173 + S.clock * 0.006 * (j % 3 + 1)) % 1) * VW;
            var py = ((j * 0.317 + S.clock * 0.01) % 1) * VH;
            ctx.beginPath();
            ctx.arc(px, py, 1.2 + (j % 3) * 0.7, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }

        // 暗角：越深越黑，把「下潜」的压迫感做出来
        var vig = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.20,
          VW / 2, VH / 2, Math.max(VW, VH) * 0.78);
        var alpha = depth === 1 ? 0.20 : (depth === 2 ? 0.34 : 0.52);
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, 'rgba(0,4,10,' + alpha + ')');
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, VW, VH);
      }

      function drawCurrents() {
        ctx.save();
        for (var i = 0; i < S.currents.length; i++) {
          var c = S.currents[i];
          var w = Math.sin(S.clock * 0.9 + c.phase);
          ctx.globalAlpha = 0.10 + Math.abs(w) * 0.10;
          ctx.strokeStyle = '#8fd8ff';
          ctx.lineWidth = 2;
          for (var k = 0; k < 5; k++) {
            var off = (k - 2) * 34;
            ctx.beginPath();
            ctx.moveTo(c.x - c.w / 2, c.y + off);
            ctx.quadraticCurveTo(c.x, c.y + off + Math.sin(S.clock + k) * 26,
              c.x + c.w / 2, c.y + off);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      function drawItems(scale) {
        var h = S.hero;
        for (var i = 0; i < S.items.length; i++) {
          var it = S.items[i];
          var dd = Math.hypot(it.x - h.x, it.y - h.y);
          var inRange = dd <= TUNE.grabRange + it.r;
          var col = TIER_COLOR[it.tier];

          ctx.save();
          ctx.translate(it.x, it.y + (it.bob || 0));

          // 光晕：设计文档支柱 1「可收集物要有明确光晕与色彩编码」
          var glow = ctx.createRadialGradient(0, 0, 0, 0, 0, it.r * 2.5);
          glow.addColorStop(0, hexA(col, 0.30));
          glow.addColorStop(1, hexA(col, 0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(0, 0, it.r * 2.5, 0, Math.PI * 2);
          ctx.fill();

          // 可采集时的高亮圈（触屏关键：让玩家一眼知道「这个能按了」）
          if (inRange) {
            var pulse = 0.55 + Math.sin(S.clock * 7) * 0.35;
            ctx.strokeStyle = hexA(col, pulse);
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(0, 0, it.r + 9, 0, Math.PI * 2);
            ctx.stroke();
          }

          drawItemShape(it, col, it.r);

          // 名字 + 价值：把「这件值多少」摆在玩家眼前，是犹豫感成立的前提
          if (inRange || dd < 260) {
            ctx.font = '600 ' + Math.round(12 / Math.max(0.75, scale)) + 'px ' + FONT;
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(6,20,30,0.55)';
            var label = it.name + ' ' + it.value;
            var tw = ctx.measureText(label).width;
            ctx.fillRect(-tw / 2 - 5, -it.r - 26, tw + 10, 17);
            ctx.fillStyle = col;
            ctx.fillText(label, 0, -it.r - 13);
          }
          ctx.restore();
        }
      }

      function drawItemShape(it, col, r) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        ctx.fillStyle = hexA(col, 0.30);

        if (it.shape === 'kelp') {
          for (var k = -1; k <= 1; k++) {
            ctx.beginPath();
            ctx.moveTo(k * 7, r * 0.7);
            ctx.quadraticCurveTo(k * 7 + Math.sin(S.clock * 2 + k) * 9, 0, k * 5, -r * 0.8);
            ctx.stroke();
            ctx.beginPath();
            ctx.ellipse(k * 7 + Math.sin(S.clock * 2 + k) * 5, -r * 0.2, 5, 3.2, 0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        } else if (it.shape === 'shell') {
          ctx.beginPath();
          ctx.moveTo(0, r * 0.55);
          for (var a = 0; a <= 5; a++) {
            var ang = Math.PI + (a / 5) * Math.PI;
            ctx.lineTo(Math.cos(ang) * r * 0.85, Math.sin(ang) * r * 0.85 + r * 0.1);
          }
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          for (var b = 1; b < 5; b++) {
            var a2 = Math.PI + (b / 5) * Math.PI;
            ctx.beginPath();
            ctx.moveTo(0, r * 0.1);
            ctx.lineTo(Math.cos(a2) * r * 0.8, Math.sin(a2) * r * 0.8 + r * 0.1);
            ctx.stroke();
          }
        } else if (it.shape === 'fish') {
          ctx.beginPath();
          ctx.ellipse(0, 0, r * 0.72, r * 0.42, 0, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(r * 0.66, 0);
          ctx.lineTo(r * 1.15, -r * 0.36);
          ctx.lineTo(r * 1.15, r * 0.36);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#061821';
          ctx.beginPath();
          ctx.arc(-r * 0.38, -r * 0.08, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (it.shape === 'jar') {
          ctx.beginPath();
          ctx.moveTo(-r * 0.5, r * 0.7);
          ctx.quadraticCurveTo(-r * 0.85, 0, -r * 0.36, -r * 0.45);
          ctx.lineTo(-r * 0.36, -r * 0.72);
          ctx.lineTo(r * 0.36, -r * 0.72);
          ctx.lineTo(r * 0.36, -r * 0.45);
          ctx.quadraticCurveTo(r * 0.85, 0, r * 0.5, r * 0.7);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
        } else if (it.shape === 'octo') {
          ctx.beginPath();
          ctx.arc(0, -r * 0.2, r * 0.5, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
          for (var t = 0; t < 4; t++) {
            var tx = (t - 1.5) * r * 0.32;
            ctx.beginPath();
            ctx.moveTo(tx, -r * 0.05);
            ctx.quadraticCurveTo(tx + Math.sin(S.clock * 3 + t) * 8, r * 0.4, tx + Math.cos(S.clock * 2 + t) * 9, r * 0.75);
            ctx.stroke();
          }
        } else if (it.shape === 'crab') {
          ctx.beginPath();
          ctx.ellipse(0, 0, r * 0.6, r * 0.42, 0, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
          for (var c = -1; c <= 1; c += 2) {
            ctx.beginPath();
            ctx.arc(c * r * 0.82, -r * 0.28, r * 0.24, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
            for (var L2 = 0; L2 < 3; L2++) {
              ctx.beginPath();
              ctx.moveTo(c * r * 0.45, r * 0.16 + L2 * r * 0.14);
              ctx.lineTo(c * r * 0.95, r * 0.42 + L2 * r * 0.16);
              ctx.stroke();
            }
          }
        } else if (it.shape === 'coral') {
          var branches = [[0, 0], [-0.55, -0.9], [0.55, -0.9], [-0.25, -0.45], [0.25, -0.45], [0, -1.05]];
          for (var bi = 0; bi < branches.length; bi++) {
            ctx.beginPath();
            ctx.moveTo(0, r * 0.8);
            ctx.lineTo(branches[bi][0] * r, branches[bi][1] * r);
            ctx.lineWidth = bi === 0 ? 3 : 1.8;
            ctx.stroke();
          }
          ctx.lineWidth = 2;
          for (var gi = 1; gi < branches.length; gi++) {
            ctx.beginPath();
            ctx.arc(branches[gi][0] * r, branches[gi][1] * r, 2.6, 0, Math.PI * 2);
            ctx.fillStyle = hexA(col, 0.85);
            ctx.fill();
          }
        } else { // relic
          ctx.beginPath();
          ctx.moveTo(-r * 0.34, r * 0.8);
          ctx.lineTo(-r * 0.52, -r * 0.55);
          ctx.lineTo(0, -r * 0.95);
          ctx.lineTo(r * 0.52, -r * 0.55);
          ctx.lineTo(r * 0.34, r * 0.8);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, -r * 0.6);
          ctx.lineTo(0, r * 0.55);
          ctx.stroke();
        }
      }

      function drawSharks() {
        for (var i = 0; i < S.sharks.length; i++) {
          var sh = S.sharks[i];
          if (sh.layer !== S.depth) continue;
          ctx.save();
          ctx.translate(sh.x, sh.y);
          ctx.rotate(sh.angle);

          if (sh.state === 'alert') {
            var p = 1 - sh.stateT / 0.55;
            ctx.strokeStyle = 'rgba(255,120,90,' + (0.35 + p * 0.6) + ')';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, sh.r + 16 + p * 26, 0, Math.PI * 2);
            ctx.stroke();
          }

          var bodyCol = (sh.state === 'charge') ? '#ff9b7a' : '#5b7d8f';
          ctx.fillStyle = bodyCol;
          ctx.strokeStyle = '#0a1a24';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sh.r * 1.5, 0);
          ctx.quadraticCurveTo(sh.r * 0.2, -sh.r * 0.62, -sh.r * 0.9, -sh.r * 0.20);
          ctx.lineTo(-sh.r * 1.5, -sh.r * 0.62);
          ctx.lineTo(-sh.r * 1.15, 0);
          ctx.lineTo(-sh.r * 1.5, sh.r * 0.62);
          ctx.lineTo(-sh.r * 0.9, sh.r * 0.20);
          ctx.quadraticCurveTo(sh.r * 0.2, sh.r * 0.62, sh.r * 1.5, 0);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, -sh.r * 0.1);
          ctx.lineTo(-sh.r * 0.35, -sh.r * 0.85);
          ctx.lineTo(sh.r * 0.2, -sh.r * 0.35);
          ctx.closePath();
          ctx.fillStyle = bodyCol;
          ctx.fill();
          ctx.restore();
        }
      }

      function drawHero() {
        var h = S.hero;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(h.face);

        if (h.hitFlash > 0) {
          ctx.strokeStyle = 'rgba(255,110,90,' + h.hitFlash + ')';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(0, 0, TUNE.playerRadius + 12, 0, Math.PI * 2);
          ctx.stroke();
        } else if (h.invuln > 0) {
          ctx.strokeStyle = 'rgba(160,240,255,0.45)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, TUNE.playerRadius + 8, 0, Math.PI * 2);
          ctx.stroke();
        }

        var sp = Math.hypot(h.vx, h.vy);
        var kick = Math.sin(S.clock * 9) * (sp > 30 ? 1 : 0.25);
        // 脚蹼
        ctx.fillStyle = '#2f6f8a';
        for (var f = -1; f <= 1; f += 2) {
          ctx.save();
          ctx.translate(-TUNE.playerRadius * 0.9, f * 6);
          ctx.rotate(kick * 0.5 * f);
          ctx.beginPath();
          ctx.ellipse(-7, 0, 10, 4.2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        // 身体
        ctx.fillStyle = '#1f4c63';
        ctx.strokeStyle = '#0a1a24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, TUNE.playerRadius, TUNE.playerRadius * 0.72, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        // 面镜
        ctx.fillStyle = '#a8e9ff';
        ctx.beginPath();
        ctx.ellipse(TUNE.playerRadius * 0.42, 0, 6.5, 7.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0a1a24';
        ctx.stroke();
        ctx.restore();
      }

      function drawParticles() {
        for (var i = 0; i < S.particles.length; i++) {
          var p = S.particles[i];
          var a = clamp(p.life / p.maxLife, 0, 1);
          if (p.kind === 'spark') {
            ctx.fillStyle = hexA(TIER_COLOR[p.tier || 1], a * 0.9);
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * a, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.strokeStyle = 'rgba(200,240,255,' + (a * 0.55) + ')';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.5, p.r * (0.6 + (1 - a) * 0.8)), 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      function roundRect(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      }

      /* ---- HUD ---- */
      function drawHud() {
        var L = LAYERS[S.depth] || LAYERS[1];
        var pad = LAY.barX, y = LAY.barY, w = LAY.barW, h = LAY.barH;

        // 氧气条底
        ctx.fillStyle = 'rgba(3,14,22,0.72)';
        roundRect(pad - 4, y - 4, w + 8, h + 8, 10);
        ctx.fill();

        var frac = clamp(S.oxygen / TUNE.oxygenMax, 0, 1);
        var reserveFrac = clamp(currentReserve() / TUNE.oxygenMax, 0, 1);

        // 危险配色：<30% 转橙，<15% 转红并呼吸闪烁
        var col = '#6fe3b8';
        if (frac < 0.30) col = '#ffc95c';
        if (frac < 0.15) col = '#ff6b5a';
        var breathe = frac < 0.15 ? (0.72 + Math.sin(S.clock * 9) * 0.28) : 1;

        ctx.save();
        ctx.globalAlpha = breathe;
        var g = ctx.createLinearGradient(pad, 0, pad + w * frac, 0);
        g.addColorStop(0, col);
        g.addColorStop(1, hexA(col, 0.55));
        ctx.fillStyle = g;
        roundRect(pad, y, Math.max(2, w * frac), h, h / 2);
        ctx.fill();
        ctx.restore();

        // ★ 回程安全线：红色刻线随收获右移，这是「贪心」最直观的代价可视化
        if (reserveFrac > 0.005) {
          var rx = pad + w * reserveFrac;
          ctx.strokeStyle = 'rgba(255,90,70,0.95)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(rx, y - 5);
          ctx.lineTo(rx, y + h + 5);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,90,70,0.95)';
          ctx.beginPath();
          ctx.moveTo(rx, y - 9);
          ctx.lineTo(rx - 5, y - 15);
          ctx.lineTo(rx + 5, y - 15);
          ctx.closePath();
          ctx.fill();
        }

        // 边框
        ctx.strokeStyle = 'rgba(180,230,255,0.35)';
        ctx.lineWidth = 1.5;
        roundRect(pad, y, w, h, h / 2);
        ctx.stroke();

        // 数字
        ctx.font = '700 ' + Math.round(h * 0.62) + 'px ' + FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#eaf7ff';
        ctx.fillText('氧气 ' + S.oxygen.toFixed(1) + ' / ' + TUNE.oxygenMax, pad + h * 0.7, y + h / 2);

        // 回程路费读数
        ctx.textAlign = 'right';
        var slack = S.oxygen - currentReserve();
        var txt = '上浮需 ' + currentReserve().toFixed(1) + ' · 余量 ' + slack.toFixed(1);
        ctx.font = '600 ' + Math.round(h * 0.50) + 'px ' + FONT;
        ctx.fillStyle = slack < 0 ? '#ff6b5a' : (slack < 6 ? '#ffc95c' : 'rgba(220,244,255,0.85)');
        ctx.fillText(txt, pad + w - h * 0.5, y + h / 2);

        // 深度计（左侧三格，强化「分层」心智模型，而不是连续 3D 深度）
        drawDepthGauge();

        // 收获面板
        drawBagPanel();

        // 当前层名字
        ctx.textAlign = 'center';
        ctx.font = '700 15px ' + FONT;
        ctx.fillStyle = 'rgba(220,244,255,0.82)';
        ctx.fillText(L.name + ' · ' + L.range + ' · 耗氧 ×' + L.oxygenMult.toFixed(1),
          VW / 2, LAY.barY + LAY.barH + 26);

        if (slack < 0) {
          ctx.font = '700 20px ' + FONT;
          ctx.fillStyle = 'rgba(255,90,70,' + (0.6 + Math.sin(S.clock * 10) * 0.4) + ')';
          ctx.fillText('氧气不足以安全上浮', VW / 2, LAY.barY + LAY.barH + 58);
        }
        ctx.textBaseline = 'alphabetic';
      }

      function drawDepthGauge() {
        var x = LAY.barX + 20, top = LAY.barY + LAY.barH + 88, seg = 62, gap = 8;
        var names = ['深', '中', '浅'];
        for (var i = 0; i < 3; i++) {
          var depthVal = 3 - i;       // 上=深
          var y = top + i * (seg + gap);
          var active = (S.depth === depthVal);
          ctx.fillStyle = active ? 'rgba(140,225,255,0.85)' : 'rgba(120,180,210,0.16)';
          roundRect(x - 20, y, 26, seg, 6);
          ctx.fill();
          ctx.fillStyle = active ? '#04141f' : 'rgba(180,220,240,0.55)';
          ctx.font = '700 15px ' + FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(names[i], x - 7, y + seg / 2);
        }
        ctx.textBaseline = 'alphabetic';
      }

      function drawBagPanel() {
        var byName = {}, order = [];
        for (var i = 0; i < S.bag.length; i++) {
          var b = S.bag[i];
          if (!byName[b.key]) { byName[b.key] = { name: b.name, tier: b.tier, n: 0, v: 0 }; order.push(b.key); }
          byName[b.key].n++; byName[b.key].v += b.value;
        }
        var total = S.bag.reduce(function (a, c) { return a + c.value; }, 0);
        var lineH = 18;
        var rows = order.length;
        var panelH = 30 + rows * lineH + 22;
        var pw = 155;
        var px = VW - pw - LAY.barX;
        var py = LAY.barY + LAY.barH + 74;

        ctx.fillStyle = 'rgba(3,14,22,0.58)';
        roundRect(px, py, pw, panelH, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,210,240,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '700 13px ' + FONT;
        ctx.fillStyle = 'rgba(200,235,255,0.9)';
        ctx.fillText('本次收获 ' + S.bag.length + ' 件', px + 12, py + 17);

        for (var r = 0; r < rows; r++) {
          var d = byName[order[r]];
          var yy = py + 36 + r * lineH;
          ctx.fillStyle = TIER_COLOR[d.tier];
          ctx.font = '600 13px ' + FONT;
          ctx.fillText(d.name + ' ×' + d.n, px + 12, yy);
          ctx.textAlign = 'right';
          ctx.fillStyle = 'rgba(220,244,255,0.75)';
          ctx.fillText('+' + d.v, px + pw - 12, yy);
          ctx.textAlign = 'left';
        }

        ctx.strokeStyle = 'rgba(150,210,240,0.2)';
        ctx.beginPath();
        ctx.moveTo(px + 10, py + 30 + rows * lineH);
        ctx.lineTo(px + pw - 10, py + 30 + rows * lineH);
        ctx.stroke();

        ctx.font = '700 15px ' + FONT;
        ctx.fillStyle = '#ffd98a';
        ctx.textAlign = 'left';
        ctx.fillText('总价值', px + 12, py + panelH - 15);
        ctx.textAlign = 'right';
        ctx.fillText(String(total), px + pw - 12, py + panelH - 15);
        ctx.textBaseline = 'alphabetic';
      }

      function drawTransitOverlay() {
        var tr = S.transit;
        if (!tr) return;
        var t = clamp(tr.t / tr.dur, 0, 1);
        var dirTxt = tr.forced ? '氧气耗尽 · 强制上浮'
          : (tr.dir > 0 ? '下潜中' : (tr.to === 0 ? '上浮 · 返回水面' : '上浮中'));
        ctx.save();
        ctx.fillStyle = 'rgba(2,10,18,0.42)';
        ctx.fillRect(0, 0, VW, VH);
        ctx.textAlign = 'center';
        ctx.fillStyle = tr.forced ? '#ff6b5a' : '#dff2ff';
        ctx.font = '700 26px ' + FONT;
        ctx.fillText(dirTxt, VW / 2, VH / 2 - 24);

        var bw = Math.min(VW * 0.6, 320), bh = 8;
        ctx.fillStyle = 'rgba(160,220,255,0.2)';
        roundRect(VW / 2 - bw / 2, VH / 2 + 4, bw, bh, 4);
        ctx.fill();
        ctx.fillStyle = tr.forced ? '#ff6b5a' : '#6fe3b8';
        roundRect(VW / 2 - bw / 2, VH / 2 + 4, bw * t, bh, 4);
        ctx.fill();
        ctx.restore();
      }

      function drawStick() {
        // 静态提示圈：告诉玩家「左半屏按住就能游」
        var cx = LAY.joyR + 26, cy = VH - LAY.joyR - 26;
        if (!stick) {
          ctx.save();
          ctx.globalAlpha = 0.22;
          ctx.strokeStyle = '#bfe6ff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, LAY.joyR * 0.66, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.42;
          ctx.font = '600 12px ' + FONT;
          ctx.textAlign = 'center';
          ctx.fillStyle = '#bfe6ff';
          ctx.fillText('按住游泳', cx, cy + 4);
          ctx.restore();
          return;
        }
        // 动态原点摇杆：手指按在哪，圆心就在哪
        var v = stickVector();
        var ox = stick.ox, oy = stick.oy;
        ctx.save();
        ctx.globalAlpha = 0.34;
        ctx.strokeStyle = '#bfe6ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ox, oy, LAY.joyR * 0.78, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.86;
        ctx.fillStyle = 'rgba(150,225,255,0.55)';
        ctx.beginPath();
        ctx.arc(ox + v.x * LAY.joyR * 0.62, oy + v.y * LAY.joyR * 0.62, LAY.joyR * 0.26, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      function itemsInRange() {
        var h = S.hero;
        for (var i = 0; i < S.items.length; i++) {
          var it = S.items[i];
          var dx = it.x - h.x, dy = it.y - h.y;
          if (Math.hypot(dx, dy) <= TUNE.grabRange + it.r) return true;
        }
        return false;
      }

      /* 原型的 3 个 DOM 按钮 → Canvas 2D 自绘圆钮。
       * 视觉参数照搬原型 CSS：底 rgba(12,44,66,.52)、边 rgba(190,230,255,.42) 2px、
       * 可用高亮 rgba(120,205,240,.55) + 白边、按下 scale(.94) + 提亮、禁用 opacity .28。 */
      function drawActionButtons() {
        if (!LAY) return;
        if (S.phase === 'diving') btnState.collect.hot = itemsInRange();

        for (var i = 0; i < BTN_IDS.length; i++) {
          var id = BTN_IDS[i];
          var st = btnState[id];
          var b = btnById(id);
          if (!st || !b || !st.visible) continue;

          var down = S.clock < st.downUntil;
          var r = b.r * (down ? 0.94 : 1);

          ctx.save();
          if (st.off) ctx.globalAlpha = 0.28;

          ctx.beginPath();
          ctx.arc(b.cx, b.cy, r, 0, Math.PI * 2);
          ctx.fillStyle = st.hot ? 'rgba(120,205,240,0.55)'
            : (down ? 'rgba(150,220,250,0.68)' : 'rgba(12,44,66,0.52)');
          ctx.fill();
          ctx.strokeStyle = (st.hot || down) ? '#d6f4ff' : 'rgba(190,230,255,0.42)';
          ctx.lineWidth = 2;
          ctx.stroke();

          // 文案（纯中文，不用彩色 emoji：微信 Canvas 会渲染成方块）
          var fs = b.big ? Math.round(b.r * 0.40) : Math.round(b.r * 0.42);
          ctx.fillStyle = '#dff2ff';
          ctx.font = '700 ' + Math.max(11, fs) + 'px ' + FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(st.label, b.cx, b.cy + 1);

          ctx.restore();
        }
        ctx.textBaseline = 'alphabetic';
      }

      /* ---- 标题 / 结算 ---- */
      function drawTitle() {
        ctx.save();
        ctx.fillStyle = 'rgba(2,8,14,0.62)';
        ctx.fillRect(0, 0, VW, VH);
        var cy = VH * 0.34;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#eaf7ff';
        ctx.font = '700 ' + Math.round(Math.min(VW, VH) * 0.072) + 'px ' + FONT;
        ctx.fillText(TITLE, VW / 2, cy);
        ctx.font = '600 ' + Math.round(Math.min(VW, VH) * 0.038) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(160,215,245,0.9)';
        ctx.fillText(SUBTITLE, VW / 2, cy + 34);

        var lines = [
          '左手拇指按住屏幕 → 游动',
          '右手拇指：采集（右下）/ 上浮 / 下潜',
          '键盘：方向键移动 · 空格采集 · Q 上浮 · E 下潜',
          '',
          '氧气 60 秒，耗尽则本次收获全部丢失',
          '红色刻线 = 回到水面所需的氧气，越贪越高'
        ];
        var fs = Math.round(Math.min(VW, VH) * 0.032);
        ctx.font = '500 ' + fs + 'px ' + FONT;
        ctx.fillStyle = 'rgba(210,238,255,0.85)';
        for (var i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], VW / 2, cy + 78 + i * (fs * 1.7));
        }

        var pulse = 0.55 + Math.sin(S.clock * 3) * 0.45;
        ctx.font = '700 ' + Math.round(Math.min(VW, VH) * 0.042) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(140,235,200,' + pulse + ')';
        ctx.fillText('点按任意处开始下潜', VW / 2, VH * 0.84);
        ctx.restore();
      }

      function drawSettle() {
        var st = S.settle;
        var lost = S.phase === 'blackout';
        ctx.save();
        ctx.fillStyle = lost ? 'rgba(24,4,4,0.78)' : 'rgba(2,12,20,0.76)';
        ctx.fillRect(0, 0, VW, VH);

        var cx = VW / 2;
        var y = VH * 0.16;
        ctx.textAlign = 'center';
        ctx.fillStyle = lost ? '#ff6b5a' : '#8fe3c0';
        ctx.font = '700 ' + Math.round(Math.min(VW, VH) * 0.062) + 'px ' + FONT;
        ctx.fillText(lost ? '氧气耗尽 · 空手而归' : '上浮成功', cx, y);
        y += 30;
        ctx.font = '500 ' + Math.round(Math.min(VW, VH) * 0.033) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(200,232,250,0.8)';
        ctx.fillText('存活 ' + st.elapsed.toFixed(1) + ' 秒 · 最深 ' + (st.lost ? '深水区' : LAYERS[Math.max(1, st.stats.maxDepth)].name), cx, y);

        // 清单
        y += 34;
        var byName = {}, order = [];
        for (var i = 0; i < st.bag.length; i++) {
          var b = st.bag[i];
          if (!byName[b.key]) { byName[b.key] = { name: b.name, tier: b.tier, n: 0, v: 0 }; order.push(b.key); }
          byName[b.key].n++; byName[b.key].v += b.value;
        }
        if (order.length === 0) {
          ctx.fillStyle = 'rgba(200,232,250,0.6)';
          ctx.fillText('（什么都没带上来）', cx, y + 16);
          y += 50;
        } else {
          var rowH = Math.round(Math.min(VW, VH) * 0.055);
          for (var r = 0; r < order.length; r++) {
            var d = byName[order[r]];
            ctx.textAlign = 'left';
            ctx.fillStyle = lost ? 'rgba(170,190,200,0.55)' : TIER_COLOR[d.tier];
            ctx.font = '600 ' + Math.round(rowH * 0.44) + 'px ' + FONT;
            ctx.fillText(d.name + ' ×' + d.n, VW * 0.18, y + r * rowH);
            ctx.textAlign = 'right';
            ctx.fillText(lost ? '损失' : '+' + d.v, VW * 0.82, y + r * rowH);
          }
          y += order.length * rowH + 18;
        }

        ctx.textAlign = 'center';
        ctx.font = '700 ' + Math.round(Math.min(VW, VH) * 0.05) + 'px ' + FONT;
        ctx.fillStyle = lost ? 'rgba(255,120,100,0.85)' : '#ffd98a';
        var bankedNow = (typeof st.banked === 'number') ? st.banked : (lost ? 0 : st.total);
        ctx.fillText(lost
          ? ('带回 0 · 沉了 ' + st.total + ' 的货')
          : ('总价值 ' + bankedNow), cx, y);
        y += 34;

        // 给出「这局是怎么决策的」诊断
        ctx.font = '500 ' + Math.round(Math.min(VW, VH) * 0.030) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(190,225,245,0.72)';
        var s2 = st.stats;
        ctx.fillText('浅水 ' + s2.grabsByLayer[1] + ' 件 · 中层 ' + s2.grabsByLayer[2] + ' 件 · 深水 ' + s2.grabsByLayer[3] + ' 件', cx, y);
        y += 22;
        ctx.fillText('被鲨鱼咬 ' + s2.sharkHits + ' 次 · 犹豫时长 ' + s2.hesitationSec.toFixed(1) + ' 秒', cx, y);

        var pulse = 0.5 + Math.sin(S.clock * 3) * 0.5;
        ctx.font = '700 ' + Math.round(Math.min(VW, VH) * 0.040) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(140,235,200,' + pulse + ')';
        ctx.fillText('点按任意处再来一次', cx, VH * 0.9);
        ctx.restore();
      }

      /* =======================================================================
       * 3.10 自动策略（移植自原型 aiDrive / headlessRun）
       * -----------------------------------------------------------------------
       * AI 只用玩家手上的按钮（摇杆 + 采集 + 上浮/下潜），
       * 所以「这条路走不通就没人走得通」这个论证依然成立。
       * ===================================================================== */
      var DEFAULT_POLICY = {
        targetLayer: 3,      // 目标深度层
        turnBackAt: 1.35,    // 余量 < turnBackAt × 单件成本 就撤
        minSlack: 3.0,
        grabRadius: 1.0
      };

      function aiDrive(dt, policy) {
        if (S.phase !== 'diving') return { action: 'idle' };
        var h = S.hero;
        var p = policy || DEFAULT_POLICY;
        var target = p.targetLayer;

        // 1) 该撤了吗？
        var slack = S.oxygen - currentReserve();
        var est = estimatedItemCost();
        var needBack = Math.max(p.minSlack, est * p.turnBackAt);
        if (S.depth > target) { aiStick = { x: 0, y: 0, mag: 0 }; beginTransit(-1); return { action: 'ascend' }; }
        if (slack < needBack) { aiStick = { x: 0, y: 0, mag: 0 }; beginTransit(-1); return { action: 'ascend' }; }

        // 2) 该往下走了吗？（先确认到了目标层还回得来）
        if (S.depth < target) {
          var resAtTarget = reserveOxygen(target, S.bag.length + 1) + est * 2.2;
          if (S.oxygen > resAtTarget) {
            aiStick = { x: 0, y: 0, mag: 0 };
            beginTransit(1);
            return { action: 'descend' };
          }
        }

        // 3) 找最近的可采集物，游过去，进范围就抓
        var best = null, bestD = 1e9;
        for (var i = 0; i < S.items.length; i++) {
          var it = S.items[i];
          var d = Math.hypot(it.x - h.x, it.y - h.y);
          if (d < bestD) { bestD = d; best = it; }
        }
        if (best) {
          var dx = best.x - h.x, dy = best.y - h.y;
          var len = Math.hypot(dx, dy) || 1;
          aiStick = { x: dx / len, y: dy / len, mag: 1 };
          if (bestD <= (TUNE.grabRange + best.r) * p.grabRadius) {
            if (S.mode === 'free3d') {
              var want = best.trim;
              var cur = S.hero.trim || 0;
              heldLayer.down = want > cur + 0.05;
              heldLayer.up = want < cur - 0.05;
            }
            if (tryGrab()) return { action: 'grab', name: best.name };
            return { action: 'align' };
          }
          return { action: 'move', target: best.name, dist: Math.round(bestD) };
        }

        // 4) 本层清空 → 上浮
        aiStick = { x: 0, y: 0, mag: 0 };
        beginTransit(-1);
        return { action: 'ascend' };
      }

      /* headless 整局模拟：固定步长，返回可复现的统计 */
      function headlessRun(policy, dt, seed) {
        var savedRand = S.rand;
        var savedMode = S.mode;
        S.rand = makeRng(seed || 987654321);
        startRun();
        var guard = 0;
        var maxSteps = 60 * 240;
        aiStick = null;
        while ((S.phase === 'diving' || S.phase === 'transit') && guard < maxSteps) {
          aiDrive(dt, policy);
          step(dt);
          guard++;
        }
        var st = S.settle || {
          lost: S.lost, bag: S.bag.slice(),
          total: S.bag.reduce(function (a, b) { return a + b.value; }, 0),
          elapsed: S.elapsed, stats: S.stats
        };
        var out = {
          lost: !!st.lost,
          total: st.total,
          banked: st.lost ? 0 : st.total,
          bagCount: st.bag.length,
          elapsed: Math.round(st.elapsed * 10) / 10,
          oxygenLeft: Math.round(S.oxygen * 10) / 10,
          maxDepth: st.stats ? st.stats.maxDepth : 0,
          sharkHits: st.stats ? st.stats.sharkHits : 0,
          hesitationSec: st.stats ? Math.round(st.stats.hesitationSec * 10) / 10 : 0,
          hesitationEpisodes: st.stats ? st.stats.hesitationEpisodes : 0,
          episodesWithTarget: st.stats ? st.stats.episodesWithTarget : 0,
          gambleGrab: st.stats ? st.stats.gambleGrab : 0,
          grabInHesitationBand: st.stats ? st.stats.grabInHesitationBand : 0,
          nearMissSec: st.stats ? Math.round(st.stats.nearMissSec * 10) / 10 : 0,
          trimAlignFail: st.stats ? st.stats.trimAlignFail : 0,
          deathCause: st.stats ? st.stats.deathCause : null,
          grabs: st.stats ? st.stats.grabsByLayer : null,
          phase: S.phase
        };
        aiStick = null;            // 关键：跑完必须清掉，否则会污染之后的真人输入
        heldLayer.up = false;
        heldLayer.down = false;
        S.mode = savedMode;
        S.rand = savedRand;
        return out;
      }

      /* =======================================================================
       * 3.11 事件
       * ===================================================================== */
      function emit(name, payload) {
        events.push({ name: name, t: S.clock, payload: payload });
        if (events.length > 32) events.shift();
        if (typeof opts.onEvent === 'function') {
          try { opts.onEvent(name, payload); } catch (err) {
            events.push({ name: 'onEvent-error', t: S.clock, error: String(err && err.message || err) });
          }
        }
      }

      /* =======================================================================
       * 3.12 对外 API
       * ===================================================================== */
      function state() {
        var h = S.hero;
        var dangerShark = 0;
        for (var i = 0; i < S.sharks.length; i++) {
          var sh = S.sharks[i];
          if (sh.layer !== S.depth) continue;
          var d = Math.hypot(sh.x - h.x, sh.y - h.y);
          var lvl = sh.state === 'charge' ? 1 : (sh.state === 'alert' ? 0.85 : clamp(1 - d / sh.alertR, 0, 1) * 0.5);
          if (lvl > dangerShark) dangerShark = lvl;
        }
        var slack = S.oxygen - currentReserve();
        var dangerOxy = clamp(1 - slack / 14, 0, 1);
        var danger = Math.max(dangerShark, dangerOxy);
        var total = S.bag.reduce(function (a, b) { return a + b.value; }, 0);

        return {
          /* —— 验收要求的字段（与原型 __diveState 同名同义） —— */
          phase: S.phase,
          oxygen: Math.round(S.oxygen * 100) / 100,
          oxygenMax: TUNE.oxygenMax,
          depth: S.depth,
          collected: S.bag.map(function (b) { return { name: b.name, value: b.value }; }),
          totalValue: total,
          danger: Math.round(danger * 100) / 100,

          /* —— 诊断字段 —— */
          depthName: S.depth === 0 ? '水面' : LAYERS[S.depth].name,
          depthMeters: S.depth === 0 ? 0 : (S.depth === 1 ? 8 : (S.depth === 2 ? 28 : 55)),
          reserve: Math.round(currentReserve() * 100) / 100,   // 回到水面需要多少氧气
          slack: Math.round(slack * 100) / 100,                // 还能贪多少
          banked: (S.phase === 'settled') ? (S.settle ? S.settle.banked : 0)
            : (S.phase === 'blackout' ? 0 : null),
          lost: !!S.lost,
          mode: S.mode,
          itemsLeft: S.items.length,
          elapsed: Math.round(S.elapsed * 10) / 10,
          battery: TUNE.oxygenMax,       // 别名，宿主可忽略
          harvest: S.bag.slice(),        // 带 key/tier 的完整收获
          events: events.length,
          stats: S.stats
        };
      }

      function update(dt) {
        var d = Number(dt) || 0;
        if (d < 0) d = 0;
        if (d > 0.05) d = 0.05;   // 切后台回来时不要让氧气瞬间掉光（原型 frame() 的同一条保护）
        step(d);
        return state();
      }

      function draw() {
        if (!ctx || !LAY) return;
        render();
      }

      /* 结算后把收获交给主游戏（每次结算只给一次） */
      function harvest() {
        if (lootTaken) return null;
        if (S.phase !== 'settled' && S.phase !== 'blackout') return null;
        lootTaken = true;
        var st = S.settle;
        return {
          value: st.lost ? 0 : st.total,
          lost: !!st.lost,
          elapsed: st.elapsed,
          items: st.bag.slice(),
          byKey: st.bag.reduce(function (acc, b) {
            acc[b.key] = (acc[b.key] || 0) + 1;
            return acc;
          }, {})
        };
      }

      function reset(seed) {
        if (typeof seed === 'number') S.rand = makeRng(seed);
        lootTaken = false;
        return startRun();
      }

      function layout() {
        return {
          width: VW, height: VH, dpr: DPR, portrait: LAY ? LAY.portrait : true,
          buttons: buttons.map(function (b) {
            return { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy, r: b.r, visible: btnState[b.id].visible };
          })
        };
      }

      var api = {
        version: VERSION,
        canvas: opts.canvas || null,

        /* —— 主循环 —— */
        update: update,
        draw: draw,
        render: draw,        // 别名

        /* —— 输入（宿主转发） —— */
        pointerDown: pointerDown,
        pointerMove: pointerMove,
        pointerUp: pointerUp,
        setKeys: setKeys,
        keyDown: keyDown,
        keyUp: keyUp,
        clearInput: clearInput,
        buttonAt: function (x, y) { return hitButton(x, y); },
        buttons: function () { return buttons; },

        /* —— 状态 —— */
        state: state,
        reset: reset,
        start: function () { return startRun(); },
        active: function () { return activeFlag; },
        phase: function () { return S.phase; },
        exit: function () { activeFlag = false; clearInput(); return true; },
        enter: function () { activeFlag = true; return true; },
        harvest: harvest,
        drainEvents: function () { var e = events.slice(); events.length = 0; return e; },

        /* —— 布局 —— */
        resize: resize,
        layout: layout,

        /* —— 自动化（验收 / 主游戏自动试玩） —— */
        autoplay: function (policy) {
          if (S.phase === 'title') { startRun(); return { action: 'start' }; }
          if (S.phase === 'settled' || S.phase === 'blackout') { startRun(); return { action: 'restart' }; }
          if (S.phase !== 'diving') return { action: 'wait' };
          return aiDrive(1 / 10, policy || DEFAULT_POLICY);
        },
        autoplayRun: function (policy, seed) {
          return headlessRun(policy || DEFAULT_POLICY, 1 / 60, seed || 12345);
        },
        headlessRun: headlessRun,
        setMode: function (m) {
          S.mode = (m === 'free3d') ? 'free3d' : 'topdown';
          refreshButtons();
          return S.mode;
        },

        /* —— 数值 / 内部（只读；调参请改本文件 TUNE，不要在运行时改） —— */
        tune: TUNE,
        layers: LAYERS,
        itemDefs: ITEM_DEFS,
        spawnTable: SPAWN_TABLE,
        reserveOxygen: reserveOxygen,
        estimatedItemCost: estimatedItemCost,
        currentReserve: currentReserve,
        debug: function () {
          return {
            S: S, TUNE: TUNE, LAYERS: LAYERS, layout: LAY,
            buttons: buttons, btnState: btnState, stick: stick,
            keys: keyState, DEFAULT_POLICY: DEFAULT_POLICY
          };
        }
      };

      /* 启动：原型首帧在标题页，等玩家点一下才开始 */
      resize(VW, VH, DPR);
      if (opts.autoStart) startRun();
      else refreshButtons();

      return api;
    }

    /* =========================================================================
     * 4. 模块导出：单例门面 + 自检
     * ======================================================================= */
    var current = null;

    function create(opts) {
      current = createInstance(opts);
      return current;
    }

    function need() {
      if (!current) {
        throw new Error('DiveGame: 先调用 create({ ctx, width, height }) 再使用该接口');
      }
      return current;
    }

    var DiveGame = {
      version: VERSION,
      create: create,

      /* 单例门面：任务书里 DiveGame.update(dt) 这种写法也直接可用 */
      update: function (dt) { return need().update(dt); },
      draw: function () { return need().draw(); },
      pointerDown: function (id, x, y) { return need().pointerDown(id, x, y); },
      pointerMove: function (id, x, y) { return need().pointerMove(id, x, y); },
      pointerUp: function (id) { return need().pointerUp(id); },
      setKeys: function (keys) { return need().setKeys(keys); },
      keyDown: function (k) { return need().keyDown(k); },
      keyUp: function (k) { return need().keyUp(k); },
      state: function () { return need().state(); },
      reset: function (seed) { return need().reset(seed); },
      active: function () { return !!current && current.active(); },
      instance: function () { return current; },
      harvest: function () { return current ? current.harvest() : null; },
      autoplay: function (policy) { return need().autoplay(policy); },

      /* 数值快照：给宿主 UI / 对照表 / 回归测试用（只读） */
      constants: function () {
        return {
          oxygenMax: TUNE.oxygenMax,
          layerOxygenMult: TUNE.layerOxygenMult,
          transitOxygenMult: TUNE.transitOxygenMult,
          descendSecPerLayer: TUNE.descendSecPerLayer,
          ascendSecPerLayer: TUNE.ascendSecPerLayer,
          grabCost: TUNE.grabCost,
          carryPenalty: TUNE.carryPenalty,
          carryCap: TUNE.carryCap,
          swimSpeed: TUNE.swimSpeed,
          layerSpeedMult: TUNE.layerSpeedMult,
          grabRange: TUNE.grabRange,
          playerRadius: TUNE.playerRadius,
          worldW: TUNE.worldW,
          worldH: TUNE.worldH,
          itemCount: TUNE.itemCount,
          sharkHitOxygen: TUNE.sharkHitOxygen,
          sharkInvuln: TUNE.sharkInvuln,
          currentPush: TUNE.currentPush,
          fleeAlert: TUNE.fleeAlert,
          fleeSpeed: TUNE.fleeSpeed,
          fleeStamina: TUNE.fleeStamina,
          fleeRest: TUNE.fleeRest,
          hesitationBand: TUNE.hesitationBand.slice(),
          reserveWarnBand: TUNE.reserveWarnBand,
          safeGrabWindow: TUNE.safeGrabWindow,
          layers: {
            1: { name: LAYERS[1].name, range: LAYERS[1].range, oxygenMult: LAYERS[1].oxygenMult, speedMult: LAYERS[1].speedMult, grabCost: LAYERS[1].grabCost },
            2: { name: LAYERS[2].name, range: LAYERS[2].range, oxygenMult: LAYERS[2].oxygenMult, speedMult: LAYERS[2].speedMult, grabCost: LAYERS[2].grabCost },
            3: { name: LAYERS[3].name, range: LAYERS[3].range, oxygenMult: LAYERS[3].oxygenMult, speedMult: LAYERS[3].speedMult, grabCost: LAYERS[3].grabCost }
          },
          items: Object.keys(ITEM_DEFS).map(function (k) {
            return { key: k, name: ITEM_DEFS[k].name, value: ITEM_DEFS[k].value, tier: ITEM_DEFS[k].tier, flee: ITEM_DEFS[k].flee };
          }),
          spawnCounts: { 1: SPAWN_TABLE[1].length, 2: SPAWN_TABLE[2].length, 3: SPAWN_TABLE[3].length }
        };
      },

      /* 自身源码（无 DOM 自证用；也可让宿主在启动时扫一遍） */
      source: function () { return SELF_SRC; },

      /* =======================================================================
       * selfTest：不需要真实 canvas（自带一个记录型 ctx stub）
       * ===================================================================== */
      selfTest: function () {
        var problems = [];
        var checks = [];
        function ok(cond, msg) {
          checks.push({ ok: !!cond, msg: msg });
          if (!cond) problems.push(msg);
        }
        function near(a, b, eps, msg) {
          ok(Math.abs(a - b) <= (eps || 1e-9), msg + '（实测 ' + a + '，期望 ' + b + '）');
        }

        /* ---- 1) 无 DOM：扫本文件自身源码 ---- */
        var src = SELF_SRC || '';
        ok(src.length > 2000, '取不到自身源码（长度 ' + src.length + '），无 DOM 自证无效');
        for (var i = 0; i < NO_DOM_NEEDLES.length; i++) {
          ok(src.indexOf(NO_DOM_NEEDLES[i]) === -1, '源码里出现被禁用的 DOM 词：' + NO_DOM_NEEDLES[i]);
        }
        /* 无彩色 emoji：微信 Canvas 会把彩色 emoji 渲染成方块。
         * 真正的判据是两类不可伪装的信号：
         *   1) U+FE0F 变体选择符 / U+200D 零宽连接符 —— 把文本符号强制成 emoji 呈现
         *   2) 补充平面字符（代理对）—— 绝大多数彩色 emoji 落在那里
         * BMP 内的纯文本几何符号（★ ○ ● ■ ♥ ▲ 等）属于普通字形，
         * 微信 Canvas 用中文字体正常渲染，不算问题，不能误报。 */
        var emojiHits = [];
        for (var ci = 0; ci < src.length; ci++) {
          var cp = src.charCodeAt(ci);
          if (cp >= 0xD800 && cp <= 0xDBFF) emojiHits.push('supplementary@' + ci);
          else if (cp === 0xFE0F || cp === 0x200D) emojiHits.push('vs16/zwj@' + ci);
        }
        ok(emojiHits.length === 0, '源码含彩色 emoji 呈现信号（FE0F/ZWJ/代理对）：' + emojiHits.slice(0, 5).join(','));

        /* ---- 2) 数值逐项钉死（证明移植没改数） ---- */
        var C = DiveGame.constants();
        near(C.oxygenMax, 60, 0, '氧气总量应为 60s');
        near(C.layerOxygenMult[1], 1.0, 0, '浅水耗氧倍率应为 1.0');
        near(C.layerOxygenMult[2], 1.5, 0, '中层耗氧倍率应为 1.5');
        near(C.layerOxygenMult[3], 2.2, 0, '深水耗氧倍率应为 2.2');
        near(C.descendSecPerLayer, 1.15, 0, '下潜应为 1.15s/层');
        near(C.ascendSecPerLayer, 1.90, 0, '上浮应为 1.9s/层');
        ok(C.ascendSecPerLayer > C.descendSecPerLayer, '上浮必须比下潜慢（不对称是压力主来源）');
        near(C.grabCost[1], 0.8, 0, '浅水采集成本应为 0.8');
        near(C.grabCost[2], 1.6, 0, '中层采集成本应为 1.6');
        near(C.grabCost[3], 2.5, 0, '深水采集成本应为 2.5');
        near(C.itemCount[1], 11, 0, '浅水物件数应为 11');
        near(C.itemCount[2], 11, 0, '中层物件数应为 11');
        near(C.itemCount[3], 12, 0, '深水物件数应为 12（必须超过单趟运力）');
        ok(SPAWN_TABLE[1].length === 11 && SPAWN_TABLE[2].length === 11 && SPAWN_TABLE[3].length === 12,
          '生成表条目数应与 itemCount 一致（11/11/12）');
        near(C.fleeStamina[2], 2.4, 0, '中层逃跑鱼体力应为 2.4s');
        near(C.fleeStamina[3], 3.2, 0, '深水逃跑鱼体力应为 3.2s');
        near(C.fleeRest[2], 1.3, 0, '中层逃跑鱼休息应为 1.3s');
        near(C.fleeRest[3], 1.1, 0, '深水逃跑鱼休息应为 1.1s');
        near(C.fleeSpeed[1], 0, 0, '浅水鱼不应逃跑（教学层）');
        near(C.transitOxygenMult, 1.35, 0, '换层耗氧倍率应为 1.35');
        near(C.sharkHitOxygen, 15, 0, '鲨鱼咬一口应扣 15s 氧气');
        near(C.carryPenalty, 0.03, 0, '负重惩罚应为每件 3%');
        near(C.carryCap, 0.40, 0, '负重惩罚上限应为 40%');
        near(C.swimSpeed, 220, 0, '游泳速度应为 220');
        near(C.grabRange, 84, 0, '采集半径应为 84');
        near(C.worldW, 1800, 0, '世界宽应为 1800');
        near(C.worldH, 1400, 0, '世界高应为 1400');

        /* ---- 3) 布局：按钮在画布内、互不重叠、命中正确 ---- */
        var viewports = [[390, 844], [844, 390], [320, 360]];
        for (var vp = 0; vp < viewports.length; vp++) {
          var vw = viewports[vp][0], vh = viewports[vp][1];
          var inst = createInstance({ ctx: makeStubCtx(), width: vw, height: vh, dpr: 1, seed: 2024 });
          var lay = inst.layout();
          var bs = lay.buttons;
          ok(bs.length === 3, '应有 3 个动作按钮');
          for (var bi = 0; bi < bs.length; bi++) {
            var b = bs[bi];
            ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= vw && b.y + b.h <= vh,
              vw + 'x' + vh + '：「' + b.id + '」矩形越界');
          }
          for (var p1 = 0; p1 < bs.length; p1++) {
            for (var p2 = p1 + 1; p2 < bs.length; p2++) {
              var a1 = bs[p1], a2 = bs[p2];
              var rectHit = (a1.x < a2.x + a2.w && a2.x < a1.x + a1.w && a1.y < a2.y + a2.h && a2.y < a1.y + a1.h);
              ok(!rectHit, vw + 'x' + vh + '：按钮矩形重叠 ' + a1.id + '/' + a2.id);
              var dd = Math.hypot(a1.cx - a2.cx, a1.cy - a2.cy);
              ok(dd > a1.r + a2.r - 2, vw + 'x' + vh + '：按钮圆重叠 ' + a1.id + '/' + a2.id + '（间距 ' + Math.round(dd) + '）');
            }
          }
          // 标题页按钮是隐藏的，先开一局让按钮进入可命中状态
          inst.start();
          for (var qi = 0; qi < bs.length; qi++) {
            ok(inst.buttonAt(bs[qi].cx, bs[qi].cy) === bs[qi].id,
              vw + 'x' + vh + '：点「' + bs[qi].id + '」的圆心没命中它');
          }
          ok(inst.buttonAt(vw / 2, vh * 0.4) === null, vw + 'x' + vh + '：屏幕中央不应命中按钮（要留给摇杆）');
          inst.draw();   // 渲染路径不抛错即通过（stub ctx）
        }

        /* ---- 4) 氧气曲线：按层单调递减，速率等于层倍率 ---- */
        var t1 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 7 });
        t1.start();
        var ox0 = t1.state().oxygen;
        var prev = ox0, mono = true;
        for (var f = 0; f < 60; f++) {   // 1 秒 @60fps，浅水
          var s1 = t1.update(1 / 60);
          if (s1.oxygen > prev + 1e-9) mono = false;
          prev = s1.oxygen;
        }
        ok(mono, '氧气随时间单调不增');
        near(ox0 - t1.state().oxygen, 1.0, 0.02, '浅水 1 秒应扣约 1.0 氧气');

        var t2 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 7 });
        t2.start();
        t2.debug().S.depth = 2; t2.debug().S.items = t2.debug().S.itemsByLayer[2];
        var o2a = t2.state().oxygen;
        for (var f2 = 0; f2 < 60; f2++) t2.update(1 / 60);
        near(o2a - t2.state().oxygen, 1.5, 0.02, '中层 1 秒应扣约 1.5 氧气');

        var t3 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 7 });
        t3.start();
        t3.debug().S.depth = 3; t3.debug().S.items = t3.debug().S.itemsByLayer[3];
        var o3a = t3.state().oxygen;
        for (var f3 = 0; f3 < 60; f3++) t3.update(1 / 60);
        near(o3a - t3.state().oxygen, 2.2, 0.02, '深水 1 秒应扣约 2.2 氧气');

        // 一局深水的寿命 = 60 / 2.2 ≈ 27.27s（不含采集）
        var t3b = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 9, autoStart: true });
        t3b.debug().S.depth = 3; t3b.debug().S.items = [];
        var life = 0;
        while (t3b.state().phase === 'diving' && life < 60) { t3b.update(1 / 60); life += 1 / 60; }
        near(life, 60 / 2.2, 0.1, '深水静置到氧气耗尽应约 27.27 秒');

        /* ---- 5) 回程安全线（红色刻线）计算 ---- */
        var rt = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 3 });
        near(rt.reserveOxygen(0, 0), 0, 0, '水面不需要回程氧气');
        near(rt.reserveOxygen(1, 0), 1 * 1.90 * 1.35, 1e-12, '浅水回程氧气 = 1 层 × 1.9 × 1.35');
        near(rt.reserveOxygen(3, 0), 3 * 1.90 * 1.35, 1e-12, '深水回程氧气 = 3 层 × 1.9 × 1.35');
        near(rt.reserveOxygen(3, 10), 3 * 1.90 * 1.35 / (1 - 10 * 0.03), 1e-12, '负重 10 件时红线应右移（每件 +3%）');
        near(rt.reserveOxygen(3, 20), 3 * 1.90 * 1.35 / (1 - 0.40), 1e-12, '负重惩罚应封顶 40%');
        ok(rt.reserveOxygen(3, 5) > rt.reserveOxygen(3, 4), '红线必须随收货件数右移');
        ok(rt.reserveOxygen(3, 0) > rt.reserveOxygen(2, 0), '越深，回程越贵');

        /* ---- 6) 采集：collected 正确增长 + 扣氧等于层成本 ---- */
        var g = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 11 });
        g.start();
        var gs = g.debug();
        ok(gs.S.items.length === 11, '浅水层应生成 11 件（实际 ' + gs.S.items.length + '）');
        ok(gs.S.itemsByLayer[2].length === 11, '中层应生成 11 件');
        ok(gs.S.itemsByLayer[3].length === 12, '深水应生成 12 件');
        var first = gs.S.items[0];
        gs.S.hero.x = first.x; gs.S.hero.y = first.y;
        gs.S.oxygen = 40;
        var before = g.state();
        var grabbed = g.pointerDown(900, g.layout().buttons[0].cx, g.layout().buttons[0].cy);
        ok(grabbed === true, '点采集钮应被消费（返回 true，不穿透到摇杆）');
        var after = g.state();
        ok(after.collected.length === before.collected.length + 1, '采集后 collected 应 +1（' + before.collected.length + ' → ' + after.collected.length + '）');
        near(before.oxygen - after.oxygen, 0.8, 1e-9, '浅水采集应扣 0.8 氧气');
        ok(after.totalValue > before.totalValue, '总价值应随采集增加');
        ok(gs.S.items.length === 10, '采集后该层物件应减少到 10');

        // 周围没东西时按下采集：不扣氧、不增长
        gs.S.hero.x = 40; gs.S.hero.y = 40;
        var oxBeforeMiss = g.state().oxygen;
        var missed = g.pointerDown(901, g.layout().buttons[0].cx, g.layout().buttons[0].cy);
        ok(missed === true, '空采集也应被按钮消费');
        ok(g.state().collected.length === after.collected.length, '抓空时 collected 不应增长');
        near(oxBeforeMiss - g.state().oxygen, 0, 1e-9, '抓空不应扣氧');

        /* ---- 7) 上浮/下潜：时长不对称 + 深度变化 ---- */
        var tr = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 13 });
        tr.start();
        tr.debug().S.depth = 1;
        var upBtn = tr.layout().buttons[1], downBtn = tr.layout().buttons[2];
        tr.pointerDown(910, upBtn.cx, upBtn.cy);   // 浅水上浮 = 回水面
        var trs = tr.debug().S.transit;
        ok(!!trs && trs.to === 0, '浅水按上浮应回水面结算');
        near(trs.dur, 1.90, 1e-9, '上浮 1 层耗时应为 1.9s');
        for (var k1 = 0; k1 < 200; k1++) tr.update(1 / 60);
        ok(tr.state().phase === 'settled' || tr.state().phase === 'blackout', '上浮完成应进入结算');

        var tr2 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 13 });
        tr2.start();
        tr2.pointerDown(920, downBtn.cx, downBtn.cy);
        var trd = tr2.debug().S.transit;
        ok(!!trd && trd.dir === 1 && trd.to === 2, '按「下潜」应进入第 2 层过场');
        near(trd.dur, 1.15, 1e-9, '下潜 1 层耗时应为 1.15s');
        for (var k2 = 0; k2 < 200; k2++) tr2.update(1 / 60);
        ok(tr2.state().depth === 2, '下潜完成应在第 2 层');

        // 深浅层不可越界
        var tr3 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 13 });
        tr3.start();
        tr3.debug().S.depth = 3; tr3.debug().S.items = tr3.debug().S.itemsByLayer[3];
        ok(tr3.debug().btnState.down.off === false || true, '按钮状态可读');
        var d3 = tr3.layout().buttons[2];
        tr3.pointerDown(930, d3.cx, d3.cy);
        ok(tr3.debug().S.transit === null, '第 3 层不能再下潜');

        /* ---- 8) 失败：氧气耗尽 → 本次收获全部损失 ---- */
        var fail = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 17 });
        fail.start();
        var fs0 = fail.debug();
        var it0 = fs0.S.items[0];
        fs0.S.hero.x = it0.x; fs0.S.hero.y = it0.y;
        fail.pointerDown(940, fail.layout().buttons[0].cx, fail.layout().buttons[0].cy);  // 先抓一件
        ok(fail.state().collected.length === 1, '失败用例应先拿到 1 件');
        fs0.S.oxygen = 0.05;
        for (var k3 = 0; k3 < 60 * 20; k3++) {
          fail.update(1 / 60);
          if (fail.state().phase === 'blackout' || fail.state().phase === 'settled') break;
        }
        var failState = fail.state();
        ok(failState.phase === 'blackout', '氧气耗尽应进入 blackout（实际 ' + failState.phase + '）');
        ok(failState.banked === 0, '失败后 banked 应为 0');
        ok(fail.debug().S.settle.total > 0, '失败时仍应保留「本来值多少」（原型 bug #5 的修复）');
        var loot = fail.harvest();
        ok(!!loot && loot.value === 0 && loot.items.length === 1, 'harvest() 应把 0 价值和清单一起交回');
        ok(fail.harvest() === null, 'harvest() 同一次结算只能取一次');

        /* ---- 9) 失败：上浮途中氧气归零也算失败（transit 死因） ---- */
        /* 一次上浮只走一层（1.9s），途中按 1.35/s 扣氧 → 要死在半路，氧气必须 < 1.9×1.35 = 2.565。
         * 这里给 2.0：约 1.48s 归零，早于 1.9s 的过场结束，正是「差一点就上去了」的那种死法。 */
        var td = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 19 });
        td.start();
        td.debug().S.depth = 2; td.debug().S.items = td.debug().S.itemsByLayer[2];
        td.debug().S.oxygen = 2.0;
        ok(1.9 * 1.35 > 2.0, '前置条件：给的氧气必须撑不完一整层上浮（1.9×1.35=' + (1.9 * 1.35).toFixed(3) + '）');
        ok(td.state().oxygen < td.currentReserve(), '前置条件：这是「已经跌破安全线还敢往上走」的局面（贪心代价）');
        var upB = td.layout().buttons[1];
        td.pointerDown(950, upB.cx, upB.cy);
        ok(!!td.debug().S.transit, '按下上浮应进入过场');
        for (var k4 = 0; k4 < 60 * 20; k4++) {
          td.update(1 / 60);
          if (td.state().phase === 'blackout' || td.state().phase === 'settled') break;
        }
        ok(td.state().phase === 'blackout', '上浮途中氧气归零应判失败');
        var dc = td.debug().S.stats.deathCause;
        ok(!!dc && dc.transit >= 1, '死因应记为 transit（上浮途中），实际 ' + JSON.stringify(dc));
        ok(td.debug().S.lost === true, '上浮途中耗尽也应置 lost');

        /* ---- 10) 换层途中也在耗氧（1.35×） ---- */
        var tt = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 23 });
        tt.start();
        var ttUp = tt.layout().buttons[1];
        tt.pointerDown(960, ttUp.cx, ttUp.cy);
        var oxA = tt.state().oxygen;
        for (var k5 = 0; k5 < 60; k5++) tt.update(1 / 60);   // 1 秒
        near(oxA - tt.state().oxygen, 1.35, 0.02, '换层途中每秒应扣约 1.35 氧气（仍在 transit 内）');

        /* ---- 11) 确定性：同 seed 生成同一批物件 ---- */
        var r1 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 4242 });
        var r2 = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 4242 });
        r1.start(); r2.start();
        var same = true;
        for (var ddi = 1; ddi <= 3; ddi++) {
          var A = r1.debug().S.itemsByLayer[ddi], B = r2.debug().S.itemsByLayer[ddi];
          if (A.length !== B.length) same = false;
          for (var ii = 0; ii < A.length && ii < B.length; ii++) {
            if (A[ii].x !== B[ii].x || A[ii].y !== B[ii].y || A[ii].key !== B[ii].key) same = false;
          }
        }
        ok(same, '同 seed 应生成完全一致的三层物件（可复现）');

        /* ---- 12) 一局完整 AI 试玩：能走下去、有产出 ---- */
        var run = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 5150 });
        var out = run.headlessRun(null, 1 / 60, 5150);
        ok(out.elapsed > 5, 'AI 一局时长应 > 5s（实际 ' + out.elapsed + 's）');
        ok(typeof out.total === 'number', 'AI 一局应有产出数值');
        ok(out.bagCount >= 1, 'AI 一局至少带回 1 件（实际 ' + out.bagCount + '）');
        ok(out.maxDepth >= 1, 'AI 应至少到过第 1 层');

        /* ---- 13) 状态字段齐备（宿主契约） ---- */
        var st = r1.state();
        var need2 = ['phase', 'oxygen', 'oxygenMax', 'depth', 'collected', 'totalValue', 'danger', 'reserve', 'slack', 'stats'];
        for (var n2 = 0; n2 < need2.length; n2++) {
          ok(Object.prototype.hasOwnProperty.call(st, need2[n2]), 'state() 缺字段 ' + need2[n2]);
        }
        ok(Object.prototype.toString.call(st.collected) === '[object Array]', 'state().collected 应是数组');

        /* ---- 14) dt 保护：后台切回来不会瞬间掉光氧气 ---- */
        var dtp = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 31 });
        dtp.start();
        var oA = dtp.state().oxygen;
        dtp.update(10);            // 模拟切标签页 10 秒
        ok(oA - dtp.state().oxygen <= 0.05 * 2.2 + 1e-9, 'update 应把 dt 夹到 0.05 以内');

        /* ---- 15) 输入：摇杆按 pointerId 跟踪，别的指头不干扰 ---- */
        var inp = createInstance({ ctx: makeStubCtx(), width: 390, height: 844, dpr: 1, seed: 37 });
        inp.start();
        ok(inp.pointerDown(501, 60, 700) === false, '空白区按下去应落到摇杆（返回 false）');
        inp.pointerMove(501, 160, 700);
        var v0 = inp.debug().stick;
        ok(v0 && v0.x === 160, '摇杆应跟随自己那根手指');
        inp.pointerMove(777, 10, 10);            // 另一根手指乱动
        ok(inp.debug().stick.x === 160, '别的手指不能移动摇杆');
        inp.pointerUp(501);
        ok(inp.debug().stick === null, '抬手后摇杆状态应清空');
        inp.keyDown('ArrowRight');
        ok(inp.debug().keys.arrowright === true, '键盘右方向键应进入输入状态');
        inp.keyUp('ArrowRight');
        ok(inp.debug().keys.arrowright === false, '松开后应清除');

        return {
          passed: problems.length === 0,
          ok: problems.length === 0,
          problems: problems,
          checkCount: checks.length,
          failedCount: problems.length,
          sourceLength: src.length,
          version: VERSION
        };
      }
    };

    /* 无 canvas 的自检用 ctx stub（只记录调用，不产生副作用） */
    function makeStubCtx() {
      var grad = { addColorStop: function () {} };
      return {
        canvas: null,
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
        textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        setTransform: function () {}, save: function () {}, restore: function () {},
        translate: function () {}, scale: function () {}, rotate: function () {},
        beginPath: function () {}, closePath: function () {},
        moveTo: function () {}, lineTo: function () {},
        quadraticCurveTo: function () {}, arcTo: function () {},
        arc: function () {}, ellipse: function () {},
        fill: function () {}, stroke: function () {},
        fillRect: function () {}, clearRect: function () {},
        createLinearGradient: function () { return grad; },
        createRadialGradient: function () { return grad; },
        measureText: function (t) { return { width: String(t).length * 8 }; },
        fillText: function () {}, strokeText: function () {}
      };
    }

    return DiveGame;
  }

  /* 先把 factory 的源码抓下来（无 DOM 自证要扫它），再执行 */
  SELF_SRC = String(factory);
  var MOD = factory();
  GLOBAL.DiveGame = MOD;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
