# Hand State 协议

这份文档定义引擎的输入格式。你的游戏（或手牌日志、复盘工具）只要在每个决策点产出这样一份 JSON，引擎就能给出建议。

设计目标有三个：

1. **和游戏引擎解耦** —— 引擎只认 JSON，不关心它来自 Unity、Cocos、C# 服务端还是手工输入。
2. **可回放** —— 一份 hand state 序列就是一条完整的决策链，可以直接存成测试夹具。
3. **失败可诊断** —— 字段缺失时有明确默认值，牌不合法时直接抛错，不静默给出错误建议。

---

## 最小可用示例

```json
{
  "street": "flop",
  "hero": { "pos": "BTN", "cards": ["Ac", "Kc"], "stack": 97, "invested": 3 },
  "board": ["As", "7d", "2c"],
  "pot": 6,
  "toCall": 0,
  "villainPos": "BB"
}
```

```js
const d = GTOEngine.advise(state);
// {
//   action: "bet", actionCN: "下注",
//   sizing: { fraction: 0.33, absolute: 2.0 },
//   frequency: 0.85, confidence: "high",
//   reasons: ["牌面 A 高 · 干燥（彩虹）。", "..."],
//   board: { texture: "dry", rangeAdv: 0.5, nutAdv: 0.35, ... }
// }
```

---

## 字段表

### 必填

| 字段 | 类型 | 说明 |
|---|---|---|
| `hero.cards` | `string[2]` | 你的两张底牌，如 `["As","Kh"]`。**只有这个字段缺失会抛错**，因为引擎无法猜测。 |
| `board` | `string[]` | 公共牌，0/3/4/5 张。翻前传 `[]` 或省略。 |

### 常用

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `street` | `"preflop"\|"flop"\|"turn"\|"river"` | 由 `board` 长度推断 | 显式指定可覆盖推断 |
| `hero.pos` | `"UTG"\|"MP"\|"CO"\|"BTN"\|"SB"\|"BB"` | `"BTN"` | 你的位置 |
| `hero.stack` | `number` | `100` | 当前筹码（bb） |
| `hero.invested` | `number` | `0` | 本手已投入的筹码（bb） |
| `pot` | `number` | `0` | **当前底池，含对手刚下的注** |
| `toCall` | `number` | `0` | 你需要补的金额（bb）。`0` 表示轮到你主动行动 |
| `villainPos` | `string` | `null` | 对手位置。未提供时按 `MP` 估计 |
| `villainOpenPos` | `string` | `null` | 翻前开池者的位置，用于推断对手范围 |
| `raiseCount` | `number` | `toCall>0 ? 1 : 0` | 本手已发生的加注次数。`2` = 面对 3bet |
| `effectiveStack` | `number` | `hero.stack` | 有效筹码（双方较小者）。短筹码判断用这个 |
| `iterations` | `number` | `6000` | 蒙特卡洛次数。越大越准、越慢 |

### 可选

| 字段 | 类型 | 说明 |
|---|---|---|
| `villainRange` | `string` | 直接指定对手范围，如 `"22+,A2s+,KTs+"`。提供后引擎不再自动推断 |
| `villainRaisedPostflop` | `boolean` | 对手在翻后加注过 → 范围进一步收窄 |
| `numPlayers` | `number` | 入池人数。目前只影响提示文案，策略仍按单挑计算 |
| `betFraction` | `number` | 对手下注占池比例。不给时由 `toCall / (pot - toCall)` 反推 |

---

## 关键语义

### `pot` 与 `toCall` 的关系

`pot` **包含**对手刚下的注。这是最容易搞错的地方。

对手在 6 的池里下注 2，轮到你：

```json
{ "pot": 8, "toCall": 2 }
```

引擎内部会算：

- 赔率要求 `toCall / (pot + toCall)` = `2 / 10` = **20%**
- 对手尺度 `toCall / (pot - toCall)` = `2 / 6` = **33%** 池
- MDF = `1 / (1 + 0.33)` = **75%**

如果误写成 `{ "pot": 6, "toCall": 2 }`，尺度会被算成 50%，MDF 变成 67%，建议就会偏保守。

### `street` 的推断

不传 `street` 时按 `board` 长度推断：

| board 长度 | street |
|---|---|
| 0 | preflop |
| 3 | flop |
| 4 | turn |
| 5 | river |

建议**显式传**：有时你想分析「翻牌圈的决策」，但已经知道后面的牌（复盘场景），这时 board 会是 5 张，推断就会出错。

### `raiseCount` 决定走哪套翻前逻辑

| raiseCount | 场景 | 引擎逻辑 |
|---|---|---|
| 0 | 无人入池，我是 RFI | 查位置开池范围表 |
| 1 | 面对一个 open | 3bet 范围 / 跟注范围 / 弃牌 |
| ≥2 | 面对 3bet 或更大 | 4bet / 跟注 / 弃牌；短筹码（≤30bb）走 push/fold |

翻前的 `toCall > 0` 不会自动等于 `raiseCount = 1`，因为「大盲补盲」也是 `toCall > 0` 但不是面对加注。**大盲面对开池时请显式传 `raiseCount: 1`。**

---

## 输出结构

