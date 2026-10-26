# 交接文档 · HANDOFF

> 给接手的 agent：读完这一份就能开工，不需要通读 9,600 行代码。
> 本文所有数字、路径、API 签名均已实测核对（2026-10-26）。
> 如果你的改动让本文任何一句失效，**请顺手更新本文**。

---

## 1. 一句话定位

把 GTO 基线规则编码成零依赖 JS 引擎，外面套三层接口（HTTP / stdio / SDK），
供内部学习版扑克游戏在**决策发生时**查询"这一步基线怎么打"，并给出可解释的教学语言。

**不是 solver**。不做树搜索、不求解纳什均衡、不建对手模型。
数学部分（牌型、权益、赔率、MDF）精确；策略部分是 solver 输出的近似拟合。

---

## 2. 30 秒跑起来

```bash
cd gto

node tools/test-engine.js --fast   # 引擎自测，约 6s，先确认环境没问题
node tools/test-api.js             # 接口自测，约 4s，会自己起临时端口
node tools/test-page.js            # 页面烟测，约 1s

node server/gto-server.js          # 起服务，默认 http://127.0.0.1:8787
```

浏览器打开 `http://127.0.0.1:8787/demo/api-lab.html` 即可交互调试。
**没有 npm install，没有构建步骤，没有 node_modules**——只用 Node 内置模块，Node ≥ 18。

---

## 3. 地图：谁负责什么

```
engine/gto-engine.js   1228 行 · 核心。零依赖 UMD，Node 与浏览器通用。
                                牌型评估 / 权益模拟 / 底池数学 / 牌面分类 / 决策
        ↓ 被包在下面这层里，引擎本身不感知 HTTP
server/validate.js      499 行 · 入参契约。把"静默算错"变成明确错误码。
server/enrich.js        167 行 · 决策对象 → 教学语言（headline / 指标解释 / 假设）
server/prng.js           60 行 · 固定种子，同输入必同输出
server/examples.js      143 行 · 11 个样例，UMD，服务端与浏览器共用同一份
server/gto-server.js    710 行 · HTTP 层（唯一有网络 IO 的文件）
server/gto-cli.js       314 行 · stdio NDJSON 层
client/gto-client.js    363 行 · SDK，HTTP 与本地双模式，返回形状完全一致
```

页面层（纯静态，无框架）：

```
index.html             1151 行 · 13 章知识库 + 13×13 可交互范围矩阵
lab.html                894 行 · 离线分析台（手算权益 / 底池数学 / 牌面诊断）
demo/engine-demo.html   586 行 · 引擎调试台，直连 GTOEngine
demo/api-lab.html      1194 行 · 接口调试台，连服务 or 浏览器内直算
```

**关键分层原则**：引擎不认识 HTTP，服务端不认识牌。加功能先想清楚放哪一层。
`validate.js` 和 `enrich.js` 也做成了 UMD，所以调试台在没起服务时能用**同一套逻辑**离线演示——
这是刻意的，不要在页面里另写一份。

---

## 4. 三个接入面

### 4.1 进程内（游戏主逻辑推荐用这个）

```js
const { createLocal } = require('./client/gto-client.js');
const r = await createLocal({ seed: 7 }).ask(state);
// 零网络开销，同步逻辑包在 Promise 里，形状与其他两种一致
```

### 4.2 HTTP

