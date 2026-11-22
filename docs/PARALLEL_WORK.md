# 并行开发协作说明

> 本文档记录多智能体并行开发的分工与版本控制策略。

## 当前并行任务

| 任务 | 负责智能体 | 写入范围 | 分支 |
| --- | --- | --- | --- |
| A · 生存层（庇护所+装备+饥饿） | `survival-dev` | `game.js`、`game.json` | `feature/survival-layer` |
| B · 潜水原型（验证 R7） | `dive-prototype-dev` | `prototype/dive/` | `feature/dive-prototype` |
| C · 管理后台与数据表 | `admin-data-dev` | `data/`、`admin/` | `feature/admin-data` |

## 写入范围隔离原则

三个任务的文件范围**完全不重叠**，因此可以真正并行：

```
game.js / game.json       ← 只有 A 改
prototype/dive/**         ← 只有 B 改
data/** + admin/**        ← 只有 C 改
docs/**                   ← 只有 Lead 改
```

**禁止跨范围修改**。如果某个智能体发现需要改别人的文件，必须先报告 Lead。

## 版本控制策略

### 分支模型

```
main
 ├── feature/survival-layer    (A)
 ├── feature/dive-prototype    (B)
 └── feature/admin-data        (C)
```

### 合并顺序

三个分支相互独立，理论上可任意顺序合并。但存在**逻辑依赖**：

```
C (data/)  ──────────────┐
                         ├─→ 未来：游戏读 data/ 配置
A (game.js) ─────────────┤
                         └─→ 未来：潜水玩法并入主游戏
B (prototype/) ──────────┘
```

当前阶段三者都是**增量新增**，无冲突。合并顺序按完成先后即可。

### 提交规范

每个分支的提交信息格式：

```
<范围>: <做了什么>

- 具体改动 1
- 具体改动 2
```

范围前缀：`生存层` / `潜水原型` / `后台数据`

### 标签

每完成一个里程碑打 tag：

- `v1.3.0-survival` — 生存层完成
- `v0.1.0-dive-proto` — 潜水原型完成
- `v0.1.0-admin` — 后台数据完成
- `v1.3.0` — 三者合并后的整合版本

---

## 质量门禁

合并前 Lead 必须检查：

| 检查项 | 方法 |
| --- | --- |
| 语法正确 | `node --check game.js` |
| 构建成功 | `game_studio_build` |
| 桌面可玩 | `game_studio_playtest`（web） |
| 微信可玩 | `game_studio_playtest`（wechat） |
| 无报错 | 试玩报告 `Errors: none` |
| JSON 合法 | `node -e` 逐个 parse |
| HUD 无 emoji | 代码检索，确认用中文文字 |
| 无 DOM 依赖 | 代码检索 `document.createElement` 仅限 canvas |

---

## 冲突处理

若两个分支意外改了同一文件（理论上不应发生）：

1. 先合并不冲突的一方
2. 另一方 rebase 到最新 main
3. 手动解决冲突后重新验证

若发生**语义冲突**（比如 A 改了建筑系统，而 C 的数据表结构与之不符）：

1. 以 A 的实际实现为准（游戏代码是真相来源）
2. C 调整数据表对齐
3. 在 PROGRESS.md 记录这次对齐
