# 接口文档

把 `engine/gto-engine.js` 包的决策能力，通过三种口径暴露出去。挑一个用，不用都接。

| 方式 | 适用场景 | 启动 |
|---|---|---|
| **HTTP** | 跨语言、跨进程、远程调试 | `node server/gto-server.js` |
| **stdio** | 已经 spawn 了子进程，不想管端口 | `node server/gto-cli.js` |
| **进程内** | Node / 浏览器，追求零延迟 | `require('./engine/gto-engine.js')` |

三种口径共用同一套校验层（`server/validate.js`）和同一套教学层（`server/enrich.js`），
所以**同一份 hand state 在三条路径上返回的结论完全一致**——这一点有测试兜着
（`tools/test-api.js` 里的「本地直算与服务端同 seed 权益完全一致」）。

---

## 1. HTTP

```bash
node server/gto-server.js --port 8787
```

```
http://127.0.0.1:8787
```

启动后浏览器打开 `http://127.0.0.1:8787/demo/api-lab.html` 是调试台，
`http://127.0.0.1:8787/index.html` 是知识库。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/health` | 健康检查，带版本与限额 |
| `GET` | `/v1/meta` | 字段表、枚举、语义约定 |
| `GET` | `/v1/examples` | 11 个标准样例（含一个反例） |
| `POST` | `/v1/advise` | 单次分析 |
| `POST` | `/v1/advise/batch` | 批量，一次最多 100 条 |
| `POST` | `/v1/replay` | `batch` 的别名 |

### 一次完整往返

```bash
curl -X POST http://127.0.0.1:8787/v1/advise \
  -H "Content-Type: application/json" \
  -d '{
    "street": "flop",
    "hero":  { "pos": "BTN", "cards": ["Ac","Kc"], "stack": 97.7, "invested": 2.3 },
    "board": ["As","7d","2c"],
    "pot":   5.1,
    "toCall": 0,
    "numPlayers": 2,
    "villainPos": "BB"
  }'
```

```json
{
  "ok": true,
  "apiVersion": "1.0",
  "engineVersion": "1.0.0",
  "requestId": "9f2c1d84-...",
  "seed": 2841773912,
  "elapsedMs": 27.46,
  "input": {
    "street": "flop",
    "hero": { "pos": "BTN", "cards": ["Ac","Kc"], "stack": 97.7, "invested": 2.3 },
    "board": ["As","7d","2c"],
    "pot": 5.1, "toCall": 0,
    "handClass": "AKs"
  },
  "decision": {
    "action": "bet",
    "actionCN": "下注",
    "sizing": { "fraction": 0.33, "absolute": 1.683, "unit": "pot" },
    "frequency": 0.85,
    "confidence": "high",
    "mixed": false,
    "metrics": { "equity": 0.899, "betFreq": 0.725, "spr": 18.706 },
    "board": {
      "texture": "dry", "textureCN": "干燥",
      "suitType": "rainbow", "suitTypeCN": "彩虹",
      "rangeAdv": 0.5, "nutAdv": 0.35
    },
    "reasons": [
      "牌面 A 高 · 干燥（彩虹）。",
      "你的范围优势评分 0.50，坚果优势评分 0.35（正数偏向翻前加注者）。",
      "你当前成牌：顶对。",
      "对估计的对手范围，你的权益 89.9%（6k 次蒙特卡洛）。",
      "有效 SPR ≈ 18.7。",
      "坚果优势在你这边，可用较大的尺度（2/3 池）。",
      "范围优势明显，下注频率高（约 72.5%）—— 高频率必须配小尺度…",
      "你这手牌属于价值下注区间（权益 89.9%），应该下注而不是过牌。"
    ]
  },
  "teaching": {
    "headline": "翻牌圈 A♠ 7♦ 2♣｜BTN AKs → 下注 33% 池（1.7bb）",
    "frequencyPct": "85.0%",
    "frequencyNote": "主频动作：下注 占 85.0%，可以直接记。",
    "metrics": [
      { "key": "equity", "label": "权益", "value": 0.899, "display": "89.9%",
        "desc": "对当前估算对手范围的胜率" },
      { "key": "betFreq", "label": "下注频率", "value": 0.725, "display": "72.5%",
        "desc": "该节点基线的建议下注频率" },
      { "key": "spr", "label": "SPR", "value": 18.706, "display": "18.71",
        "desc": "后手筹码 / 底池" }
    ],
    "edge": null,
    "practiceTip": "遮住结论，只看牌面 A♠ 7♦ 2♣ 和赔率…",
    "assumptions": [
      "对手范围：按 BB 位置的基线范围估算",
      "权益抽样 6000 次，95% 置信区间约 ±1.3%",
      "单挑模型（无 ICM、无抽水、无 ante 差异）。"
    ]
  },
  "warnings": []
}
```

`edge` 只在同时有 `equity` 和 `potOdds` 时出现（即面对下注的节点）。
过牌/下注节点没有赔率要求，所以这里是 `null`。

字段分三层，用途不同：

- `decision` —— 给程序读。动作、尺度、频率、置信度。
- `teaching` —— 给人读。一句话结论、可读数字、练习提示、隐含假设。
- `input` —— 回显归一化后的输入，方便日志对账。

### 批量

```json
{
  "hands": [ {...}, {...} ],
  "seed": "session-42",
  "opts": { "iterations": 4000 },
  "teaching": true
}
```

```json
{
  "ok": true, "count": 2, "okCount": 2, "failCount": 0, "elapsedMs": 31,
  "results": [ { "index": 0, "ok": true, "decision": {...}, "teaching": {...} } ]
}
```

单条失败不会拖垮整批：坏数据那一条是 `{ index, ok:false, error }`，其余照常返回。
每条会用 `seed#0`、`seed#1` 派生独立种子——整体可复现，条与条之间不相关。

