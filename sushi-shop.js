/**
 * 漂流小镇 · 寿司店与食材经济
 * =============================================================================
 * 把「潜水采集 → 食材入库 → 寿司店做菜 → 卖钱」这条链接通，也就是设计文档
 * 阶段 4 的核心闭环。同时是 achievements.js / leaderboard.js 同款零依赖 IIFE，
 * 挂在 window.SushiShop 上。
 *
 * 设计边界（别当已验证）：
 *   - 这是本地模拟经营，没有真实客人与真实经济系统。
 *   - 菜谱来自 data/recipes.json 的精华（内联，不读文件）。
 *   - 没有后端：利润、口碑都是本地数值，不会跨设备同步。
 *   - 绘制的都是 Canvas 2D 函数，收 ctx，不碰 DOM。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.SushiShop = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var MODULE_VERSION = '1.0.0';
  var SAVE_KEY = 'drift-town:sushi:v1';

  /* ==== 食材（潜水带回来的东西） ==== */
  var INGREDIENTS = {
    seaweed:      { name: '海藻',   tier: 1, from: 'dive' },
    clam:         { name: '贝类',   tier: 1, from: 'dive' },
    squid:        { name: '墨鱼',   tier: 2, from: 'dive' },
    silverScale:  { name: '银鳞鱼', tier: 3, from: 'dive' },
    seaUrchin:    { name: '海胆',   tier: 3, from: 'dive' },
    fishRoe:      { name: '鱼子',   tier: 3, from: 'dive' },
    deepKelp:     { name: '深海藻', tier: 3, from: 'dive' },
    deepCrab:     { name: '深海蟹', tier: 4, from: 'dive' },
    rice:         { name: '米',     tier: 1, from: 'market' }
  };

  /* ==== 菜谱（来自 data/recipes.json 的精华） ==== */
  var RECIPES = [
    { id: 'seaweedRoll',    name: '海藻卷',       tier: 1, need: { seaweed: 2, rice: 1 },              cookTime: 12, basePrice: 8,  priceRange: [15, 22],  rep: 1 },
    { id: 'clamSashimi',    name: '贝类刺身',     tier: 1, need: { clam: 2, rice: 1 },                 cookTime: 14, basePrice: 10, priceRange: [16, 24],  rep: 1 },
    { id: 'kelpSoup',       name: '海藻汤',       tier: 1, need: { seaweed: 1, deepKelp: 1 },          cookTime: 20, basePrice: 12, priceRange: [18, 26],  rep: 2 },
    { id: 'grilledSkewer',  name: '烤串',         tier: 2, need: { squid: 1, silverScale: 1 },         cookTime: 18, basePrice: 16, priceRange: [26, 38],  rep: 2 },
    { id: 'squidGunkan',    name: '墨鱼军舰',     tier: 2, need: { squid: 1, seaweed: 1, rice: 1 },    cookTime: 22, basePrice: 20, priceRange: [32, 46],  rep: 3 },
    { id: 'silverScaleNigiri', name: '银鳞握寿司', tier: 3, need: { silverScale: 1, rice: 1 },         cookTime: 16, basePrice: 12, priceRange: [28, 40],  rep: 3 },
    { id: 'seaUrchinBowl',  name: '海胆盖饭',     tier: 3, need: { seaUrchin: 1, rice: 2 },            cookTime: 24, basePrice: 22, priceRange: [42, 58],  rep: 4 },
    { id: 'roeGunkan',      name: '鱼子军舰',     tier: 3, need: { fishRoe: 1, seaweed: 1, rice: 1 },  cookTime: 26, basePrice: 26, priceRange: [46, 64],  rep: 4 },
    { id: 'deepCrabGunkan', name: '深海蟹肉军舰', tier: 4, need: { deepCrab: 1, seaweed: 1, deepKelp: 1 }, cookTime: 32, basePrice: 30, priceRange: [75, 98], rep: 6 },
    { id: 'abyssPlatter',   name: '深渊拼盘',     tier: 4, need: { deepCrab: 1, squid: 1, seaUrchin: 1, rice: 2 }, cookTime: 45, basePrice: 58, priceRange: [120, 160], rep: 10 }
  ];

  /* ==== 状态 ==== */
  var state = {
    open: false,            // 寿司店是否已建成
    stock: {},              // ingredientId -> 数量
    menu: [],               // 上架菜谱 id（最多 menuSlots 道）
    menuSlots: 3,
    menuSlotsMax: 6,
    price: {},              // recipeId -> 玩家定价
    coins: 0,
    reputation: 0,
    daySold: 0,
    lastSettle: null,
    history: []             // 最近几天的结算
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ==== 存档 ==== */
  function load() {
    try {
      var s = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (!s) return false;
      var raw = s.getItem(SAVE_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      state.open = !!d.open;
      state.stock = d.stock || {};
      state.menu = d.menu || [];
      state.menuSlots = d.menuSlots || 3;
      state.price = d.price || {};
      state.coins = d.coins || 0;
      state.reputation = d.reputation || 0;
      return true;
    } catch (e) { return false; }
  }
  function save() {
    try {
      var s = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (!s) return false;
      s.setItem(SAVE_KEY, JSON.stringify({
        open: state.open, stock: state.stock, menu: state.menu,
        menuSlots: state.menuSlots, price: state.price,
        coins: state.coins, reputation: state.reputation
      }));
      return true;
    } catch (e) { return false; }
  }
  function reset() {
    state.open = false; state.stock = {}; state.menu = []; state.menuSlots = 3;
    state.price = {}; state.coins = 0; state.reputation = 0;
    state.daySold = 0; state.lastSettle = null; state.history = [];
    save();
  }

  /* ==== 开店 ==== */
  function unlock() {
    if (state.open) return { ok: false, reason: 'already-open' };
    state.open = true;
    save();
    return { ok: true };
  }
  function isOpen() { return state.open; }

  /* ==== 食材 ==== */
  /** 潜水带回的东西入库。diveLoot 可以是 { items: [{key, name}] } 或 { key: n }。 */
  function addFromDive(diveLoot) {
    if (!state.open || !diveLoot) return { ok: false, added: {} };
    var added = {};
    var items = diveLoot.items || [];
    for (var i = 0; i < items.length; i++) {
      var key = items[i].key || items[i].name;
      var mapped = mapDiveKey(key);
      if (!mapped) continue;
      state.stock[mapped] = (state.stock[mapped] || 0) + 1;
      added[mapped] = (added[mapped] || 0) + 1;
    }
    save();
    return { ok: true, added: added };
  }
  /** 潜水模块的 key 和本模块的食材 id 不是一一对应，这里做一次映射。 */
  function mapDiveKey(k) {
    if (!k) return null;
    var s = String(k).toLowerCase();
    if (s.indexOf('seaweed') >= 0 || s.indexOf('kelp') >= 0) return s.indexOf('deep') >= 0 ? 'deepKelp' : 'seaweed';
    if (s.indexOf('clam') >= 0 || s.indexOf('shell') >= 0) return 'clam';
    if (s.indexOf('squid') >= 0) return 'squid';
    if (s.indexOf('silver') >= 0) return 'silverScale';
    if (s.indexOf('urchin') >= 0) return 'seaUrchin';
    if (s.indexOf('roe') >= 0) return 'fishRoe';
    if (s.indexOf('crab') >= 0) return 'deepCrab';
    if (s.indexOf('rice') >= 0) return 'rice';
    return null;
  }
  function stockOf(id) { return state.stock[id] || 0; }
  function stockList() {
    return Object.keys(INGREDIENTS).map(function (id) {
      return { id: id, name: INGREDIENTS[id].name, tier: INGREDIENTS[id].tier, count: stockOf(id) };
    }).filter(function (x) { return x.count > 0; });
  }
  /** 从市场买米（唯一非潜水来源的食材）。 */
  function buyRice(n, coinsPer) {
    n = Math.max(1, Math.floor(n || 1));
    var cost = n * (coinsPer || 3);
    if (state.coins < cost) return { ok: false, reason: 'no-coins', need: cost };
    state.coins -= cost;
    state.stock.rice = (state.stock.rice || 0) + n;
    save();
    return { ok: true, bought: n, cost: cost };
  }

  /* ==== 菜单 ==== */
  function canCook(recipeId) {
    var r = recipeById(recipeId);
    if (!r) return false;
    for (var k in r.need) if (stockOf(k) < r.need[k]) return false;
    return true;
  }
  function recipeById(id) {
    for (var i = 0; i < RECIPES.length; i++) if (RECIPES[i].id === id) return RECIPES[i];
    return null;
  }
  /** 上架 / 下架。返回 { ok, reason? }。 */
  function toggleMenu(recipeId) {
    var idx = state.menu.indexOf(recipeId);
    if (idx >= 0) { state.menu.splice(idx, 1); save(); return { ok: true, action: 'removed' }; }
    if (state.menu.length >= state.menuSlots) return { ok: false, reason: 'menu-full' };
    if (!recipeById(recipeId)) return { ok: false, reason: 'unknown-recipe' };
    state.menu.push(recipeId);
    save();
    return { ok: true, action: 'added' };
  }
  function setPrice(recipeId, price) {
    var r = recipeById(recipeId);
    if (!r) return { ok: false, reason: 'unknown-recipe' };
    var lo = r.priceRange[0], hi = r.priceRange[1];
    var p = Math.max(Math.floor(lo * 0.5), Math.min(Math.floor(hi * 1.5), Math.floor(price || r.priceRange[0])));
    state.price[recipeId] = p;
    save();
    return { ok: true, price: p, min: lo, max: hi };
  }
  function priceOf(recipeId) {
    var r = recipeById(recipeId);
    if (!r) return 0;
    return state.price[recipeId] !== undefined ? state.price[recipeId] : r.priceRange[0];
  }
  /** 预计毛利率（不含口碑加成）。 */
  function marginOf(recipeId) {
    var r = recipeById(recipeId);
    if (!r) return 0;
    var p = priceOf(recipeId);
    return r.basePrice > 0 ? Math.round((p - r.basePrice) / p * 100) : 0;
  }

  /* ==== 日营业 ==== */
  /**
   * 结算一天。返回当天的账单。
   * 客流受三条影响：菜单是否满、定价是否合理、口碑。
   */
  function settleDay() {
    if (!state.open) return { ok: false, reason: 'not-open' };
    var lines = [], gross = 0, cost = 0, served = 0, repGain = 0;
    for (var i = 0; i < state.menu.length; i++) {
      var r = recipeById(state.menu[i]);
      if (!r) continue;
      if (!canCook(r.id)) { lines.push({ id: r.id, name: r.name, sold: 0, reason: '食材不足' }); continue; }
      // 消耗食材
      for (var k in r.need) state.stock[k] -= r.need[k];
      // 定价越高卖得越少；口碑越高卖得越多
      var p = priceOf(r.id);
      var lo = r.priceRange[0], hi = r.priceRange[1];
      var priceFactor = p <= lo ? 1.25 : (p >= hi ? 0.55 : 1 - (p - lo) / (hi - lo) * 0.45);
      var repFactor = 1 + Math.min(0.8, state.reputation / 120);
      var sold = Math.max(1, Math.round(2 * priceFactor * repFactor));
      served += sold;
      gross += sold * p;
      cost += sold * r.basePrice;
      repGain += (r.rep || 0) * sold * 0.15;
      lines.push({ id: r.id, name: r.name, sold: sold, price: p });
    }
    var net = gross - cost;
    state.coins += net;
    state.reputation = Math.max(0, state.reputation + Math.round(repGain));
    state.daySold = served;
    var bill = {
      ok: true, day: state.history.length + 1, lines: lines,
      served: served, gross: gross, cost: cost, net: net,
      reputation: state.reputation, coins: state.coins
    };
    state.lastSettle = bill;
    state.history.push(bill);
    if (state.history.length > 10) state.history.shift();
    save();
    return bill;
  }

  /* ==== 汇总 ==== */
  function summary() {
    return {
      open: state.open, coins: state.coins, reputation: state.reputation,
      menu: state.menu.slice(), menuSlots: state.menuSlots,
      stock: stockList(), daySold: state.daySold,
      lastSettle: state.lastSettle ? clone(state.lastSettle) : null
    };
  }

  /* ==== 绘制 ==== */
  var FONT_STACK = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * 画寿司店面板。opts: { font, tab: 'menu'|'stock' }
   * 返回 { close, rows: [{x,y,w,h,id}], settle }
   */
  function drawPanel(ctx, w, h, opts) {
    opts = opts || {};
    var font = opts.font || 16;
    var tab = opts.tab || 'menu';
    var out = { close: null, rows: [], settle: null, tab: tab };

    var pw = Math.min(w * 0.9, 700), ph = Math.min(h * 0.8, 500);
    var px = (w - pw) / 2, py = (h - ph) / 2;

    ctx.fillStyle = 'rgba(6,12,22,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(24,28,40,0.97)';
    rr(ctx, px, py, pw, ph, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,200,140,0.4)'; ctx.lineWidth = 2;
    rr(ctx, px, py, pw, ph, 18); ctx.stroke();

    // Header
    ctx.fillStyle = '#ffd9a8';
    ctx.font = '800 ' + (font * 1.4) + 'px ' + FONT_STACK;
    ctx.fillText('海上寿司店', px + 24, py + font * 2.2);
    ctx.fillStyle = 'rgba(220,235,255,0.8)';
    ctx.font = '600 ' + (font * 0.8) + 'px ' + FONT_STACK;
    ctx.fillText('金币 ' + state.coins + '   ·   口碑 ' + state.reputation
      + '   ·   今日卖出 ' + state.daySold + ' 份', px + 24, py + font * 3.3);

    // Close
    var cb = font * 1.7, cbx = px + pw - cb - 14, cby = py + 14;
    out.close = { x: cbx, y: cby, w: cb, h: cb };
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    rr(ctx, cbx, cby, cb, cb, cb / 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 ' + (font * 1.0) + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.fillText('×', cbx + cb / 2, cby + cb * 0.72);
    ctx.textAlign = 'left';

    // Tabs
    var tabs = [{ id: 'menu', label: '菜单' }, { id: 'stock', label: '食材' }];
    var tabY = py + font * 4.2;
    for (var t = 0; t < tabs.length; t++) {
      var tw = font * 4.2, tx = px + 24 + t * (tw + 8);
      var active = tabs[t].id === tab;
      ctx.fillStyle = active ? 'rgba(200,120,60,0.85)' : 'rgba(255,255,255,0.08)';
      rr(ctx, tx, tabY, tw, font * 1.7, font * 0.85); ctx.fill();
      ctx.fillStyle = active ? '#fff5ea' : 'rgba(220,235,255,0.7)';
      ctx.font = '700 ' + (font * 0.8) + 'px ' + FONT_STACK;
      ctx.textAlign = 'center';
      ctx.fillText(tabs[t].label, tx + tw / 2, tabY + font * 1.2);
      ctx.textAlign = 'left';
    }

    // Rows
    var rowY = tabY + font * 2.6;
    var rowH = font * 2.4;
    var list = tab === 'menu' ? RECIPES : stockList();
    var maxRows = Math.floor((py + ph - rowY - font * 3.4) / rowH);
    for (var i = 0; i < list.length && i < maxRows; i++) {
      var item = list[i];
      var ry = rowY + i * rowH;
      var isOn = tab === 'menu' && state.menu.indexOf(item.id) >= 0;
      ctx.fillStyle = isOn ? 'rgba(200,140,70,0.22)' : 'rgba(255,255,255,0.05)';
      rr(ctx, px + 20, ry, pw - 40, rowH - 6, 10); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 ' + (font * 0.88) + 'px ' + FONT_STACK;
      if (tab === 'menu') {
        ctx.fillText(item.name, px + 34, ry + rowH * 0.46);
        ctx.fillStyle = 'rgba(210,230,255,0.7)';
        ctx.font = '600 ' + (font * 0.68) + 'px ' + FONT_STACK;
        var needTxt = Object.keys(item.need).map(function (k) {
          return (INGREDIENTS[k] ? INGREDIENTS[k].name : k) + '×' + item.need[k];
        }).join(' ');
        ctx.fillText(needTxt + '   定价 ' + priceOf(item.id) + '   毛利 ' + marginOf(item.id) + '%',
          px + 34, ry + rowH * 0.78);
        // cooked? mark on the right
        ctx.fillStyle = canCook(item.id) ? '#9ff0b8' : '#ffb4a0';
        ctx.font = '700 ' + (font * 0.76) + 'px ' + FONT_STACK;
        ctx.textAlign = 'right';
        ctx.fillText(isOn ? '已上架' : (canCook(item.id) ? '可做' : '缺食材'), px + pw - 34, ry + rowH * 0.62);
        ctx.textAlign = 'left';
      } else {
        ctx.fillText(item.name + ' ×' + item.count, px + 34, ry + rowH * 0.62);
        ctx.fillStyle = 'rgba(210,230,255,0.6)';
        ctx.font = '600 ' + (font * 0.68) + 'px ' + FONT_STACK;
        ctx.fillText('Tier ' + item.tier, px + pw - 80, ry + rowH * 0.62);
      }
      out.rows.push({ x: px + 20, y: ry, w: pw - 40, h: rowH - 6, id: item.id });
    }

    // Footer
    ctx.fillStyle = 'rgba(220,235,255,0.65)';
    ctx.font = '600 ' + (font * 0.72) + 'px ' + FONT_STACK;
    var foot = tab === 'menu'
      ? '点击菜品上架/下架（' + state.menu.length + '/' + state.menuSlots + '）   按 T 结算一天'
      : '食材来自潜水采集，米可在市场买';
    ctx.fillText(foot, px + 24, py + ph - font * 0.9);

    // Last settle bill
    if (state.lastSettle && tab === 'menu') {
      out.settle = { net: state.lastSettle.net, served: state.lastSettle.served };
    }
    return out;
  }

  /* ==== 自检 ==== */
  function selfTest() {
    var problems = [];
    // 菜谱数据完整
    for (var i = 0; i < RECIPES.length; i++) {
      var r = RECIPES[i];
      if (!r.id || !r.name) problems.push('recipe[' + i + '] 缺 id/name');
      if (!r.need || !Object.keys(r.need).length) problems.push(r.id + ' 没有食材');
      for (var k in r.need) if (!INGREDIENTS[k]) problems.push(r.id + ' 用了未知食材 ' + k);
      if (!r.priceRange || r.priceRange.length !== 2) problems.push(r.id + ' priceRange 不合法');
    }
    // 纯函数健壮性
    try {
      recipeById('nope'); priceOf('nope'); marginOf('nope');
      stockOf('nope'); canCook('nope'); toggleMenu('nope'); setPrice('nope', 1);
    } catch (e) { problems.push('纯函数抛异常: ' + e.message); }
    // 未开店的保护
    if (settleDay().ok !== false) problems.push('未开店时 settleDay 应返回 ok:false');
    return { passed: problems.length === 0, problems: problems, recipes: RECIPES.length, ingredients: Object.keys(INGREDIENTS).length };
  }

  return {
    VERSION: MODULE_VERSION,
    RECIPES: RECIPES.map(function (r) { return { id: r.id, name: r.name, tier: r.tier }; }),
    INGREDIENTS: clone(INGREDIENTS),
    load: load, save: save, reset: reset,
    unlock: unlock, isOpen: isOpen,
    addFromDive: addFromDive, stockOf: stockOf, stockList: stockList, buyRice: buyRice,
    recipeById: recipeById, canCook: canCook,
    toggleMenu: toggleMenu, setPrice: setPrice, priceOf: priceOf, marginOf: marginOf,
    settleDay: settleDay,
    summary: summary,
    drawPanel: drawPanel,
    selfTest: selfTest
  };
});
