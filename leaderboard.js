/* 漂流小镇 · 排行榜 leaderboard.js
 * ===========================================================================
 * 一个文件、零依赖、零 DOM：浏览器与微信小游戏通用。
 *
 * ## 先说清楚能力边界（这一段是整个模块最重要的部分）
 *
 * 本项目是**纯前端单文件游戏，没有后端服务器**。所以：
 *
 * | 榜单                 | 状态       | 真实程度 |
 * |----------------------|-----------|---------|
 * | 本地排行（我的成绩）  | 真能用     | 本机 localStorage 存档，跨局、跨天都在，能排序、能算名次 |
 * | 微信好友排行          | 真能用*    | `wx.getFriendCloudStorage` + 开放数据域，**运营方必须在微信后台配置开放数据域并发布，否则跑不起来** |
 * | 全服排行（所有玩家）   | **做不到** | 没有后端就没有「所有玩家」这个集合。本模块**不提供**假的实现 |
 *
 * 关于「全服排行」的处理：
 *   本模块提供一个 `createServerAdapter()` 的**空壳适配器**，它的每一个方法
 *   都返回 `{ ok:false, unavailable:true, reason:'no-backend' }`，并带一句人话
 *   说明「需要后端才能跑」。它不会返回任何伪造的排名数据。
 *   这样 UI 可以正确地显示「全服排行 · 需后端接入」，而不是显示一个骗人的榜单。
 *
 * 将来接后端时要改的地方（只有这三处）：
 *   1. `SERVER_BASE` 常量 → 你的服务器地址
 *   2. `submitToServer()` → 换成真实 POST
 *   3. `fetchTopFromServer()` → 换成真实 GET
 *   其余逻辑（排序、平分规则、本地兜底、绘制）都不用动。
 *
 * ## 硬约束
 *   - 不加载 Node 模块、不读写文件、不请求网络、不操作 DOM
 *   - 不使用彩色 emoji（微信 Canvas 会渲染成方块）
 *   - 微信 API 全部特性检测：`typeof wx !== 'undefined' && typeof wx.xxx === 'function'`
 *
 * ## 用法（游戏侧）
 *   Leaderboard.submit({ playerId:'p1', nickname:'我', buildProgress:4, achievementProgress:60, score:120 });
 *   var local = Leaderboard.fetchTop(10);       // 同步，立刻有值
 *   var friends = await Leaderboard.fetchFriends();  // 异步；微信环境才有真实数据
 *   var server = await Leaderboard.fetchServerTop(10); // 恒为 unavailable（无后端）
 *   Leaderboard.draw(ctx, w, h, { tab:'local', font:16 });   // Canvas 2D 界面
 * ===========================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.Leaderboard = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var MODULE_VERSION = '1.0.0';
  var STORE_KEY = 'dsh-game-studio:drift-town:leaderboard:v1';
  var MAX_LOCAL_RECORDS = 100;      // 本地最多留 100 条，够看个人历史曲线
  var MAX_TOP = 50;                 // fetchTop 单次上限

  /* 将来接后端：把这里换成你的服务地址即可。空字符串 = 未配置。 */
  var SERVER_BASE = '';

  /* === 1. 工具 ========================================================= */

  function isObj(v) { return !!v && typeof v === 'object'; }

  function num(v, fallback) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && isFinite(Number(v))) return Number(v);
    return typeof fallback === 'number' ? fallback : 0;
  }

  function clamp(v, lo, hi) {
    var n = num(v, lo);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function copyObj(o) {
    var out = {}, k;
    if (!isObj(o)) return out;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  /* === 2. 存储层（localStorage / wx 存储 / 内存兜底） =================== */

  function storage() {
    if (typeof wx !== 'undefined' && wx
        && typeof wx.setStorageSync === 'function' && typeof wx.getStorageSync === 'function') {
      return {
        get: function (k) { try { return wx.getStorageSync(k); } catch (e) { return null; } },
        set: function (k, v) { try { wx.setStorageSync(k, v); return true; } catch (e) { return false; } },
        backend: 'wx'
      };
    }
    try {
      var ls = typeof localStorage !== 'undefined' ? localStorage : null;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
        return {
          get: function (k) { try { return ls.getItem(k); } catch (e) { return null; } },
          set: function (k, v) { try { ls.setItem(k, v); return true; } catch (e) { return false; } },
          backend: 'localStorage'
        };
      }
    } catch (e) { /* 沙箱 / 无痕会抛，落到内存兜底 */ }
    var mem = {};
    return {
      get: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      set: function (k, v) { mem[k] = v; return true; },
      backend: 'memory',
      memoryOnly: true
    };
  }

  /* === 3. 记录规范化与排序 =============================================
   * 一条记录：
   * {
   *   playerId   string   稳定 id（本地记录用随机串，接后端后换账号 id）
   *   nickname   string   显示名
   *   avatarUrl  string   头像（微信好友排行会给，本地记录为空）
   *   score      number   综合分（排序主键）
   *   buildProgress  number 0-100 城镇建设进度
   *   achievementProgress number 0-100 成就进度
   *   achievementCount number 已解锁成就数
   *   townCount  number   城镇建筑数
   *   salvaged   number   累计打捞件数
   *   at         number   提交时间（unix ms）
   *   source     'local' | 'friend' | 'server'
   * }
   *
   * 排序规则（必须在任何地方都一致，测试会验证）：
   *   1. buildProgress 降序   ← 用户明确要求「排行榜显示建造进度」
   *   2. achievementProgress 降序
   *   3. score 降序
   *   4. at 升序（先达成的排前面）—— 这条保证平分时名次是确定的，不是随机的
   *   5. playerId 升序（字符串比较）—— 最后一道确定性的保险
   * 名次：同分（前 4 项全等）并列同名次，下一名跳号（1,1,3 而不是 1,1,2）。
   */

  function normalizeRecord(raw, source) {
    var r = isObj(raw) ? raw : {};
    var pid = typeof r.playerId === 'string' && r.playerId ? r.playerId : '';
    var nick = typeof r.nickname === 'string' && r.nickname ? r.nickname : (pid || '无名');
    return {
      playerId: pid,
      nickname: nick,
      avatarUrl: typeof r.avatarUrl === 'string' ? r.avatarUrl : '',
      score: clamp(num(r.score, 0), 0, 1e9),
      buildProgress: clamp(num(r.buildProgress, 0), 0, 100),
      achievementProgress: clamp(num(r.achievementProgress, 0), 0, 100),
      achievementCount: clamp(num(r.achievementCount, 0), 0, 9999),
      townCount: clamp(num(r.townCount, 0), 0, 999),
      salvaged: clamp(num(r.salvaged, 0), 0, 1e7),
      at: Math.max(0, Math.floor(num(r.at, Date.now()))),
      source: typeof r.source === 'string' ? r.source
              : (typeof source === 'string' ? source : 'local')
    };
  }

  /** 比较函数：负 = a 排前面。 */
  function compareRecords(a, b) {
    if (b.buildProgress !== a.buildProgress) return b.buildProgress - a.buildProgress;
    if (b.achievementProgress !== a.achievementProgress) return b.achievementProgress - a.achievementProgress;
    if (b.score !== a.score) return b.score - a.score;
    if (a.at !== b.at) return a.at - b.at;
    if (a.playerId < b.playerId) return -1;
    if (a.playerId > b.playerId) return 1;
    return 0;
  }

  /** 并列判定：只看玩家「看得见的三个数」。
   *  建造进度 / 成就进度 / 分数三者全等 → 同名次。
   *  at 与 playerId 只用来给并列者排先后（保证顺序确定），不参与并列判定
   *  —— 否则两个屏幕上一模一样的成绩会显示成第 1 名和第 2 名，读起来像 bug。 */
  function isTie(a, b) {
    return a.buildProgress === b.buildProgress
        && a.achievementProgress === b.achievementProgress
        && a.score === b.score;
  }

  /** 排序 + 打名次。返回新数组，不改入参。每条记录多一个 rank 字段。 */
  function rank(list) {
    return rankBy(list, 'build');
  }

  /**
   * 按指定口径排序并打名次。
   * @param list    记录数组（畸形项会被 normalizeRecord 规整，不会抛）
   * @param sortBy  'build'（默认，建造进度）| 'achievement' | 'score'
   *
   * 排序规则：
   *   主键 = sortBy 指定的那个指标；
   *   其余两个可见指标按 build > achievement > score 依次比较；
   *   最后 at 升序、playerId 升序，保证「同样输入永远同样输出」。
   * 名次：三个可见指标全等 → 并列同名次，下一名跳号（1,1,3 而不是 1,1,2）。
   */
  function rankBy(list, sortBy) {
    var input = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    var key = normalizeSortBy(sortBy);
    var arr = [];
    for (var i = 0; i < input.length; i++) arr.push(normalizeRecord(input[i]));

    /* 把 sortBy 指定的指标提到第一优先级，其余两个保持默认次序。 */
    var order = {
      build: ['buildProgress', 'achievementProgress', 'score'],
      achievement: ['achievementProgress', 'buildProgress', 'score'],
      score: ['score', 'buildProgress', 'achievementProgress']
    }[key];

    arr.sort(function (a, b) {
      for (var o = 0; o < order.length; o++) {
        var f = order[o];
        if (b[f] !== a[f]) return b[f] - a[f];   // 降序
      }
      if (a.at !== b.at) return a.at - b.at;      // 先达成的排前面
      if (a.playerId < b.playerId) return -1;     // 最后一道确定性保险
      if (a.playerId > b.playerId) return 1;
      return 0;
    });

    var out = [], prev = null, prevRank = 0;
    for (var j = 0; j < arr.length; j++) {
      var rec = arr[j];
      var rk;
      if (prev && isTie(prev, rec)) rk = prevRank;   // 并列
      else { rk = j + 1; prevRank = rk; }            // 跳号
      var item = copyObj(rec);
      item.rank = rk;
      out.push(item);
      prev = rec;
    }
    return out;
  }

  /* === 4. 本地排行（真能用） =========================================== */

  var _store = null;
  var _records = null;      // 惰性加载的本地记录数组
  var _myPlayerId = '';

  function store() { if (!_store) _store = storage(); return _store; }

  function loadLocal() {
    if (_records) return _records;
    var raw = null;
    try { raw = store().get(STORE_KEY); } catch (e) { raw = null; }
    var data = null;
    if (typeof raw === 'string' && raw) {
      try { data = JSON.parse(raw); } catch (e) { data = null; }
    } else if (isObj(raw)) { data = raw; }

    _records = [];
    if (isObj(data)) {
      var list = Object.prototype.toString.call(data.records) === '[object Array]' ? data.records : [];
      for (var i = 0; i < list.length; i++) {
        // 读档时也过一遍 normalizeRecord：手改过的存档不能把排序搞崩
        if (isObj(list[i])) _records.push(normalizeRecord(list[i], 'local'));
      }
      if (typeof data.myPlayerId === 'string' && data.myPlayerId) _myPlayerId = data.myPlayerId;
    }
    return _records;
  }

  function saveLocal() {
    var list = loadLocal();
    // 只留最近的 MAX_LOCAL_RECORDS 条（按提交时间，不按名次——
    // 名次会随后来者变化，按时间留才是「我的历史」）
    if (list.length > MAX_LOCAL_RECORDS) {
      list.sort(function (a, b) { return b.at - a.at; });
      list.length = MAX_LOCAL_RECORDS;
    }
    var payload = { v: 1, myPlayerId: _myPlayerId, records: list, savedAt: Date.now() };
    var ok = false;
    try { ok = store().set(STORE_KEY, JSON.stringify(payload)); } catch (e) { ok = false; }
    return ok;
  }

  /** 稳定的本地玩家 id：第一次生成后存下来。 */
  function myPlayerId() {
    if (!_myPlayerId) {
      loadLocal();
      if (!_myPlayerId) {
        _myPlayerId = 'local-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
        saveLocal();
      }
    }
    return _myPlayerId;
  }

  /**
   * 提交一条成绩。这是**唯一**的上报入口，将来接后端时在这里加 POST。
   *
   * @param {Object} record 至少给 score；其余字段可选，缺省按 0 处理
   * @param {Object} opts   { local: 是否写本地（默认 true）,
   *                          remote: 是否尝试上报后端（默认 true，无后端时静默跳过） }
   * @returns {{ ok:boolean, record:Object, localSaved:boolean,
   *             remote:{ ok:boolean, unavailable:boolean, reason:string } }}
   *
   * 注意：本函数**同步**返回本地部分的结果；远端上报是异步的，通过返回值里的
   * remote 字段报告「不可用」，不会静默假装成功。
   */
  function submit(record, opts) {
    var o = isObj(opts) ? opts : {};
    var rec = normalizeRecord(record, 'local');
    if (!rec.playerId) rec.playerId = myPlayerId();
    if (!rec.playerId) rec.playerId = 'anon';
    rec.at = rec.at || Date.now();

    var localSaved = false;
    if (o.local !== false) {
      var list = loadLocal();
      // 同一玩家、同一局（同 at）重复提交时覆盖，避免列表里塞满重复项
      var replaced = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].playerId === rec.playerId && list[i].at === rec.at) {
          list[i] = rec; replaced = true; break;
        }
      }
      if (!replaced) list.push(rec);
      localSaved = saveLocal();
    }

    // --- 远端上报：没有后端时明确说「不可用」，不假装成功 ---
    var remote = { ok: false, unavailable: true, reason: 'no-backend' };
    if (o.remote !== false) {
      if (!SERVER_BASE) {
        remote = {
          ok: false, unavailable: true, reason: 'no-backend',
          note: '本项目是纯前端游戏，没有服务器。要在 leaderboard.js 顶部把 SERVER_BASE 换成真实地址并实现 submitToServer()，全服排行才会真的工作。'
        };
      } else {
        remote = submitToServer(rec);
      }
    }

    // --- 微信好友排行：提交成绩到微信云存储（开放数据域里才能读） ---
    var cloud = submitToWxCloud(rec);

    return { ok: true, record: rec, localSaved: localSaved, remote: remote, cloud: cloud };
  }

  /**
   * 把玩家数据写进微信云存储。这是 `wx.getFriendCloudStorage` 能读到好友数据的
   * **前提**：每个玩家都必须先 setUserCloudStorage，好友才看得到你。
   *
   * kvList 的 key / value 都有长度限制（微信文档：key ≤ 128 字节，
   * value ≤ 1KB，每个用户最多 128 个 kv）。所以只放精简后的必要字段。
   *
   * @returns {{ ok:boolean, unavailable:boolean, reason:string }}
   */
  function submitToWxCloud(rec) {
    if (typeof wx === 'undefined' || !wx) {
      return { ok: false, unavailable: true, reason: 'not-wechat' };
    }
    if (typeof wx.setUserCloudStorage !== 'function') {
      return {
        ok: false, unavailable: true, reason: 'api-missing',
        note: 'wx.setUserCloudStorage 不存在。常见原因：不在微信小游戏环境、基础库版本过低（需 ≥ 2.0.0）、或本局未在开放数据域创建时调用。'
      };
    }
    var payload = {
      wxgame: {
        score: rec.score,
        buildProgress: rec.buildProgress,
        achievementProgress: rec.achievementProgress,
        townCount: rec.townCount,
        at: rec.at
      }
    };
    var ok = true, err = null;
    try {
      // 注意：这个 API 是异步回调式；同步的 try 只能挡住参数错误。
      wx.setUserCloudStorage({
        KVDataList: [{ key: 'drifttown', value: JSON.stringify(payload.wxgame) }],
        success: function () { ok = true; },
        fail: function (e) { err = e; }
      });
    } catch (e) {
      return { ok: false, unavailable: true, reason: 'call-threw', error: String(e && e.message || e) };
    }
    return {
      ok: ok, unavailable: false, reason: err ? 'callback-failed' : 'sent',
      note: '已调用 wx.setUserCloudStorage。同步返回不代表服务端已写入，真正的结果在异步回调里；好友排行读取前建议等 1-2 秒。'
    };
  }

  /* === 5. 本地排行读取（真能用） ======================================= */

  /**
   * 本地榜 top N。同步，立刻可用。
   * @param {number} n
   * @param {string} sortBy 'build'（默认，按建造进度）| 'achievement' | 'score'
   * @returns {{ ok:true, source:'local', label:string, items:[], me:Object|null }}
   */
  function fetchTop(n, sortBy) {
    var limit = clamp(num(n, 10), 1, MAX_TOP);
    var list = loadLocal();
    var ranked = rankBy(list, sortBy);
    var items = ranked.slice(0, limit);
    var me = null, myId = myPlayerId();
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].playerId === myId) { me = ranked[i]; break; }
    }
    return {
      ok: true,
      source: 'local',
      // 这句话要原样上屏，别让用户以为这是全服数据
      label: '本地记录（本机存档 · 不是全服排行）',
      real: true,
      backendRequired: false,
      items: items,
      total: ranked.length,
      me: me,
      sortBy: normalizeSortBy(sortBy)
    };
  }

  function normalizeSortBy(v) {
    return (v === 'achievement' || v === 'score') ? v : 'build';
  }

  /** 本地榜里「我」的历史最好一条。 */
  function myBest(sortBy) {
    var ranked = rankBy(loadLocal(), sortBy);
    var myId = myPlayerId();
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].playerId === myId) return ranked[i];
    }
    return null;
  }

  /* === 6. 微信好友排行（有真实环境才能跑） =============================
   *
   * ## 需要什么配置才能真跑（这是队友最容易被坑的地方，写清楚）
   *
   * 1. **game.json 里声明开放数据域**
   *    ```json
   *    {
   *      "deviceOrientation": "landscape",
   *      "openDataContext": "open-data"
   *    }
   *    ```
   *    `open-data` 是那个目录名，里面有独立的 `index.js`（跑在**另一个** JS
   *    上下文里，不能访问主域的 game.js 变量、不能 require 主域模块）。
   *
   * 2. **project.config.json 里声明分包 / 信任域**
   *    ```json
   *    {
   *      "compileType": "game",
   *      "setting": { "es6": true },
   *      "openDataContext": "open-data"
   *    }
   *    ```
   *    注意：新版开发者工具对 `openDataContext` 的识别在 `game.json` 更可靠，
   *    两边都写上不会错。
   *
   * 3. **开放数据域里的 index.js 只能调这几个 API**：
   *    `wx.getFriendCloudStorage` / `wx.getGroupCloudStorage` /
   *    `wx.getUserCloudStorage` / `wx.getUserInfo`（开放数据域版）。
   *    它**不能**建 WebGL、不能 play 音频、不能发网络请求。
   *
   * 4. **主域通过 `wx.getOpenDataContext()` 拿到 context**，用
   *    `context.postMessage({...})` 下单，用
   *    `context.canvas`（一个 SharedCanvas）当作纹理贴到主域的场景里，
   *    或者用 `context.canvas` 的 2D 内容 `drawImage` 到主域的 HUD canvas。
   *
   * 5. **每个玩家都必须先 `wx.setUserCloudStorage`**，否则好友读不到你。
   *
   * 6. **真实微信账号 + 已发布的小游戏**：开发者工具能模拟，但好友列表只有在
   *    真机、真实登录态、且**至少有一个好友也玩过并写过云存储**时才有数据。
   *    模拟器里通常是空数组——**空数组不等于功能坏了**。
   *
   * 7. **隐私合规**：需要在微信后台的「用户隐私保护指引」中声明读取
   *    好友关系链（`getFriendCloudStorage` 属于「微信朋友关系」范围）。
   *    2023 年后未声明的调用会被拒绝。
   *
   * ## 本模块负责什么
   *   本模块**不**直接读好友数据（主域调 `wx.getFriendCloudStorage` 在
   *   部分基础库上会失败/受限）。本模块负责：
   *     a) 检测环境，判断能不能跑
   *     b) 把主域收到的原始 KVDataList **解析并排序**成排行榜条目
   *     c) 给出「怎么接」的完整指引（`friendsSetup()`）
   *   也就是说：数据获取走主域 + 开放数据域（有文档的标准做法），
   *   数据解析与排序走本模块（这些逻辑与 UI 复用，且可被 node 测试覆盖）。
   */

  /** 当前环境的微信能力探测。返回一份可上屏的诊断。 */
  function wxCapability() {
    var hasWx = typeof wx !== 'undefined' && !!wx;
    var caps = {
      hasWx: hasWx,
      platform: hasWx ? (typeof wx.getSystemInfoSync === 'function' ? (function () {
        try { return String((wx.getSystemInfoSync() || {}).platform || 'unknown'); } catch (e) { return 'unknown'; }
      })() : 'unknown') : 'not-wechat',
      setUserCloudStorage: hasWx && typeof wx.setUserCloudStorage === 'function',
      getFriendCloudStorage: hasWx && typeof wx.getFriendCloudStorage === 'function',
      getOpenDataContext: hasWx && typeof wx.getOpenDataContext === 'function',
      getUserCloudStorage: hasWx && typeof wx.getUserCloudStorage === 'function'
    };
    caps.openDataUsable = caps.hasWx && caps.getFriendCloudStorage && caps.getOpenDataContext;
    return caps;
  }

  /** 好友排行需要什么才能真跑 —— 直接可以贴给队友 / 上屏。 */
  function friendsSetup() {
    var caps = wxCapability();
    var items = [
      { key: 'game.json', text: '加一行 "openDataContext": "open-data"，并在项目里建 open-data/ 目录与 open-data/index.js' },
      { key: 'project.config.json', text: '同样写 "openDataContext": "open-data"（新版工具认 game.json，两边都写最稳）' },
      { key: 'open-data/index.js', text: '在开放数据域里调 wx.getFriendCloudStorage({ keyList:["drifttown"], success }) ，把结果 postMessage 回主域' },
      { key: '主域', text: '用 var ctx = wx.getOpenDataContext() 拿上下文；ctx.postMessage({ type:"friends" }) 下单' },
      { key: '每人先写云存储', text: '每个玩家必须先 wx.setUserCloudStorage 写自己的成绩，好友才读得到你' },
      { key: '真机 + 真实登录', text: '开发者工具只能模拟；好友列表要真机、真实账号、且有好友也玩过。空数组通常是正常现象' },
      { key: '隐私声明', text: '微信后台「用户隐私保护指引」需声明读取微信朋友关系，否则调用会被拒' }
    ];
    return {
      ok: caps.openDataUsable,
      capability: caps,
      // 现在就缺什么，一句人话
      verdict: caps.openDataUsable
        ? '环境具备微信好友排行所需的 API；还要确认 openDataContext 已在 game.json 中声明并被发布。'
        : (caps.hasWx
            ? '在微信里，但缺少 API：' + [
                caps.getFriendCloudStorage ? null : 'wx.getFriendCloudStorage',
                caps.getOpenDataContext ? null : 'wx.getOpenDataContext'
              ].filter(Boolean).join(' / ') + '（基础库版本过低或不在小游戏环境）'
            : '当前不是微信小游戏环境（Web 端）。好友排行只在微信里可用。'),
      items: items
    };
  }

  /**
   * 把 wx.getFriendCloudStorage 返回的原始数据解析成排行榜条目并排序。
   *
   * 入参是标准返回结构：
   *   { data: [ { avatarUrl, nickname, openid, KVDataList: [{ key, value }] } ] }
   * 本函数**不调用任何 wx API**（纯函数，可在 node 里测），
   * 由主域/开放数据域把数据拿到后丢进来。
   *
   * @returns {{ ok:boolean, source:'friend', label:string, items:[], total:number,
   *             skipped:number, emptyIsNormal:boolean }}
   */
  function parseFriendData(raw, sortBy) {
    var recs = [], skipped = 0;
    var list = isObj(raw) && Object.prototype.toString.call(raw.data) === '[object Array]' ? raw.data : [];
    for (var i = 0; i < list.length; i++) {
      var player = list[i];
      if (!isObj(player)) { skipped++; continue; }
      var kv = Object.prototype.toString.call(player.KVDataList) === '[object Array]' ? player.KVDataList : [];
      // 我们只写一个 key: 'drifttown'；也可能是别的 key（用户改过），全部找一遍
      var payload = null;
      for (var k = 0; k < kv.length; k++) {
        if (!isObj(kv[k])) continue;
        if (kv[k].key !== 'drifttown') continue;
        var v = kv[k].value;
        if (typeof v === 'string' && v) {
          try { payload = JSON.parse(v); } catch (e) { payload = null; }
        } else if (isObj(v)) {
          payload = v;
        }
      }
      if (!payload) { skipped++; continue; }   // 这个好友没写云存储 / 格式不对
      var openid = typeof player.openid === 'string' ? player.openid : ('friend-' + i);
      recs.push(normalizeRecord({
        playerId: openid,
        nickname: typeof player.nickname === 'string' ? player.nickname : '微信好友',
        avatarUrl: typeof player.avatarUrl === 'string' ? player.avatarUrl : '',
        score: num(payload.score, 0),
        buildProgress: num(payload.buildProgress, 0),
        achievementProgress: num(payload.achievementProgress, 0),
        townCount: num(payload.townCount, 0),
        at: num(payload.at, 0)
      }, 'friend'));
    }
    var ranked = rankBy(recs, sortBy);
    return {
      ok: true,
      source: 'friend',
      label: '微信好友排行（真实好友数据 · 需真机与开放数据域）',
      real: true,
      backendRequired: false,
      items: ranked,
      total: ranked.length,
      skipped: skipped,
      // 空数组在微信里非常常见（好友都没玩过），UI 要把它当正常情况
      emptyIsNormal: ranked.length === 0,
      sortBy: normalizeSortBy(sortBy)
    };
  }

  /**
   * 取好友排行。**在微信环境里**尝试直接调 wx.getFriendCloudStorage。
   *
   * 现实约束（务必知道）：
   *   - 主域直接调 getFriendCloudStorage 在**部分基础库上会失败**，官方推荐
   *     做法是放在开放数据域里调。所以本函数把两条路都试：先试直接调（有
   *     基础库支持），失败就返回 `needOpenDataContext:true` 并给出指引。
   *   - 无论哪条路，都必须有真实微信登录态与已声明 openDataContext。
   *   - **绝不编造假好友**。读不到就如实说读不到。
   *
   * @returns {Promise<Object>} 解析结果；不可用时 { ok:false, unavailable:true, reason, setup }
   */
  function fetchFriends(sortBy) {
    return fetchFriendsRaw(sortBy).then(function (r) {
      // 无论成功失败，一定带上配置指引：调用方拿到的永远是同一形状。
      if (isObj(r) && !r.setup) { try { r.setup = friendsSetup(); } catch (e) { /* ignore */ } }
      if (isObj(r) && !r.items) r.items = [];
      if (isObj(r) && typeof r.total !== 'number') r.total = r.items.length;
      return r;
    });
  }

  function fetchFriendsRaw(sortBy) {
    var key = normalizeSortBy(sortBy);
    var caps = wxCapability();
    if (!caps.hasWx) {
      return Promise.resolve({
        ok: false, unavailable: true, reason: 'not-wechat', source: 'friend',
        label: '微信好友排行（未在微信环境）',
        setup: friendsSetup(),
        note: 'Web 端拿不到微信好友关系链。这是平台限制，不是代码问题。'
      });
    }
    if (!caps.getFriendCloudStorage) {
      return Promise.resolve({
        ok: false, unavailable: true, reason: 'api-missing', source: 'friend',
        label: '微信好友排行（API 不可用）',
        setup: friendsSetup(),
        note: 'wx.getFriendCloudStorage 不存在。需要基础库 ≥ 2.0.0。'
      });
    }
    return new Promise(function (resolve) {
      var settled = false;
      function done(result) { if (!settled) { settled = true; resolve(result); } }
      // 兜底超时：微信在无网络/未登录时可能既不 success 也不 fail
      var timer = setTimeout(function () {
        done({
          ok: false, unavailable: true, reason: 'timeout', source: 'friend',
          label: '微信好友排行（读取超时）',
          setup: friendsSetup(),
          note: '10 秒内没有回调。常见原因：未登录、无网络、或该能力在开发工具中被限制。'
        });
      }, 10000);
      function clear() { try { clearTimeout(timer); } catch (e) { /* ignore */ } }
      try {
        wx.getFriendCloudStorage({
          keyList: ['drifttown'],
          success: function (res) {
            clear();
            var parsed = parseFriendData(res, key);
            parsed.setup = friendsSetup();
            // 关键：空数组说清楚是正常的
            if (parsed.emptyIsNormal) {
              parsed.note = '读到了 0 条好友记录。这在微信里很常见：好友都没玩过这个游戏，或者他们的 game.json 没声明开放数据域。不是功能故障。';
            }
            done(parsed);
          },
          fail: function (err) {
            clear();
            done({
              ok: false, unavailable: true, reason: 'wechat-error', source: 'friend',
              label: '微信好友排行（读取失败）',
              error: String((err && (err.errMsg || err.message)) || err || 'unknown'),
              setup: friendsSetup(),
              note: '主域直接调 getFriendCloudStorage 在部分基础库上受限，官方推荐放进开放数据域。请按 setup 里的步骤配置 openDataContext。'
            });
          }
        });
      } catch (e) {
        clear();
        done({
          ok: false, unavailable: true, reason: 'call-threw', source: 'friend',
          label: '微信好友排行（调用异常）',
          error: String(e && e.message || e),
          setup: friendsSetup()
        });
      }
    });
  }

  /* === 7. 全服排行 —— 明确不可用 =======================================
   * 没有后端就没有全服。这里**故意**不实现任何伪造数据。
   * 所有方法都返回 unavailable + 说明，UI 会显示「需后端接入」。
   */

  function serverUnavailable(reason) {
    return {
      ok: false,
      unavailable: true,
      source: 'server',
      reason: reason || 'no-backend',
      label: '全服排行（不可用 · 需要后端服务器）',
      real: false,
      backendRequired: true,
      items: [],
      total: 0,
      note: '本项目是纯前端单文件游戏，没有服务器，因此无法汇总「所有玩家」的成绩。'
          + '要让全服排行真跑，需要：① 一个后端服务（保存成绩、做鉴权与反作弊）；'
          + '② 在 leaderboard.js 顶部设置 SERVER_BASE 并实现 submitToServer / fetchTopFromServer；'
          + '③ 微信侧还要配置服务器域名白名单。在此之前本榜单不显示任何数据，'
          + '也不会用本地数据冒充全服数据。'
    };
  }

  /**
   * 全服榜 top N。**恒为不可用**（除非你接上后端）。
   * @returns {Promise<Object>} 一定是 { ok:false, unavailable:true, ... }
   */
  function fetchServerTop(n) {
    if (!SERVER_BASE) return Promise.resolve(serverUnavailable('no-backend'));
    return fetchTopFromServer(n);
  }

  /* --- 下面是给将来接后端留的空实现，注释里写清楚要改什么 --- */

  /**
   * 【待实现】把成绩 POST 到自己的服务器。
   * 接后端时把这里改成：
   *   return fetch(SERVER_BASE + '/api/score', {
   *     method: 'POST',
   *     headers: { 'Content-Type': 'application/json' },
   *     body: JSON.stringify({ ...rec, sig: sign(rec) })
   *   }).then(r => r.json());
   * 微信小游戏里用 wx.request 代替 fetch（fetch 在小游戏里不存在）。
   * 注意：一定要做服务端校验 —— 纯前端上报的成绩可以被随意伪造。
   */
  function submitToServer(rec) {
    return {
      ok: false, unavailable: true, reason: 'not-implemented',
      note: 'SERVER_BASE 已配置，但 submitToServer() 还是空实现。请在这里写真实的 POST 请求（Web 用 fetch，微信小游戏用 wx.request）。'
    };
  }

  /**
   * 【待实现】从自己的服务器拉 top N。
   * 接后端时把这里改成：
   *   return fetch(SERVER_BASE + '/api/top?n=' + n).then(r => r.json())
   *     .then(d => ({ ok:true, source:'server', items: rankBy(d.items,'build'), total:d.items.length }));
   */
  function fetchTopFromServer(n) {
    return Promise.resolve({
      ok: false, unavailable: true, source: 'server', reason: 'not-implemented',
      label: '全服排行（后端接口未实现）',
      real: false, backendRequired: true, items: [], total: 0,
      note: 'SERVER_BASE 已配置，但 fetchTopFromServer() 还是空实现。请在这里写真实的 GET 请求。'
    });
  }

  /* === 8. 微信分享（可选，真能用） ===================================== */

  /** 给 wx.onShareAppMessage 用的 payload；非微信环境返回本地文案。 */
  function sharePayload() {
    var best = myBest('build');
    var title = best
      ? ('我在《漂流小镇》建成了 ' + (best.townCount || 0) + ' 座建筑，成就 ' + best.achievementProgress + '%，来比比？')
      : '我在《漂流小镇》漂流，来比比谁的小镇建得快？';
    var payload = { title: title };
    if (typeof wx !== 'undefined' && wx && typeof wx.onShareAppMessage === 'function') {
      // 主域 game.js 里可以挂 window.__wxSharePayload = Leaderboard.sharePayload
      payload.hint = '已可挂到 wx.onShareAppMessage';
    }
    return payload;
  }

  /* === 9. Canvas 2D 绘制 ==============================================
   * 与 game.js 的 drawPill / roundRect 同一套视觉语言：深色半透明卡片 +
   * 极细白描边 + 中文文字。零 DOM，不用彩色 emoji。
   * ------------------------------------------------------------------- */

  var FONT_DEFAULT = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';

  function drawRoundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, Math.max(0, w) / 2, Math.max(0, h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function usable(ctx) {
    return !!ctx && typeof ctx.fillText === 'function' && typeof ctx.measureText === 'function';
  }

  /** 按宽度截断文字，加省略号。Canvas 没有 text-overflow。 */
  function ellipsize(ctx, text, maxW) {
    var s = String(text === undefined || text === null ? '' : text);
    if (ctx.measureText(s).width <= maxW) return s;
    var cut = s;
    while (cut.length > 1 && ctx.measureText(cut + '…').width > maxW) cut = cut.slice(0, -1);
    return cut + '…';
  }

  var TABS = [
    { id: 'local', name: '本地榜' },
    { id: 'friend', name: '好友榜' },
    { id: 'server', name: '全服榜' }
  ];

  /**
   * 排行榜界面。返回热区矩形，供 pointerdown 命中判断。
   *
   * @param ctx  Canvas 2D 上下文（调用方负责 dpr 变换）
   * @param w,h  逻辑宽高（CSS 像素）
   * @param opts {
   *   tab: 'local'|'friend'|'server',   // 当前页
   *   data: { local, friend, server },  // 各页的数据（fetchTop / parseFriendData 的返回值）
   *   font, fontFamily, scroll
   * }
   * @returns { x,y,w,h, tabs:[{id,x,y,w,h}], close:{...}, scroll, maxScroll } | null
   */
  function drawTabbed(ctx, w, h, opts) {
    if (!usable(ctx)) return null;
    var o = isObj(opts) ? opts : {};
    var W = num(w, 0), H = num(h, 0);
    if (W <= 0 || H <= 0) return null;
    var font = Math.max(11, num(o.font, Math.max(14, Math.min(22, Math.min(W, H) * 0.024))));
    var FONT = typeof o.fontFamily === 'string' && o.fontFamily ? o.fontFamily : FONT_DEFAULT;
    var tab = (o.tab === 'friend' || o.tab === 'server') ? o.tab : 'local';
    var data = isObj(o.data) ? o.data : {};

    var pW = Math.min(W * 0.88, 660), pH = Math.min(H * 0.84, 760);
    var pX = (W - pW) / 2, pY = (H - pH) / 2;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = 'rgba(8,14,26,0.64)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(18,26,44,0.97)';
    drawRoundRect(ctx, pX, pY, pW, pH, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(255,214,140,0.45)';
    ctx.lineWidth = 2;
    drawRoundRect(ctx, pX, pY, pW, pH, 16); ctx.stroke();

    // 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe2a8';
    ctx.font = '800 ' + (font * 1.25) + 'px ' + FONT;
    ctx.fillText('排行榜', W / 2, pY + font * 1.7);

    // 关闭按钮
    var cxW = font * 2.2, cxH = font * 1.6;
    var cxX = pX + pW - cxW - font * 0.8, cxY = pY + font * 0.7;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    drawRoundRect(ctx, cxX, cxY, cxW, cxH, cxH / 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 ' + (font * 0.78) + 'px ' + FONT;
    ctx.fillText('关闭', cxX + cxW / 2, cxY + cxH * 0.72);

    // 三个 tab
    var tabY = pY + font * 2.4;
    var tabH = font * 1.9;
    var tabGap = font * 0.6;
    var tabW = Math.min((pW - font * 2.4 - tabGap * 2) / 3, font * 6);
    var tabTotalW = tabW * TABS.length + tabGap * (TABS.length - 1);
    var tabX0 = (W - tabTotalW) / 2;
    var tabRects = [];
    for (var ti = 0; ti < TABS.length; ti++) {
      var t = TABS[ti];
      var tx = tabX0 + ti * (tabW + tabGap);
      var active = t.id === tab;
      tabRects.push({ id: t.id, x: tx, y: tabY, w: tabW, h: tabH });
      ctx.fillStyle = active ? 'rgba(255,214,140,0.9)' : 'rgba(255,255,255,0.08)';
      drawRoundRect(ctx, tx, tabY, tabW, tabH, tabH / 2); ctx.fill();
      if (active) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
        drawRoundRect(ctx, tx, tabY, tabW, tabH, tabH / 2); ctx.stroke();
      }
      ctx.fillStyle = active ? '#1a2233' : 'rgba(223,242,255,0.85)';
      ctx.font = '700 ' + (font * 0.82) + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText(t.name, tx + tabW / 2, tabY + tabH * 0.7);
      // 好友 / 全服 tab 上加一个小锁标记（纯文字，不用 emoji）
      if (t.id !== 'local') {
        var lock = t.id === 'friend' ? '微' : '服';
        ctx.font = '700 ' + (font * 0.55) + 'px ' + FONT;
        ctx.fillStyle = active ? 'rgba(26,34,51,0.6)' : 'rgba(255,226,168,0.6)';
        ctx.fillText(lock, tx + tabW - font * 0.55, tabY + font * 0.62);
      }
      ctx.textAlign = 'left';
    }

    // 表头 / 状态条
    var statusY = tabY + tabH + font * 1.15;
    var payload = data[tab];
    var items = isObj(payload) && Object.prototype.toString.call(payload.items) === '[object Array]'
      ? payload.items : [];
    var listTop = statusY + font * 0.9;

    ctx.textAlign = 'left';
    ctx.font = '700 ' + (font * 0.74) + 'px ' + FONT;
    if (isObj(payload) && payload.label) {
      // 每一页都明确写出数据来源，尤其是「这是本地 / 这是真实好友 / 这不可用」
      ctx.fillStyle = payload.unavailable ? '#ffb4a0'
        : (tab === 'local' ? 'rgba(255,226,168,0.92)' : 'rgba(159,240,184,0.92)');
      ctx.fillText(ellipsize(ctx, payload.label, pW - font * 2.4), pX + font * 1.2, statusY);
      listTop = statusY + font * 0.9;
    } else {
      ctx.fillStyle = 'rgba(200,230,255,0.7)';
      ctx.fillText('尚未加载', pX + font * 1.2, statusY);
    }

    // 不可用说明（全服榜）
    var listBottom = pY + pH - font * 1.4;
    if (isObj(payload) && payload.unavailable) {
      var msg = payload.note || payload.reason || '不可用';
      ctx.fillStyle = 'rgba(255,180,160,0.92)';
      ctx.font = '600 ' + (font * 0.72) + 'px ' + FONT;
      // 手动按宽度折行
      var maxW = pW - font * 2.4;
      var lines = [], line = '';
      for (var ci = 0; ci < msg.length; ci++) {
        var test = line + msg[ci];
        if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = msg[ci]; }
        else line = test;
      }
      if (line) lines.push(line);
      for (var li = 0; li < lines.length && listTop + li * font * 1.35 < listBottom; li++) {
        ctx.fillText(lines[li], pX + font * 1.2, listTop + li * font * 1.35 + font * 0.6);
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,226,168,0.9)';
      ctx.font = '800 ' + (font * 0.95) + 'px ' + FONT;
      ctx.fillText('需后端接入', W / 2, pY + pH - font * 1.4);
      ctx.textAlign = 'left';
      ctx.restore();
      return { x: pX, y: pY, w: pW, h: pH, tab: tab, tabs: tabRects,
               close: { x: cxX, y: cxY, w: cxW, h: cxH }, scroll: 0, maxScroll: 0, rowH: 0 };
    }

    // 空列表提示
    if (!items.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(223,242,255,0.6)';
      ctx.font = '600 ' + (font * 0.86) + 'px ' + FONT;
      var emptyMsg = tab === 'friend'
        ? '没有好友成绩（微信里很常见，不是故障）'
        : (tab === 'server' ? '全服排行需要后端' : '还没有记录，玩一局吧');
      ctx.fillText(emptyMsg, W / 2, listTop + font * 2);
      if (tab === 'friend' && isObj(payload) && payload.setup && payload.setup.items) {
        ctx.font = '600 ' + (font * 0.68) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(255,226,168,0.75)';
        ctx.fillText('配置步骤见 Leaderboard.friendsSetup()', W / 2, listTop + font * 3.6);
      }
      ctx.textAlign = 'left';
      ctx.restore();
      return { x: pX, y: pY, w: pW, h: pH, tab: tab, tabs: tabRects,
               close: { x: cxX, y: cxY, w: cxW, h: cxH },
               scroll: 0, maxScroll: 0, rowH: 0 };
    }

    // 列表
    var listX = pX + font * 1.2;
    var listW = pW - font * 2.4;
    var rowH = font * 2.3;
    var visible = Math.max(1, Math.floor((listBottom - listTop) / rowH));
    var maxScroll = Math.max(0, items.length - visible);
    var sc = clamp(num(o.scroll, 0), 0, maxScroll);

    // 列头
    ctx.font = '700 ' + (font * 0.62) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(200,230,255,0.5)';
    var colName = listX + font * 2.6;
    ctx.fillText('名次', listX + font * 0.2, listTop + font * 0.2);
    ctx.fillText('玩家', colName, listTop + font * 0.2);
    ctx.textAlign = 'right';
    ctx.fillText('建造', listX + listW - font * 6.4, listTop + font * 0.2);
    ctx.fillText('成就', listX + listW - font * 3.2, listTop + font * 0.2);
    ctx.fillText('综合分', listX + listW - font * 0.2, listTop + font * 0.2);
    ctx.textAlign = 'left';
    var bodyTop = listTop + font * 0.9;

    var myId = myPlayerId();
    ctx.save();
    ctx.beginPath();
    ctx.rect(listX - 4, bodyTop - 4, listW + 8, listBottom - bodyTop + 8);
    ctx.clip();
    for (var i = 0; i < items.length && i < sc + visible + 1; i++) {
      if (i < sc) continue;
      var it = items[i];
      var ry = bodyTop + (i - sc) * rowH;
      if (ry + rowH > listBottom + rowH) break;
      var isMe = it.playerId === myId;
      ctx.fillStyle = isMe ? 'rgba(255,214,140,0.16)'
                          : (i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.07)');
      drawRoundRect(ctx, listX, ry, listW, rowH - 4, 8); ctx.fill();
      if (isMe) {
        ctx.strokeStyle = 'rgba(255,214,140,0.5)'; ctx.lineWidth = 1;
        drawRoundRect(ctx, listX, ry, listW, rowH - 4, 8); ctx.stroke();
      }

      // 名次（前三名给金色文字，不用 emoji）
      ctx.textAlign = 'left';
      ctx.font = '800 ' + (font * 0.86) + 'px ' + FONT;
      ctx.fillStyle = it.rank === 1 ? '#ffd166' : (it.rank <= 3 ? '#ffe2a8' : 'rgba(223,242,255,0.8)');
      ctx.fillText(String(it.rank), listX + font * 0.3, ry + rowH * 0.62);

      // 昵称
      ctx.fillStyle = isMe ? '#ffe2a8' : '#ffffff';
      ctx.font = '700 ' + (font * 0.84) + 'px ' + FONT;
      var nickW = listW - font * 8.2;
      ctx.fillText(ellipsize(ctx, it.nickname + (isMe ? '（我）' : ''), nickW), colName, ry + rowH * 0.62);

      // 三个数字
      ctx.textAlign = 'right';
      ctx.font = '700 ' + (font * 0.78) + 'px ' + FONT;
      ctx.fillStyle = '#c8f0ff';
      ctx.fillText(it.buildProgress + '%', listX + listW - font * 6.4, ry + rowH * 0.62);
      ctx.fillStyle = '#c8f0b0';
      ctx.fillText(it.achievementProgress + '%', listX + listW - font * 3.2, ry + rowH * 0.62);
      ctx.fillStyle = '#ffe2a8';
      ctx.fillText(String(it.score), listX + listW - font * 0.2, ry + rowH * 0.62);
      ctx.textAlign = 'left';
    }
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,226,168,0.7)';
    ctx.font = '700 ' + (font * 0.66) + 'px ' + FONT;
    ctx.fillText(maxScroll > 0 ? ('上下滑动 · 共 ' + items.length + ' 条')
                               : ('共 ' + items.length + ' 条'), W / 2, pY + pH - font * 0.5);
    ctx.textAlign = 'left';
    ctx.restore();

    return { x: pX, y: pY, w: pW, h: pH, tab: tab, tabs: tabRects,
             close: { x: cxX, y: cxY, w: cxW, h: cxH },
             scroll: sc, maxScroll: maxScroll, rowH: rowH, visible: visible,
             listTop: bodyTop, listX: listX, listW: listW };
  }

  /** 命中测试：点在哪。返回 'close' | 某 tab id | 'row:<index>' | 'outside' | 'inside' */
  function hitTest(ui, x, y) {
    if (!isObj(ui)) return 'outside';
    var px = num(x, -1), py = num(y, -1);
    function inside(r) {
      return isObj(r) && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    }
    if (inside(ui.close)) return 'close';
    var tabs = Object.prototype.toString.call(ui.tabs) === '[object Array]' ? ui.tabs : [];
    for (var i = 0; i < tabs.length; i++) {
      if (inside(tabs[i])) return tabs[i].id;
    }
    if (px >= ui.x && px <= ui.x + ui.w && py >= ui.y && py <= ui.y + ui.h) {
      if (num(ui.rowH, 0) > 0 && py >= num(ui.listTop, 0)) {
        var row = Math.floor((py - ui.listTop) / ui.rowH) + num(ui.scroll, 0);
        return 'row:' + row;
      }
      return 'inside';
    }
    return 'outside';
  }

  /* === 10. 汇总视图（给 HUD 上的「我的成绩」小卡片） =================== */

  /**
   * 一条给我的成绩记录，从 gameState 折算。这是 submit() 的入参构造器。
   * @param state window.__gameState() 的返回值
   * @param ach   window.Achievements（可选；给了就用它算成就进度）
   */
  function recordFromState(state, ach) {
    var s = isObj(state) ? state : {};
    var buildPct = 0, achPct = 0, achCount = 0, townCount = 0;
    // 建造进度：6 座城镇建筑 + 6 件生存装备 = 12 个里程碑
    var town = num(s.buildings, 0);
    if (Object.prototype.toString.call(s.buildings) === '[object Array]') town = s.buildings.length;
    var surv = Object.prototype.toString.call(s.survival) === '[object Array]' ? s.survival.length : 0;
    townCount = town;
    var milestones = 12;
    buildPct = clamp(Math.round((town + surv) / milestones * 100), 0, 100);
    if (ach && typeof ach.snapshot === 'function') {
      var snap = null;
      try { snap = ach.snapshot(); } catch (e) { snap = null; }
      if (isObj(snap)) {
        achPct = clamp(num(snap.overall, 0), 0, 100);
        achCount = num(snap.unlocked, 0);
      }
    }
    var score = num(s.score, 0);
    return normalizeRecord({
      playerId: myPlayerId(),
      nickname: '我',
      score: score,
      buildProgress: buildPct,
      achievementProgress: achPct,
      achievementCount: achCount,
      townCount: townCount,
      at: Date.now()
    }, 'local');
  }

  /* === 11. 自检 ======================================================= */

  function selfTest() {
    var problems = [];

    /* 排序确定性 + 并列/跳号规则。样例里 a 与 b 的三个可见指标完全相同
     * （建造 50 / 成就 50 / 分数 100），只有 at 与 id 不同，所以它们并列。 */
    var sample = [
      { playerId: 'a', buildProgress: 50, achievementProgress: 50, score: 100, at: 1 },
      { playerId: 'b', buildProgress: 50, achievementProgress: 50, score: 100, at: 1 },  // 与 a 完全并列
      { playerId: 'c', buildProgress: 50, achievementProgress: 50, score: 100, at: 2 },  // 也并列，只是更晚
      { playerId: 'd', buildProgress: 100, achievementProgress: 10, score: 10, at: 5 }   // 建造最高
    ];
    var r1 = rank(sample), r2 = rank(sample);
    if (JSON.stringify(r1) !== JSON.stringify(r2)) problems.push('rank() 两次结果不一致（非确定性排序）');
    if (r1[0].playerId !== 'd') problems.push('建造进度最高的没排第一');
    // d 第 1，其余三条三个指标相同 → 并列第 2，所以名次是 1,2,2,2
    if (r1[1].rank !== 2 || r1[2].rank !== 2 || r1[3].rank !== 2) {
      problems.push('并列名次未生效（期望 d=1，其余三条都是 2）');
    }
    // 并列者内部：at 小的排前面（先达成的靠前）
    if (r1[1].playerId !== 'a' && r1[1].playerId !== 'b') problems.push('并列组内的顺序不符合 at 升序规则');

    // 跳号：一个完整并列组后面，名次要跳过整组
    var jump = rank([
      { playerId: 'x', buildProgress: 80, achievementProgress: 60, score: 500, at: 100 },
      { playerId: 'y', buildProgress: 80, achievementProgress: 60, score: 500, at: 100 },
      { playerId: 'z', buildProgress: 40, achievementProgress: 30, score: 200, at: 100 }
    ]);
    if (jump[0].rank !== 1 || jump[1].rank !== 1) problems.push('完全并列的两条没有共享名次 1');
    if (jump[2].rank !== 3) problems.push('并列后名次未跳号（第三名应为 3 而非 2）');

    // 名次单调
    for (var i = 1; i < jump.length; i++) {
      if (jump[i].rank < jump[i - 1].rank) problems.push('名次非单调：位置 ' + i);
    }

    // 环境探测不抛
    try { wxCapability(); } catch (e) { problems.push('wxCapability() 抛异常：' + e.message); }
    try { friendsSetup(); } catch (e) { problems.push('friendsSetup() 抛异常：' + e.message); }

    // 畸形记录被规整到合法范围
    var bad = rank([null, undefined, {}, { score: 'abc', buildProgress: NaN, at: -5 }]);
    for (var j = 0; j < bad.length; j++) {
      if (typeof bad[j].buildProgress !== 'number' || bad[j].buildProgress < 0 || bad[j].buildProgress > 100) {
        problems.push('畸形记录规整后 buildProgress 越界');
      }
    }

    // 解析好友数据不会编造条目
    var parsed = parseFriendData({ data: [{ openid: 'x', KVDataList: [{ key: 'other', value: '{}' }] }] });
    if (parsed.items.length !== 0) problems.push('parseFriendData 把没有我们 key 的好友也算进去了');
    if (parsed.skipped !== 1) problems.push('parseFriendData 的 skipped 计数不对');

    // 全服榜必须是「明确不可用」，不能装作有数据
    var srv = serverUnavailable('no-backend');
    if (srv.ok !== false || srv.unavailable !== true) problems.push('全服榜没有如实报告不可用');
    if (srv.items.length !== 0) problems.push('全服榜返回了条目（不允许伪造数据）');

    return { passed: problems.length === 0, problems: problems };
  }

  /* === 12. 导出 ======================================================= */

  return {
    VERSION: MODULE_VERSION,
    STORE_KEY: STORE_KEY,
    SERVER_BASE: SERVER_BASE,

    /* 数据上报 / 读取 —— 任务书要求的三个接口 */
    submit: submit,
    fetchTop: fetchTop,
    fetchFriends: fetchFriends,
    fetchServerTop: fetchServerTop,

    /* 本地榜辅助 */
    myPlayerId: myPlayerId,
    myBest: myBest,
    recordFromState: recordFromState,

    /* 微信好友榜辅助（纯函数，可 node 测） */
    parseFriendData: parseFriendData,
    wxCapability: wxCapability,
    friendsSetup: friendsSetup,
    submitToWxCloud: submitToWxCloud,
    sharePayload: sharePayload,

    /* 排序（纯函数，可 node 测） */
    rank: rank,
    rankBy: rankBy,
    compareRecords: compareRecords,
    normalizeRecord: normalizeRecord,

    /* UI */
    drawTabbed: drawTabbed,
    draw: drawTabbed,
    hitTest: hitTest,
    TABS: TABS,

    selfTest: selfTest,

    /* 测试用 */
    _serverUnavailable: serverUnavailable,
    _resetLocal: function () {
      _records = [];
      _myPlayerId = '';
      saveLocal();
    },
    _setRecords: function (list) {
      _records = [];
      if (Object.prototype.toString.call(list) === '[object Array]') {
        for (var i = 0; i < list.length; i++) _records.push(normalizeRecord(list[i], 'local'));
      }
      saveLocal();
    }
  };
});