### 命令行参数

```
--port, -p <n>        端口，默认 8787
--host <addr>         监听地址，默认 127.0.0.1
--token <str>         要求 Authorization: Bearer <str>
--allow-origin <o>    CORS 来源，默认 *
--max-body <bytes>    请求体上限，默认 1 MiB
--no-static           只提供 API，不托管站点
--quiet, -q           关闭访问日志
```

默认只绑 `127.0.0.1`。要跨机器访问就加 `--token`，否则启动时会打警告。

---

## 2. stdio

一次一行，进出都是 JSON。任何能读写管道的语言都能接。

```bash
# 单次
node server/gto-cli.js --once '{"hero":{"pos":"BTN","cards":["As","Kc"]},"street":"preflop"}'

# 流式：一行一条，空行和 # 开头的行被忽略
echo '{"hero":{"cards":["As","Kc"]},"street":"preflop"}' | node server/gto-cli.js

# 终端里看人话
node server/gto-cli.js --once '{"hero":{"cards":["As","Kc"]}}' --text
```

协议细节：

- **输入**：每行一个 JSON 对象。坏行只影响那一行，不会中断整个流。
- **输出**：每行一个 JSON 结果，形状与 HTTP 响应体一致。
- **种子**：默认固定为 `1`，所以同样输入永远同样输出。要变化就显式传 `seed`。
- **退出码**：`0` 正常；`1` 有条目失败；`2` 参数错误。
- `--strict` 让流模式在任一条失败时返回 `1`，适合 CI。

Python 子进程接法：

```python
import subprocess, json

proc = subprocess.Popen(
    ["node", "server/gto-cli.js"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1
)

proc.stdin.write(json.dumps(state) + "\n")
proc.stdin.flush()
result = json.loads(proc.stdout.readline())
```

---

## 3. 进程内

```js
const GTO = require('./engine/gto-engine.js');
const advice = GTO.advise(state);
```

这一层没有校验，也不返回 `teaching`。**如果你从外部拿数据（日志、爬来的牌谱、
玩家上报的局面），别直接走这一层**——位置写错它不会报警，只会给你一个看起来
正常但结论错误的答案。那种错误在复盘里极难发现。

带校验和教学层的进程内版本：

```js
const { createLocal } = require('./client/gto-client.js');
const local = createLocal({ seed: 7 });
const r = await local.ask(state);        // 形状与 HTTP 响应一致
console.log(r.teaching.headline);
```

浏览器里同理，只要按顺序引入三个脚本：

```html
<script src="engine/gto-engine.js"></script>
<script src="server/validate.js"></script>
<script src="server/enrich.js"></script>
<script src="client/gto-client.js"></script>
```

---

## 4. 请求字段

