/**
 * 漂流小镇 · NPC 对话与好感度
 * =============================================================================
 * 把 data/npcs.json 里已经写好的小传、招募条件、好感事件链，做成游戏里能跑的
 * 对话系统。和 achievements.js / leaderboard.js 一样是零依赖 IIFE，挂在
 * window.NpcDialogue 上，同时 module.exports（node 可 require）。
 *
 * 设计边界（务必看清，不要当已验证）：
 *   - 本模块只负责「状态与数据」：谁在船上、好感多少、哪些事件已触发、
 *     当前该说什么、玩家选了之后发生什么。
 *   - 绘制只在 draw* 函数里做，收 ctx 参数，绝不碰 DOM。
 *   - 数据中没有的字段一律降级处理，不抛异常。
 *   - data/npcs.json 的 events 是 schema（字段定义），不是事件实例数组；
 *     真正的事件实例在每个 npc 的 affinityEvents[] 里。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.NpcDialogue = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var MODULE_VERSION = '1.0.0';
  var SAVE_KEY = 'drift-town:npc-dialogue:v1';

  /* ==== 内联的 NPC 与事件数据（由 data/npcs.json 提取精华） ====
   * 只保留游戏消费的字段，避免把整张表（含大量说明文字）打进包体。 */

  var NPCS = [
    {
      id: 'laochen', name: '老陈', title: '捞了四十年的老手', specialty: 'salvage',
      perk: '打捞范围 +40%', color: '#8fb8d8',
      look: { skin: '#d9a97c', hair: '#c8c8c8', hat: '#5a6a78', cloth: '#5a6a78' },
      bio: '大潮前是渔船上的水手，大潮后是海上最会看垃圾往哪漂的人。话少，手快，说「这玩意儿有用」的时候基本都对。',
      legacy: '他原来的船叫「陈记二号」，沉在离这里两天航程的地方。他从不提船，只提船上那口锅。',
      events: [
        { id: 'laochen-1', type: 'help', title: '补网',
          desc: '他又弄破了一张网，说这次是故意的，想看看你学没学会。',
          choices: [
            { text: '帮他补', affinity: 10, message: '他没说话，但第二天甲板上多了一桶淡水。' },
            { text: '让他自己补', affinity: 2, message: '「也对，我还没老到不能动。」' }
          ] },
        { id: 'laochen-2', type: 'story', title: '陈记二号',
          desc: '喝了点酒之后，他第一次说起了自己的船。',
          choices: [
            { text: '问船沉在哪里', affinity: 15, message: '他画了一张潦草的图，标注了两天航程外的一片水域。' },
            { text: '什么都不问', affinity: 5, message: '他点点头，把酒壶收了回去。' }
          ] }
      ]
    },
    {
      id: 'ahai', name: '阿海', title: '第一个戴上面罩的人', specialty: 'dive',
      perk: '潜水氧气 +20 秒', color: '#7fd8e8',
      look: { skin: '#e8c39a', hair: '#2a3a4a', hat: null, cloth: '#3a6a7a' },
      bio: '在别的聚落做过潜水员，是唯一一个见过海面之下的人。说话时眼睛总往水下看，像在数还有多少没捞上来。',
      legacy: '他上一任搭档没上来。这件事他没跟任何人讲，但每次下水他都会多带一根绳子。',
      events: [
        { id: 'ahai-1', type: 'help', title: '多带的绳子',
          desc: '他把绳子递给你，说他每次下水都多带一根。',
          choices: [
            { text: '问他为什么', affinity: 12, message: '「万一有人需要。」他这么说的时候没看你。' },
            { text: '收下就好', affinity: 6, message: '他松了口气。' }
          ] },
        { id: 'ahai-2', type: 'story', title: '中层的光',
          desc: '他说中层水域有一片会发光的东西，他从来没敢靠近。',
          choices: [
            { text: '提议一起去', affinity: 18, message: '你们一起下去了。那是一片会随着水流呼吸的藻。' },
            { text: '记在地图上', affinity: 8, message: '他把位置画在海图边缘，很轻。' }
          ] }
      ]
    },
    {
      id: 'xiaoman', name: '小满', title: '把海的馈赠做成一餐的人', specialty: 'cook',
      perk: '寿司店图纸 · 食物 +50%', color: '#e8b87f',
      look: { skin: '#f0d0aa', hair: '#4a3020', hat: '#e8e0d0', cloth: '#c88a5a' },
      bio: '大潮前在陆地上的一家小店里切鱼，大潮后一直在找一个能重新开火的地方。她是解锁寿司店的关键。',
      legacy: '她的刀是父亲留下的，刀柄缠过三次布。她说刀还在，店就还没关。',
      events: [
        { id: 'xiaoman-1', type: 'help', title: '磨刀',
          desc: '她的刀钝了，磨刀石却丢在了水里。',
          choices: [
            { text: '潜下去找', affinity: 15, message: '你捞上来一块石头。她接过去，掂了掂，说「这个比原来的好」。' },
            { text: '找块新的给她', affinity: 8, message: '她收下了，但看得出不是她想要的那种。' }
          ] },
        { id: 'xiaoman-2', type: 'conflict', title: '第一道菜',
          desc: '她要你决定寿司店的第一道菜是什么。选错了她会照做，但不会高兴。',
          choices: [
            { text: '海藻卷（稳）', affinity: 10, message: '「稳妥。」她开始洗海藻，动作很快。' },
            { text: '深海蟹肉军舰（赌）', affinity: 20, message: '她愣了两秒，然后笑了：「有胆。」' }
          ] }
      ]
    },
    {
      id: 'bo', name: '铁匠波', title: '只会往硬里做的匠人', specialty: 'build',
      perk: '建造材料 -20%', color: '#b8a090',
      look: { skin: '#c89878', hair: null, hat: '#6a4a3a', cloth: '#7a5a48' },
      bio: '手上有旧伤，握锤的姿势不对但打得比谁都稳。大潮时失去了一条腿（他给自己做了条木腿）。说话直接，讨厌废话。',
      legacy: '他的工坊本来在沉城的第三层，现在那里是 Tier 3 海域。他说过想再回去看一眼。',
      events: [
        { id: 'bo-1', type: 'trade', title: '木腿',
          desc: '他的木腿裂了，想换一条。「但我不会求人。」',
          choices: [
            { text: '给他材料', affinity: 12, message: '他收了，第二天给你打了一副更结实的工具。' },
            { text: '帮他一起做', affinity: 20, message: '你们花了一整晚。他最后说：「这条腿比上一条好。」' }
          ] },
        { id: 'bo-2', type: 'story', title: '第三层',
          desc: '他提起沉城里的工坊，声音低了下去。',
          choices: [
            { text: '承诺带他回去', affinity: 15, message: '「不用。你下去的时候帮我看看，那炉火是不是还亮着。」' },
            { text: '转移话题', affinity: 3, message: '他点点头，继续敲他的铁。' }
          ] }
      ]
    },
    {
      id: 'lili', name: '莉莉', title: '会在定价上跟你较劲的人', specialty: 'run',
      perk: '售价 +10%', color: '#d8a0c8',
      look: { skin: '#f5dcc0', hair: '#7a3a5a', hat: null, cloth: '#a86a9a' },
      bio: '大潮前在岸上做买卖，算账比谁都快。来了就重新规划摊位位置，说「东西好吃不重要，要让人以为它好」。',
      legacy: '她有一本记满了价格的旧账本，最后一页没写完。她说那天她正在算最后一笔。',
      events: [
        { id: 'lili-1', type: 'trade', title: '旧账本',
          desc: '她让你帮她把账本上最后一页算完。',
          choices: [
            { text: '认真算', affinity: 15, message: '数字对不上的地方，她一直知道，只是需要有人一起看遍。' },
            { text: '随手填个数字', affinity: -3, message: '她合上账本，什么都没说。' }
          ] },
        { id: 'lili-2', type: 'conflict', title: '涨价',
          desc: '她想把海藻卷涨到两倍价。小满不同意。',
          choices: [
            { text: '支持莉莉', affinity: 12, message: '客流掉了两天，然后回来了。她赢了一局。' },
            { text: '支持小满', affinity: 5, message: '「行吧，你们管味道。」她把账本翻到新的一页。' }
          ] }
      ]
    }
  ];

  /* ==== 状态 ==== */

  var state = {
    recruited: {},     // id -> true
    affinity: {},      // id -> number
    fired: {},         // eventId -> true（已触发过的事件）
    pending: null,     // { npcId, eventId } 当前待玩家选择的事件
    log: []            // 最近的对白（供 UI 显示）
  };

  function clampAffinity(v) { return Math.max(-20, Math.min(100, Math.round(v || 0))); }
  function npcById(id) {
    for (var i = 0; i < NPCS.length; i++) if (NPCS[i].id === id) return NPCS[i];
    return null;
  }
  function affinityOf(id) { return clampAffinity(state.affinity[id]); }

  /** 好感度分档：决定了 NPC 对你说话的口气，也决定 2 号事件能否触发。 */
  function tierOf(aff) {
    if (aff >= 30) return { id: 'close', name: '知己' };
    if (aff >= 15) return { id: 'friend', name: '朋友' };
    if (aff >= 5) return { id: 'warm', name: '熟络' };
    if (aff >= 0) return { id: 'new', name: '陌生' };
    return { id: 'cold', name: '戒备' };
  }

  function note(text) {
    state.log.push({ text: text, at: Date.now() });
    if (state.log.length > 40) state.log.shift();
  }

  /* ==== 存档 ==== */

  function load() {
    try {
      var storage = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (!storage) return false;
      var raw = storage.getItem(SAVE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      state.recruited = data.recruited || {};
      state.affinity = data.affinity || {};
      state.fired = data.fired || {};
      return true;
    } catch (e) { return false; }
  }
  function save() {
    try {
      var storage = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (!storage) return false;
      storage.setItem(SAVE_KEY, JSON.stringify({
        recruited: state.recruited, affinity: state.affinity, fired: state.fired
      }));
      return true;
    } catch (e) { return false; }
  }
  function reset() {
    state.recruited = {}; state.affinity = {}; state.fired = {};
    state.pending = null; state.log = [];
    save();
  }

  /* ==== 招募 ==== */

  /** 招募一个人上船。返回 { ok, npc?, reason? }。 */
  function recruit(npcId) {
    var npc = npcById(npcId);
    if (!npc) return { ok: false, reason: 'unknown-npc' };
    if (state.recruited[npcId]) return { ok: false, reason: 'already-aboard', npc: npc };
    state.recruited[npcId] = true;
    if (state.affinity[npcId] === undefined) state.affinity[npcId] = 0;
    note(npc.name + ' 上船了。');
    save();
    return { ok: true, npc: npc };
  }

  function recruitedList() {
    var out = [];
    for (var i = 0; i < NPCS.length; i++) if (state.recruited[NPCS[i].id]) out.push(NPCS[i]);
    return out;
  }
  function isAboard(id) { return !!state.recruited[id]; }

  /* ==== 事件 ==== */

  /** 当前有没有可选的事件？返回 { npc, event } 或 null。 */
  function availableEvent() {
    // 优先返回已经 pending 的
    if (state.pending) {
      var n0 = npcById(state.pending.npcId);
      var ev0 = n0 ? findEvent(n0, state.pending.eventId) : null;
      if (n0 && ev0) return { npc: n0, event: ev0 };
      state.pending = null;
    }
    // 遍历所有在船上的人，找第一个可触发的事件
    for (var i = 0; i < NPCS.length; i++) {
      var npc = NPCS[i];
      if (!state.recruited[npc.id]) continue;
      var ev = nextEventFor(npc);
      if (ev) { state.pending = { npcId: npc.id, eventId: ev.id }; return { npc: npc, event: ev }; }
    }
    return null;
  }
  function findEvent(npc, eventId) {
    for (var i = 0; i < npc.events.length; i++) if (npc.events[i].id === eventId) return npc.events[i];
    return null;
  }
  /** 第 0 个事件在好感 0 就能触发；第 1 个要求好感 >= 5（先聊过一次）。 */
  function nextEventFor(npc) {
    for (var i = 0; i < npc.events.length; i++) {
      var ev = npc.events[i];
      if (state.fired[ev.id]) continue;
      var need = i === 0 ? 0 : 5;
      if (affinityOf(npc.id) < need) continue;
      return ev;
    }
    return null;
  }
  function firedCount() {
    var n = 0;
    for (var k in state.fired) if (state.fired[k]) n++;
    return n;
  }

  /** 玩家选了一个选项。返回 { ok, affinityDelta, total, message, at }。 */
  function choose(choiceIndex) {
    if (!state.pending) return { ok: false, reason: 'no-pending' };
    var npc = npcById(state.pending.npcId);
    var ev = npc ? findEvent(npc, state.pending.eventId) : null;
    if (!npc || !ev) { state.pending = null; return { ok: false, reason: 'event-gone' }; }
    var choice = ev.choices[Math.max(0, Math.min(ev.choices.length - 1, choiceIndex | 0))];
    var before = affinityOf(npc.id);
    state.affinity[npc.id] = clampAffinity(before + (choice.affinity || 0));
    state.fired[ev.id] = true;
    state.pending = null;
    note(ev.title + '：' + (choice.message || ''));
    save();
    return {
      ok: true, npc: npc, event: ev, choice: choice,
      affinityDelta: state.affinity[npc.id] - before,
      total: state.affinity[npc.id],
      message: choice.message || ''
    };
  }

  /* ==== 汇总（给 achievements 之类消费） ==== */

  function summary() {
    return {
      recruited: recruitedList().map(function (n) { return n.id; }),
      affinity: Object.keys(state.affinity).map(function (k) {
        return { id: k, value: affinityOf(k), tier: tierOf(affinityOf(k)).name };
      }),
      eventsFired: firedCount(),
      totalAffinity: Object.keys(state.affinity).reduce(function (s, k) { return s + affinityOf(k); }, 0)
    };
  }

  /* ==== 绘制（Canvas 2D，无 DOM） ==== */

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
   * 程序化立绘：用 Canvas 拼装一张卡通头像（脸/发/帽/眼/眉/嘴/腮红/衣领）。
   * npc.look = { skin, hair, hat, cloth }；缺省给安全值。cx,cy 圆心，r 半径。
   */
  function drawPortrait(ctx, npc, cx, cy, r) {
    var look = npc.look || {};
    var skin = look.skin || '#e8c39a', hair = look.hair,
        hat = look.hat, cloth = look.cloth || npc.color || '#6a7a8a';
    // 底圆（衣领色）+ 内脸（肤色，略小、偏上，露出下巴外圈当衣领）
    ctx.fillStyle = cloth;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.98, 0, Math.PI * 2); ctx.clip();
    // 肩（底部两个圆角块）
    ctx.fillStyle = cloth;
    ctx.beginPath(); ctx.arc(cx - r * 0.42, cy + r * 1.05, r * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.42, cy + r * 1.05, r * 0.42, 0, Math.PI * 2); ctx.fill();
    // 脖子
    ctx.fillStyle = skin;
    ctx.fillRect(cx - r * 0.16, cy + r * 0.42, r * 0.32, r * 0.3);
    // 脸
    ctx.beginPath(); ctx.arc(cx, cy - r * 0.06, r * 0.68, 0, Math.PI * 2); ctx.fill();
    // 腮红
    ctx.fillStyle = 'rgba(230,130,110,0.35)';
    ctx.beginPath(); ctx.arc(cx - r * 0.4, cy + r * 0.14, r * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.4, cy + r * 0.14, r * 0.11, 0, Math.PI * 2); ctx.fill();
    // 发：头顶大圆弧 + 两侧垂发
    if (hair) {
      ctx.fillStyle = hair;
      ctx.beginPath(); ctx.arc(cx, cy - r * 0.24, r * 0.66, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
      ctx.beginPath(); ctx.arc(cx - r * 0.56, cy - r * 0.02, r * 0.18, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + r * 0.56, cy - r * 0.02, r * 0.18, 0, Math.PI * 2); ctx.fill();
    }
    // 帽：檐 + 顶（盖在发上）
    if (hat) {
      ctx.fillStyle = hat;
      ctx.fillRect(cx - r * 0.62, cy - r * 0.52, r * 1.24, r * 0.14);
      ctx.beginPath(); ctx.arc(cx, cy - r * 0.5, r * 0.46, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - r * 0.46, cy - r * 0.85, r * 0.92, r * 0.4);
    }
    // 眼（白底+黑瞳）+ 眉
    var ey = cy - r * 0.08;
    [-1, 1].forEach(function (s) {
      var ex = cx + s * r * 0.27;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(ex, ey, r * 0.11, r * 0.13, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a2430';
      ctx.beginPath(); ctx.arc(ex, ey + r * 0.02, r * 0.055, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hair || '#3a4a5a';
      ctx.fillRect(ex - r * 0.11, ey - r * 0.22, r * 0.22, r * 0.05);
    });
    // 嘴（微笑弧）
    ctx.strokeStyle = 'rgba(90,40,30,0.85)'; ctx.lineWidth = Math.max(1.5, r * 0.05);
    ctx.beginPath(); ctx.arc(cx, cy + r * 0.16, r * 0.18, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
    ctx.restore();
    // 外圈
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }

  /**
   * 画对话面板。opts: { font, scroll }
   * 返回 { close: {x,y,w,h}, choices: [{x,y,w,h,index}], maxScroll }
   */
  function drawDialogue(ctx, w, h, opts) {
    opts = opts || {};
    var font = opts.font || 16;
    var cur = availableEvent();
    var out = { close: null, choices: [], maxScroll: 0 };
    if (!cur) return out;

    var pw = Math.min(w * 0.86, 620);
    var ph = Math.min(h * 0.72, 440);
    var px = (w - pw) / 2, py = (h - ph) / 2;

    // Dim the scene.
    ctx.fillStyle = 'rgba(6,12,22,0.62)';
    ctx.fillRect(0, 0, w, h);

    // Panel.
    ctx.fillStyle = 'rgba(20,30,48,0.97)';
    rr(ctx, px, py, pw, ph, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(150,220,255,0.4)'; ctx.lineWidth = 2;
    rr(ctx, px, py, pw, ph, 18); ctx.stroke();

    // 程序化立绘（threejs-image-generator 降级模式：无 GEMINI_API_KEY，
    // 用 Canvas 拼装头像：底圆+发/帽+眼+眉+嘴+腮红+衣领），比色盘首字精致。
    var pr = font * 1.9;
    var pcx = px + pr + 22, pcy = py + pr + 20;
    drawPortrait(ctx, cur.npc, pcx, pcy, pr);

    // Name + title + affinity.
    var tx = pcx + pr + 16;
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 ' + (font * 1.25) + 'px ' + FONT_STACK;
    ctx.fillText(cur.npc.name, tx, py + font * 2.1);
    ctx.fillStyle = 'rgba(200,225,250,0.75)';
    ctx.font = '600 ' + (font * 0.78) + 'px ' + FONT_STACK;
    ctx.fillText(cur.npc.title, tx, py + font * 3.25);

    var aff = affinityOf(cur.npc.id);
    var tier = tierOf(aff);
    ctx.fillStyle = tier.id === 'cold' ? '#ffb4a0' : (tier.id === 'close' ? '#9ff0b8' : '#cfe6ff');
    ctx.font = '700 ' + (font * 0.76) + 'px ' + FONT_STACK;
    ctx.fillText(tier.name + ' · 好感 ' + aff, tx, py + font * 4.2);

    // Close button.
    var cb = font * 1.7;
    var cbx = px + pw - cb - 14, cby = py + 14;
    out.close = { x: cbx, y: cby, w: cb, h: cb };
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    rr(ctx, cbx, cby, cb, cb, cb / 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '700 ' + (font * 0.95) + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.fillText('×', cbx + cb / 2, cby + cb * 0.72);
    ctx.textAlign = 'left';

    // Event title + body.
    var by = py + font * 5.6;
    ctx.fillStyle = '#ffe2a8';
    ctx.font = '800 ' + (font * 1.0) + 'px ' + FONT_STACK;
    ctx.fillText(cur.event.title, px + 22, by);

    ctx.fillStyle = 'rgba(235,245,255,0.92)';
    ctx.font = '400 ' + (font * 0.86) + 'px ' + FONT_STACK;
    var bodyLines = wrap(ctx, cur.event.desc, pw - 44);
    for (var i = 0; i < bodyLines.length && i < 6; i++) {
      ctx.fillText(bodyLines[i], px + 22, by + font * 1.6 + i * font * 1.35);
    }

    // Choices.
    var cy = py + ph - font * (cur.event.choices.length * 2.6) - 16;
    for (var c = 0; c < cur.event.choices.length; c++) {
      var ch = cur.event.choices[c];
      var cw = pw - 44, chh = font * 1.9;
      var cx = px + 22, cyy = cy + c * (chh + 8);
      ctx.fillStyle = 'rgba(60,100,140,0.55)';
      rr(ctx, cx, cyy, cw, chh, chh / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(160,220,255,0.45)'; ctx.lineWidth = 1.5;
      rr(ctx, cx, cyy, cw, chh, chh / 2); ctx.stroke();
      ctx.fillStyle = '#eaf6ff';
      ctx.font = '700 ' + (font * 0.84) + 'px ' + FONT_STACK;
      ctx.fillText(ch.text, cx + 16, cyy + chh * 0.66);
      out.choices.push({ x: cx, y: cyy, w: cw, h: chh, index: c });
    }
    return out;
  }

  /** 画「有话说」的小气泡提示。 */
  function drawHint(ctx, w, h, opts) {
    opts = opts || {};
    var font = opts.font || 16;
    var cur = availableEvent();
    if (!cur) return null;
    var label = cur.npc.name + ' 有话要说';
    ctx.font = '700 ' + (font * 0.82) + 'px ' + FONT_STACK;
    var tw = ctx.measureText(label).width;
    var bw = tw + 34, bh = font * 1.9;
    var bx = (w - bw) / 2, by = h - bh - font * 4.2;
    ctx.fillStyle = 'rgba(30,90,120,0.92)';
    rr(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
    ctx.strokeStyle = 'rgba(160,235,255,0.75)'; ctx.lineWidth = 2;
    rr(ctx, bx, by, bw, bh, bh / 2); ctx.stroke();
    ctx.fillStyle = '#dff6ff';
    ctx.fillText(label, bx + 17, by + bh * 0.64);
    return { x: bx, y: by, w: bw, h: bh };
  }

  /* ==== R3：船员踱步闲聊气泡 ====
   * 好感度事件是「大段对话」，闲聊是「头顶一句台词」：船员在甲板上踱步时
   * 随时间冒出一句符合岗位与好感档次的短话，几秒后飘走。纯状态+绘制，
   * 由 game.js 决定哪名船员的气泡画在哪个屏幕坐标。 */

  /* 闲聊台词池：按船员 id 分池，最后一条是兜底（好感戒备时也说得出口）。 */
  var CHATTER = {
    laochen: ['这堆木料成色不错。', '海流向西北，跟着漂。', '别浪费时间，东西不会自己上船。', '潮水要变了。'],
    ahai: ['水下十米还有光。', '绳子，检查过了。', '今天中层的水色发绿。', '下去之前多看一眼天。'],
    xiaoman: ['今天的鱼很新鲜。', '米还够做两锅。', '刀要磨了。', '闻到海藻的味道了吗？'],
    bo: ['炉火不能熄。', '锤子又松了。', '甲板的钉子该换一批。', '手上的活，别催。'],
    lili: ['定价再涨一成试试？', '账本又快写满了。', '摊位还得往人多的地方挪。', '今天的流水不错。']
  };
  var CHATTER_FALLBACK = ['海上的日子，就这样。', '今天风平浪静。'];
  var CHATTER_CD = 26000;      // 同一名船员两次闲聊的间隔（毫秒）
  var CHATTER_SHOW = 4200;     // 一句台词停留多久（毫秒）

  var chatterState = {};       // id -> { text, until, nextOk }
  /** 取某名船员此刻的闲聊台词；没有就返回 null。
   *  hour（可选）：0-23 的游戏内时刻，夜里说「困」类的短句。
   *  tier：好感档 id（cold/new/warm/friend/close），戒备时语气最短。 */
  function chatterFor(id, tier, now, hour) {
    now = now || Date.now();
    var st = chatterState[id];
    if (st && now < st.until) return { text: st.text, remain: (st.until - now) / 1000 };
    if (st && now < st.nextOk) return null;
    var pool = CHATTER[id];
    if (!pool || !pool.length) return null;
    // 好感戒备：只说最短的一句（第一句通常是「干活话」，合适）
    if (tier === 'cold') pool = [pool[0]];
    // 夜里（22 点-5 点）加一句困意
    if (typeof hour === 'number' && (hour >= 22 || hour < 5)) pool = pool.concat(['困了，想去睡。']);
    var line = pool[Math.floor(Math.random() * pool.length)];
    chatterState[id] = {
      text: line,
      until: now + CHATTER_SHOW,
      nextOk: now + CHATTER_CD + Math.random() * 14000
    };
    return { text: line, remain: CHATTER_SHOW / 1000 };
  }
  /** 立刻清掉一名船员的气泡（进入对话面板 / 换船时调用）。 */
  function clearChatter(id) { if (id) delete chatterState[id]; else chatterState = {}; }
  function chatterList() {
    var out = [], now = Date.now();
    for (var k in chatterState) if (chatterState[k] && now < chatterState[k].until) {
      out.push({ id: k, text: chatterState[k].text, remain: (chatterState[k].until - now) / 1000 });
    }
    return out;
  }
  /** 在世界点投影出的屏幕坐标上画一个小气泡。返回热区（可点则开对话）。 */
  function drawChatter(ctx, x, y, text, opts) {
    opts = opts || {};
    var font = opts.font || 14;
    if (!text) return null;
    ctx.font = '600 ' + (font * 0.78) + 'px ' + FONT_STACK;
    var tw = ctx.measureText(text).width;
    var bw = Math.min(tw + 20, 260), bh = font * 1.6;
    // 气泡中心取在头顶上方；屏幕太靠上时挪到头像下方，别被裁掉
    var bx = x - bw / 2, by = y - bh - (opts.offset || 6);
    if (by < 4) by = y + (opts.offset || 6);
    if (bx < 4) bx = 4;
    if (bx + bw > (opts.maxW || 4000) - 4) bx = (opts.maxW || 4000) - 4 - bw;
    ctx.fillStyle = 'rgba(246,246,238,0.94)';
    rr(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
    ctx.strokeStyle = 'rgba(90,110,130,0.75)'; ctx.lineWidth = 1.5;
    rr(ctx, bx, by, bw, bh, bh / 2); ctx.stroke();
    // 小尾巴
    ctx.fillStyle = 'rgba(246,246,238,0.94)';
    ctx.beginPath();
    ctx.moveTo(x - 5, by + bh - 1);
    ctx.lineTo(x + 5, by + bh - 1);
    ctx.lineTo(x, by + bh + 6);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2a3440';
    ctx.textAlign = 'center';
    ctx.fillText(text, bx + bw / 2, by + bh * 0.66);
    ctx.textAlign = 'left';
    return { x: bx, y: by, w: bw, h: bh + 6 };
  }

  function wrap(ctx, text, maxW) {
    var lines = [], line = '', chars = String(text || '').split('');
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = chars[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  /* ==== 自检 ==== */

  function selfTest() {
    var problems = [];
    // 数据结构完整
    for (var i = 0; i < NPCS.length; i++) {
      var n = NPCS[i];
      if (!n.id || !n.name) problems.push('npc[' + i + '] 缺 id/name');
      if (!n.events || !n.events.length) problems.push(n.id + ' 没有事件');
      for (var e = 0; e < (n.events || []).length; e++) {
        var ev = n.events[e];
        if (!ev.id || !ev.title || !ev.desc) problems.push(n.id + '.events[' + e + '] 字段不全');
        if (!ev.choices || !ev.choices.length) problems.push(n.id + '.events[' + e + '] 没有选项');
      }
    }
    // 纯函数健壮性
    try {
      affinityOf('nonexistent'); tierOf(-99); tierOf(999);
      npcById('nobody');
    } catch (err) { problems.push('纯函数抛异常: ' + err.message); }
    // 非法选择
    var r = choose(0);
    if (r.ok !== false) problems.push('无 pending 时 choose 应返回 ok:false');
    // R3：闲聊气泡
    try {
      var c1 = chatterFor('laochen', 'new', 1000, 12);
      if (!c1 || !c1.text) problems.push('chatterFor 应返回一句台词');
      var again = chatterFor('laochen', 'new', 2000, 12);
      if (!again || again.text !== c1.text) problems.push('冷却期内应返回同一条台词');
      var during = chatterFor('laochen', 'new', 1500, 12);
      if (!during || during.text !== c1.text) problems.push('显示期内应返回同一句台词');
      var cooled = chatterFor('laochen', 'new', 6000, 12);   // 已过显示期(5200)、仍在冷却
      if (cooled !== null) problems.push('冷却期内不该新开一句');
      clearChatter('laochen');
      if (chatterList().some(function (x) { return x.id === 'laochen'; })) problems.push('clearChatter 后不应还有该船员气泡');
      if (chatterFor('nobody', 'new', 1000, 12) !== null) problems.push('未知船员应返回 null');
    } catch (err) { problems.push('闲聊抛异常: ' + err.message); }
    return { passed: problems.length === 0, problems: problems, npcCount: NPCS.length, version: MODULE_VERSION };
  }

  return {
    VERSION: MODULE_VERSION,
    NAMES: NPCS.map(function (n) { return n.name; }),
    load: load, save: save, reset: reset,
    recruit: recruit, isAboard: isAboard, recruitedList: recruitedList,
    affinityOf: affinityOf, tierOf: tierOf,
    availableEvent: availableEvent, choose: choose,
    summary: summary,
    drawDialogue: drawDialogue, drawHint: drawHint, drawPortrait: drawPortrait,
    chatterFor: chatterFor, clearChatter: clearChatter, chatterList: chatterList, drawChatter: drawChatter,
    selfTest: selfTest
  };
});