```bash
node server/gto-server.js --port 8787
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 存活 + 版本 |
| GET | `/v1/meta` | **字段表、枚举、限制、错误码**。可用来生成表单或做客户端校验 |
| GET | `/v1/examples` | 11 个样例，含一个故意报错的反例 |
| POST | `/v1/advise` | 单次 |
| POST | `/v1/advise/batch` | 批量，≤100 条，单条失败不拖垮整批 |
| POST | `/v1/replay` | **只是 batch 的别名**，名字容易误导，见 §9 |

启动参数：`--port/-p`（默认 8787）、`--host`（默认 `127.0.0.1`）、`--token`、`--no-static`。
**默认只绑 127.0.0.1，这是本机工具不是公网服务**——要对外必须先加 `--token`，别直接改默认值。

### 4.3 stdio

```bash
node server/gto-cli.js --once '{"hero":{"cards":["As","Kc"]}}'
node server/gto-cli.js --file hands.json --pretty   # hands.json 自备，字段见 §5
cat hands.ndjson | node server/gto-cli.js            # 一行进一行出，坏行不中断流
```

想立刻拿到可用的样例数据：`node -e 'console.log(JSON.stringify(require("./server/examples.js").EXAMPLES.map(e=>e.state)))' > hands.json`

> 11 条样例里最后一条 `error-street-mismatch` 是**故意设计的反例**，
> 会返回 `E_STREET_MISMATCH`。所以批量跑出来 `failCount: 1` 是正确行为，不是 bug。

`--text` 输出人类可读卡片；`--no-teaching` 去掉 teaching 字段；`--strict` 任一失败退出码 1。

### 4.4 三种口径必须等价

同一份 state + 同一 seed，三条路径给出的数字必须完全一致。
这条**写成了断言**（`tools/test-api.js` 里"本地直算与服务端同 seed 给出同一数字"），不是靠自觉。

---

## 5. 数据契约

### 请求

```js
{
  street:        'preflop' | 'flop' | 'turn' | 'river',  // 不传则按 board 张数推导
  hero: {
    pos:         'UTG'|'MP'|'CO'|'BTN'|'SB'|'BB',
    cards:       ['As','Kc'],        // 也接受紧凑写法 'AsKc'
    stack:       97.7,               // 默认 100
    invested:    2.3                 // 已投入，默认 0
  },
  board:         ['As','7d','2c'],   // 0/3/4/5 张
  pot:           5.1,                // 含对手本次下注
  toCall:        0,
  numPlayers:    2,                  // 2..10
  villainPos:    'BB',
  villainOpenPos:'BTN',              // 关键：与 villainPos 分开，见 §7 bug 7
  villainRange:  'QQ+,AKs',          // 可选，覆盖默认估计
  iterations:    6000,               // 200..50000
  seed:          2841773912          // 固定后完全可复现
}
```

其余字段见 `GET /v1/meta` 或 `server/validate.js` 的 `FIELDS`。
限制常量在 `validate.js` 的 `LIMITS`（`iterations` 200–50000，`numPlayers` 2–10 等）。

### 响应（三层，用途不同）

```js
{
  ok: true, apiVersion: '1.0', engineVersion: '1.0.0', seed, elapsedMs,
  input:    { /* 归一化后的输入回显，方便日志对账 */ },
  decision: { /* 给程序读 */ action, actionCN, sizing, frequency, confidence,
                mixed, metrics{equity,betFreq,spr}, board{texture,rangeAdv,...}, reasons[] },
  teaching: { /* 给人读 */ headline, frequencyPct, metrics[], edge, assumptions[], practiceTip },
  warnings: []
}
```

**不变量**（改动时必须守住，测试里有覆盖）：

- 每个决策**至少 2 条** `reasons`
- `frequency ∈ [0,1]`
- 下注类动作必带 `sizing`；弃牌/过牌不带
- `sizing.unit ∈ {'pot','bb'}` —— **绝不能混用**，见 §7 bug 6
- 失败时 `ok:false` + `error{code,message,hint,field}`，**不抛异常**

### 错误码（29 个）与警告码（5 个）

```
E_JSON E_BODY_EMPTY E_BODY_READ E_NOT_OBJECT E_TOO_LARGE E_METHOD E_NOT_FOUND
E_UNAUTHORIZED E_FORBIDDEN E_INTERNAL E_ENGINE E_BAD_PATH
E_BAD_STREET E_STREET_MISMATCH E_BAD_POSITION E_BAD_CARD E_BAD_CARD_FORMAT
E_CARD_COUNT E_CARD_CONFLICT E_DUP_CARD E_BOARD_SIZE E_BAD_RANGE E_RANGE_BLOCKED
E_FIELD_TYPE E_MISSING_FIELD E_OUT_OF_RANGE E_BATCH_SHAPE E_BATCH_TOO_LARGE E_BATCH_BUDGET