只有 `hero.cards` 是必填的。其余都有默认值，但**默认值是给探索用的，不是给生产用的**——
生产环境该传的都要传，否则引擎会按缺省假设去算，结论不可信。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `hero.cards` | string[2] | **必填** | 两张手牌。也接受 `"AsKc"` 紧凑写法 |
| `hero.pos` | enum | `BTN` | `UTG` `MP` `CO` `BTN` `SB` `BB`，写错直接报错 |
| `hero.stack` | number | `100` | 剩余后手（bb） |
| `hero.invested` | number | `0` | 本手已投入（bb） |
| `street` | enum | 由 board 推导 | `preflop` `flop` `turn` `river` |
| `board` | string[] | `[]` | 0 / 3 / 4 / 5 张，必须与 street 匹配 |
| `pot` | number | `0` | **当前底池总额，含对手本次下注** |
| `toCall` | number | `0` | 你需要跟注的额度；无人下注时传 `0` |
| `effectiveStack` | number | `hero.stack` | 有效筹码 |
| `villainPos` | enum | `null` | 对手位置，影响范围估算 |
| `villainOpenPos` | enum | `null` | 对手开池位置 |
| `raiseCount` | number | `toCall>0?1:0` | 本街加注次数，2 表示面对 3bet |
| `numPlayers` | number | `2` | 入池人数，>2 会降级并告警 |
| `villainRange` | string | `null` | 如 `"AA,KK,AKs,ATs+"`，不传则按位置估算 |
| `villainRaisedPostflop` | bool | `false` | 对手翻后是否加注过 |
| `iterations` | number | `6000` | 权益抽样次数，200 ~ 50000 |
| `betFraction` | number | 推导 | 对手下注占池比例，一般不用传 |
| `seed` | number\|string | 服务端生成 | 固定后同输入同输出 |

任何不在表里的字段都会被原样收进响应的 `echo`，不当错误。可以塞 `handId`、
`playerId`、`tableId`，方便日志对账。

---

## 5. 五个最容易接错的点

这五个都不是「传错会报错」，而是「传错还能返回 200，但结论是错的」。
所以单独列出来。

### ① `pot` 含对手的下注

跟注所需权益是 `toCall / (pot + toCall)`。

底池 10，对手下注 5：
- ✅ `pot: 15, toCall: 5` → 需要 25%
- ❌ `pot: 10, toCall: 5` → 算成 33%，你会过度弃牌

### ② 无人入池时 `toCall` 传 `0`

`toCall > 0` 会被理解成「我在面对加注」，引擎会走 3bet / 跟注 / 弃牌分支。

BTN 前面全弃牌想开池：
- ✅ `toCall: 0` → 开池分支，给出 2.3bb 加注
- ❌ `toCall: 1` → 被当成面对最小加注，给出 3bet 9bb

引擎无法区分「补大盲」和「面对 1bb 加注」，这是数据本身的歧义。
所以传 `toCall:1 / pot:1.5` 时接口会返回 `W_PREFLOP_TO_CALL_TRAP` 警告。

### ③ `street` 必须与 `board` 张数一致

`turn` 配 3 张公共牌会直接报 `E_STREET_MISMATCH`。
不传 `street` 时按张数自动推导，这是最省事也最不容易错的做法。

### ④ 位置必须严格

`hero.pos` 写 `"BUTTON"`、`"btn"`（小写没问题，会自动转大写）、`"button"`
里只有前两种能过。非枚举值直接 `E_BAD_POSITION`。
这条故意不做容错——引擎用 `POS_ORDER.indexOf()` 取索引，非法位置会得到 `-1`，
位置优势判断会整个反过来。

### ⑤ `iterations` 直接决定耗时

实测（Node 22，单进程内连续调用同一手牌，JIT 已预热）：

| iterations | 单次耗时 | 权益误差（95%） | 适合 |
|---|---|---|---|
| 2000 | ~10ms | ±2.2% | 边打字边看 |
| 6000 | ~18ms | ±1.3% | 教学默认值 |
| 20000 | ~30ms | ±0.7% | 复盘对齐 |
| 50000 | ~52ms | ±0.4% | 离线批量测算 |

进程刚启动时第一次调用会慢一些（约 30-40ms，含 JIT 编译）。
批量接口按「条数 × iterations」算预算，超过 40 万次抽样直接拒绝，
所以 100 条 × 6000 次是上限附近，再多请分批。

---

## 6. 接进游戏的正确姿势

游戏内已经有完整的状态机，别从画面读牌。

```js
// 在你自己处理玩家动作的地方，顺手导出一份 hand state
function onPlayerAction(table, seat, action) {
  applyAction(table, seat, action);

  const view = buildHeroView(table, table.heroSeat);
  if (!view) return;

  gtoClient.ask(view).then(r => {
    if (r.ok) overlay.show(r.teaching.headline, r.decision.actionCN);
    else console.warn('[gto]', r.error.code, r.error.message);
  });
}

function buildHeroView(table, seat) {
  const me = table.seats[seat];
  if (!me || me.cards.length !== 2) return null;
  return {
    handId: table.handId,              // 自定义字段，会回显到 echo
    street: table.street,
    hero: { pos: me.pos, cards: me.cards.map(c => c.code), stack: me.stack, invested: me.invested },
    board: table.board.map(c => c.code),
    pot: table.pot,
    toCall: table.toCall,
    numPlayers: table.activePlayers.length,
    villainPos: table.lastAggressorPos || undefined,
    raiseCount: table.raisesThisStreet
  };
}
```