```js
{
  action: "fold"|"check"|"call"|"bet"|"raise"|"3bet"|"4bet"|"allin",
  actionCN: "弃牌"|"过牌"|...,
  sizing: null | {
    fraction: number,        // 下注类：占池比例；翻前：相对当前池的派生倍数
    absolute: number|null,   // 具体金额（bb）
    unit: "pot" | "bb"       // pot=按池比例表达；bb=按绝对筹码表达（翻前的开池/3bet/4bet）
  },
  frequency: 0.0 ~ 1.0,          // 该动作在 solver 里的近似频率
  confidence: "high"|"medium"|"low",
  reasons: string[],              // 至少 2 条，说明「为什么」
  note: string|null,              // 额外的条件性提醒
  mixed: boolean,                 // 是否属于混合策略（频率接近 50%）
  metrics: {
    equity?: number,              // 对估计对手范围的权益
    potOdds?: number,             // 跟注所需权益
    mdf?: number,                 // 最低防守频率
    betFreq?: number,             // 该牌面下整体下注频率
    spr?: number
  },
  street, handClass, position,
  board?: { texture, rangeAdv, nutAdv, ... }   // 仅翻后
}
```

**`sizing.unit` 决定 UI 怎么显示**：`pot` 的语义是「下注占池比例」（33% 池），`bb` 的语义是「加注到多少筹码」（3bet 到 9bb）。翻前的开池、3bet、4bet 一律用 `bb`——用池比例表达「3bet 到 9bb」会得到「225% 池」这种读不出意义的数字。

**`frequency` 不是「建议你按这个概率行动」**，而是「这个动作在 GTO 策略里的权重」。`mixed: true` 且 `frequency ≈ 0.5` 时，两个动作的 EV 几乎相同，选哪个都不算错。

**`confidence` 的含义**：
- `high` —— 结论稳定，偏离基本就是错误（如 UTG 的 AA）
- `medium` —— 有明确倾向，但边缘情况下可以调整
- `low` —— 接近混合策略，需要结合对手倾向决定

---

## 游戏侧接入方式

引擎是纯函数，不碰网络、不读内存、不做 IO。所以接入口径完全由你决定。

### 方案 A：同进程内联（推荐给内部学习版）

游戏逻辑层在每个决策点组装 state，直接调用：

```js
// 你是游戏开发者，直接把内部状态转成协议格式
const state = {
  street: table.streetName(),
  hero: {
    pos: seatName(table.heroSeat),
    cards: table.heroHoleCards.map(c => c.rank + c.suit),   // 用你自己的牌对象
    stack: table.heroStack / table.bigBlind,
    invested: table.heroInvested / table.bigBlind
  },
  board: table.board.map(c => c.rank + c.suit),
  pot: table.pot / table.bigBlind,
  toCall: table.amountToCall / table.bigBlind,
  raiseCount: table.raiseCountThisHand,
  villainPos: seatName(table.lastAggressorSeat)
};

const advice = GTOEngine.advise(state);
coachPanel.render(advice);        // 教学面板
```

这是内部学习/教学模式最干净的做法：**你不需要识别屏幕，因为你本来就知道状态。**

### 方案 B：旁路进程（跨语言）

游戏侧把 state 写成 JSON Lines（每行一个决策点），旁路进程 tail 这个文件并回写建议：

```jsonl
{"seq":1,"street":"preflop","hero":{"pos":"BTN","cards":["Ac","Kc"],"stack":100},"pot":1.5,"toCall":0,"raiseCount":0}
{"seq":2,"street":"flop","hero":{"pos":"BTN","cards":["Ac","Kc"],"stack":97,"invested":3},"board":["As","7d","2c"],"pot":6,"toCall":0}
```

好处是游戏主循环完全不受影响，坏处是有延迟（文件轮询通常 10-50ms，教学场景够用）。

### 方案 C：离线复盘

把一手牌的所有决策点按顺序存成数组，跑 `replay`：

```js
const results = GTOEngine.replay([
  { street: 'preflop', hero: {...}, pot: 1.5, toCall: 0, raiseCount: 0 },
  { street: 'flop',    hero: {...}, board: ['As','7d','2c'], pot: 6, toCall: 0 }
]);
```

这是**训练和评估**最有价值的用法：批量跑历史牌局，统计「哪些节点偏离基线最多」。

---

## 范围字符串语法

引擎和工具台共用一套简写：

| 写法 | 含义 | 组合数 |
|---|---|---|
| `AA` | 口袋对子 | 6 |
| `AKs` | 同花 AK | 4 |
| `AKo` | 非同花 AK | 12 |
| `AK` | s + o 合并 | 16 |
| `22+` | 22 到 AA 的所有对子 | 78 |
| `A2s+` | A2s…AKs | 48 |
| `ATo+` | ATo…AKo | 48 |
| `all` | 全部 | 1326 |

解析器容忍 `,`、空格、中文逗号混排。无法识别的 token 会被**静默忽略**（而非报错），所以拼错范围时不会中断运行——这是刻意的取舍，方便手工输入。

---

## 已知边界

引擎是**基线规则引擎**，不是 solver。以下是明确的局限，用之前请先接受：

1. **不做树搜索。** 它不会向前推演「我下注后对手加注我该怎样」。每个决策独立评估。
2. **多人池按单挑处理。** `numPlayers > 2` 只会调整提示文案。多人池的策略在结构上不同（更收缩、更少诈唬），需要单独实现。
3. **对手范围是启发式估计。** 按位置查表 + 按压力收窄，不是贝叶斯更新。
4. **没有 ICM、没有抽水、没有多桌锦标赛因素。** 只有 Chip EV。
5. **翻前范围是 6-max / 100bb / 无 ante 的现金局基线。** 短桌、深筹码、有 ante 都需要重新校准。

这些限制不影响它作为**教学工具**：新手最常犯的错误（拿错范围、牌面看反、尺度乱选、河牌中等牌下注）都覆盖到了。

---

## 版本

- `1.0.0` —— 初始协议，字段与 `gto-engine.js@1.0.0` 对应。

协议向后兼容：新增字段不会破坏旧调用方；删除字段会升 minor 版本。