W_PREFLOP_TO_CALL_TRAP  W_LOW_ITERATIONS  W_MULTIWAY  W_TOCALL_GT_POT  W_INVESTED_GT_STACK
```

警告是"能算但不一定是你想要的"，不阻断。`W_PREFLOP_TO_CALL_TRAP` 是最常踩的一个，见 §6。

---

## 6. 接入时最容易错的两个点

**① `toCall: 1` 在翻前有歧义。**
它既可能是"补大盲"，也可能是"面对最小加注"，引擎按后者处理。
无人入池时要传 `toCall: 0`。踩到会收到 `W_PREFLOP_TO_CALL_TRAP` 警告。

**② 引擎不做牌面冲突检查。**
绕过 `validate.js` 直接调 `GTOEngine.advise`，若手牌与牌面有重复牌，
引擎会把它当成"三张 A"去算，不报错。**所有外部输入必须先过 validate 层。**
（这个坑在写测试时真踩过：`cardsOf('AKs')` 生成 `As Ks`，而牌面已有 `As`。）

---

## 7. 已修的历史 bug —— 全部是静默算错，改代码前先读

这 7 个都不报错、不崩溃、结果看着正常。**任何相关改动都要先确认没有重新引入。**

### ① 顺子 A-low 伪造

把 A 复制到 bit0 表示"可当 1"，导致 `K-A-3-5-4` 被判成 `A-2-3-4-5` 顺子。
改用独立 bit13 许可位：

```js
function straightHigh(mask) {
  for (let hi = 12; hi >= 4; hi--) {
    const need = 0x1F << (hi - 4);
    if ((mask & need) === need) return hi;
  }
  if ((mask & (1 << 13)) && (mask & 0x0F) === 0x0F) return 3; // 轮子需 bit13 许可
  return -1;
}
```

### ② `simulate` 冲突检查顺序 —— 对子受害最大

冲突检查写在标记之前，英雄与对手可能拿到同一张牌，`eval7` 收到重复牌。
**必须先标记 a 再检查 b**：

```js
if (used[a1] || used[a2] || a1 === a2) continue;
used[a1] = used[a2] = 1;
if (used[b1] || used[b2] || b1 === b2) continue;   // ← 顺序错了这里会漏
used[b1] = used[b2] = 1;
```

症状：`22 vs 随机` 从 50.31% 虚高到 52.28%。

### ③ `eval7` 硬编码 7 张

翻牌圈只传 5 张时读到 `undefined` 当 rank0。改为按 `cs.length` 循环并校验 5–7。

### ④ 枚举抽样系统偏差

`for(i=0;i<48;i+=8)` 让 `AKs vs QQ` 偏 6 个百分点。改随机 Fisher-Yates。
注意 `idx` 数组必须是 48 个元素（曾错写成 5 个）。

### ⑤ 手数排名 vs 组合数混用

范围表按**组合数**定义（AA=6、AKo=12），用手数排名判边界使 UTG 的 A2o 被误判可开。
改用 `comboPercentile()` 累计组合数百分位。

### ⑥ 尺度语义混用

开池 2.3bb 按池比例输出，显示成"153% 池"。加 `sizing.unit: 'pot'|'bb'` 区分。

### ⑦ 【最近一个】大盲范围为空 → 权益恒为 0

`PREFLOP.BB.open === ''` —— 大盲没有开池范围。展开成空集后
`villainCombos.length === 0`，**权益直接归零，而决策照常返回 200**。
影响所有 `villainPos: 'BB'` 的翻后节点：AKs 在 A72 面权益 0%，耗时只有 0.4ms。

修法：补 `BB_DEFEND` 防守范围，按开池方位置分宽窄；范围仍为空时在 `reasons` 里明确告警。
修复后 AKs 89.5%、98s 听牌 40.3%（需 30.5%，跟注成立）。

**为什么一直没发现**：原有翻后测试用例都额外传了 `villainOpenPos`，正好绕开这个分支。
已补 4 项回归（含"面对后位开池时防守范围更宽"的对比断言）。

> 通用教训：**测试数据的构造方式会悄悄决定测试覆盖什么。**
> 想验证 A 分支，先确认测试没有在无意中把参数凑成了 B 分支。

---

## 8. 验证方法论 —— 不要只跟记忆里的数字比

**双实现交叉验证 + 完整枚举作 ground truth。**

- 牌型评估器与独立暴力评估器做 30 万局差分，覆盖 5/6/7 张，要求零分歧。
- 完整枚举 `C(48,5) = 1,712,304` 局作基准：AA 85.18%、22 50.31%、QQ 79.91%、72o 34.62%。
- 修复前 `AKs vs QQ = 47.46%`，修复后 `46.21%`，公认值约 46.0% —— **只有修完的那个才对**。
  光看"接近印象中的数字"无法判断对错。

当前测试规模（实测）：

| 文件 | 条数 | 耗时 | 覆盖 |
|---|---|---|---|
| `tools/test-engine.js` | 98 | 7.5s | 牌型、权益、策略、全量扫描（翻前 6084 例 + 翻后 5184 例） |
| `tools/test-api.js` | 184 | ~4s | 错误码逐个、seed 复现、并发隔离、CORS、鉴权、批量预算、CLI 协议 |
| `tools/test-page.js` | 20 | ~1s | vm + 最小 DOM 桩跑通页面脚本 |

`test-page.js` **不引 jsdom**，桩只实现页面实际用到的 API。
页面一旦用了新接口就会在这里报错，而不是等用户浏览器里才炸。加 DOM 用法时记得同步扩桩。

提交前跑全三套：

```bash
node tools/test-engine.js && node tools/test-api.js && node tools/test-page.js
```

---

## 9. 已知边界（不要误以为是 bug）

1. **不做树搜索**。每个决策独立评估，不推演对手再行动。
2. **多人池按单挑处理**，会发 `W_MULTIWAY`。`numPlayers` 目前只影响告警不影响算法。
3. **对手范围是启发式**：按位置查表 + 按压力收窄，不是贝叶斯更新。
4. **无 ICM**，不考虑锦标赛奖金结构。
5. **`/v1/replay` 只是 batch 别名**，不是复盘分析器。真正的复盘（逐节点对比基线、
   按 EV 损失排序）**尚未实现**——见 §10。
6. 翻前范围表的数字是 6-max 100bb 的基线，换桌/换深度需重新校准。

---

## 10. 下一步候选任务

按价值排序，第一个是原计划的正解：

### A. 手牌复盘模块（推荐先做）

接口和 seed 机制已经铺好了。要做的是：导入一串 hand state → 逐节点跟基线比
→ 按 EV 损失排序 → 标出最该学的那几个节点。

复用点：`/v1/advise/batch`、`seed` 可复现、`teaching.assumptions`。
注意 `replay()` 现在只是 `states.map(advise)`，需要新增"逐节点差分 + EV 排序"逻辑。

### B. 范围可视化

`expandRange` / `toCombos` / `rangePct` 都有了，13×13 矩阵在 `index.html` 里，
但没有"给定动作反查频率分布"的视图。

### C. 多人池真实支持

目前 `numPlayers > 2` 只加告警。真做需要改 `estimateVillainRange` 与权益模拟。

### D. 浏览器侧零配置

线上打开 `api-lab.html` 会显示"离线"——那是浏览器拦了 https→`http://127.0.0.1`
的混合内容请求，页面会自动切到浏览器内引擎算。这是预期行为，不是坏了。
若要让线上也能连服务，需要 https 端点。