三条工程建议：

1. **一个节点一次请求**，不要每帧调。动作发生时导出一次就够。
2. **请求失败要显式降级**（隐藏建议），不要用上一次的结论顶上——那会给出错误教学。
3. **记下 `seed` 和 `requestId`**。复盘时能精确复现同一组数字，这比什么都重要。

---

## 7. 错误码

所有错误都返回 `{ ok:false, error:{ code, message, hint, field }, errors:[...] }`。
`errors` 是全部问题的数组（校验层会一次报完，不会遇到第一个就停）。

| code | HTTP | 含义 | 怎么修 |
|---|---|---|---|
| `E_BODY_EMPTY` | 400 | 请求体为空 | 传 JSON 对象 |
| `E_JSON` | 400 | JSON 解析失败 | 检查引号与尾随逗号 |
| `E_NOT_OBJECT` | 400 | 顶层不是对象 | 不要传数组 |
| `E_MISSING_FIELD` | 422 | 缺 `hero.cards` | 这是唯一必填项 |
| `E_CARD_COUNT` | 422 | 手牌不是 2 张 | — |
| `E_BAD_CARD` | 422 | 无法解析的牌 | 点数 `2-9TJQKA` + 花色 `shdc` |
| `E_BAD_CARD_FORMAT` | 422 | 紧凑写法字符数为奇数 | `"AsKh7d"` |
| `E_DUP_CARD` | 422 | 同一张牌出现两次 | — |
| `E_CARD_CONFLICT` | 422 | 公共牌与手牌重复 | 检查数据源拼接 |
| `E_BOARD_SIZE` | 422 | 公共牌张数非法 | 只能 0/3/4/5 |
| `E_BAD_STREET` | 422 | 未知街道 | — |
| `E_STREET_MISMATCH` | 422 | street 与 board 张数不符 | 改正或省略 street |
| `E_BAD_POSITION` | 422 | 未知位置 | 6 个枚举值之一 |
| `E_OUT_OF_RANGE` | 422 | 数值越界 | 见 `meta.limits` |
| `E_BAD_RANGE` | 422 | 范围表达式解析不出东西 | 检查拼写 |
| `E_RANGE_BLOCKED` | 422 | 范围与已知牌完全冲突 | 如三条面上传 `22` |
| `E_BATCH_SHAPE` | 422 | `hands` 不是数组或为空 | — |
| `E_BATCH_TOO_LARGE` | 413 | 超过 100 条 | 分批 |
| `E_BATCH_BUDGET` | 422 | 总抽样量超预算 | 降 `iterations` 或分批 |
| `E_TOO_LARGE` | 413 | 请求体超 1 MiB | 一手一条 |
| `E_UNAUTHORIZED` | 401 | 令牌错误 | `Authorization: Bearer <token>` |
| `E_METHOD` | 405 | 方法不对 | `/v1/advise` 只能 POST |
| `E_NOT_FOUND` | 404 | 路径不存在 | 见 `/v1/meta` |
| `E_FORBIDDEN` | 403 | 路径越界或禁止访问 | — |
| `E_ENGINE` | 500 | 引擎内部异常 | 带 state 提 issue |
| `E_NETWORK` | — | 仅 SDK：连不上 | 检查服务是否启动 |

### 警告（不阻断）

| code | 含义 |
|---|---|
| `W_PREFLOP_TO_CALL_TRAP` | 翻前 `toCall:1 / pot:1.5`，可能是补大盲被当成面对加注 |
| `W_TOCALL_GT_POT` | `toCall > pot`，`pot` 口径可能传错 |
| `W_MULTIWAY` | 多人池，权益被高估 |
| `W_LOW_ITERATIONS` | 抽样次数过低 |
| `W_INVESTED_GT_STACK` | 已投入大于后手，SPR 会算成负值 |

---

## 8. 边界

这套接口输出的是**规则拟合的基线**，不是 solver 的解。

- 不做树搜索，不求解纳什均衡
- 多人池按单挑 + 死钱处理，第 3 名之后不建模
- 无 ICM、无抽水、无 ante 差异
- 每个决策至少 2 条 `reasons`，说明它为什么这么建议

当学员问「为什么这里不是全下」时，`reasons` 是能拿来讲课的部分；
而「solver 说这里 32% 的频率」这种精度，这个引擎给不了，也不假装给。