---

## 11. 代码约定

- **零依赖**。只用 Node 内置模块。加任何第三方包前先问自己能不能不引。
- **UMD**：`engine/`、`server/validate.js`、`server/enrich.js`、`server/examples.js`
  必须同时能在 Node 与浏览器加载。改这些文件后跑一遍 `test-page.js` 验证。
- **中文注释、中文错误信息**。注释解释"为什么"，不复述"做了什么"。
- **不抛异常**，一律返回 `{ok:false, error:{...}}`。SDK 层也不抛。
- **改行为就改测试**，特别是 §7 那 7 个坑的回归断言。
- 时间戳/随机数必须走 `prng.js`，**不要在引擎里直接 `Math.random()`**——
  否则 seed 复现和回归测试全部失效。
- 改引擎行为后**同步升版本号**：`engine/gto-engine.js` 第 1226 行 `version: '1.0.0'`，
  它会被各层透传成响应里的 `engineVersion`，是排查"线上跑的是哪版"的唯一依据。
  API 契约变更则改 `server/validate.js` 的 `API_VERSION`。

---

## 12. 环境与仓库

| | |
|---|---|
| 本地路径 | `C:\Users\23158\WorkBuddy\2026-10-26-16-59-04\gto` |
| 仓库 | https://github.com/gwtcht4gp7-tech/gto-trainer （public, MIT） |
| 分支 | `main`（工作区干净，最新 `6568b4c`） |
| Pages | https://gwtcht4gp7-tech.github.io/gto-trainer/ |
| 运行时 | Node ≥ 18，无 npm 依赖 |

Pages 更新后构建约需 30–60 秒，可用下面命令确认：

```bash
gh api repos/gwtcht4gp7-tech/gto-trainer/pages/builds/latest --jq '.status'
```

`built` 才是完成。中途显示 `errored` 有时是临时状态，等 20 秒复测再判断。

---

## 13. 产品立场（重要，不是技术问题）

这个项目**不做读屏 / 挂钩内存的实时叠加层**，即使需求方说"只是内部测试版"。

理由不是道德说教，是工程判断：

- 从状态层导出一次 hand state（约 20 行代码），比 OCR 稳、不怕版本更新、
  顺带得到可回放的测试夹具。
- 拿不到状态的场景（别人的平台），正解是**复盘**而不是实时提示。

已经和需求方确认：他是游戏开发者，做内部学习版。
所以正解是**从自己的游戏导出状态**，不是逆向别人的界面。
接手时如果又收到"挂个插件实时读屏"的需求，先回到这条。
