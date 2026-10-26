# GTO Trainer

一套面向德州扑克学习者的 GTO 教学材料 + 可离线运行的分析工具 + 可嵌入的决策引擎。

纯前端、零依赖、不联网、不读取任何游戏进程。打开浏览器就能用。

**在线访问：<https://gwtcht4gp7-tech.github.io/gto-trainer/>**

```
知识库（为什么）  →  工具台（怎么算）  →  引擎（怎么自动判断）
   index.html          lab.html          engine/gto-engine.js
```

---

## 三个入口

| 文件 | 是什么 | 适合谁 |
|---|---|---|
| **[index.html](index.html)** | 13 章 GTO 知识库，从 EV 到转河极化，含可交互的 13×13 范围矩阵 | 想系统理解「为什么这么打」 |
| **[lab.html](lab.html)** | 分析台：范围权益计算、底池数学、牌面诊断、翻前训练 | 想在具体局面里算一遍 |
| **[demo/engine-demo.html](demo/engine-demo.html)** | 引擎调试台：填状态 → 看决策 + 推理链 | 想接入引擎，或想验证某个节点 |

在线版（手机也能开）：

- 知识库 <https://gwtcht4gp7-tech.github.io/gto-trainer/>
- 分析台 <https://gwtcht4gp7-tech.github.io/gto-trainer/lab.html>
- 调试台 <https://gwtcht4gp7-tech.github.io/gto-trainer/demo/engine-demo.html>

离线也完全能用：克隆后直接双击 `index.html`，不需要装任何东西、不需要起服务器。

---

## 引擎

`engine/gto-engine.js` 是一个零依赖的决策引擎：输入一份 hand state（JSON），输出一个带完整推理链的建议。

```js
const GTOEngine = require('./engine/gto-engine.js');

const advice = GTOEngine.advise({
  street: 'flop',
  hero: { pos: 'BTN', cards: ['Ac', 'Kc'], stack: 97, invested: 3 },
  board: ['As', '7d', '2c'],
  pot: 6,
  toCall: 0,
  villainPos: 'BB'
});

// {
//   action: 'bet',
//   actionCN: '下注',
//   sizing: { fraction: 0.33, absolute: 1.98, unit: 'pot' },
//   frequency: 0.85,
//   confidence: 'high',
//   reasons: [
//     '牌面 A 高 · 干燥（彩虹）。',
//     '你的范围优势评分 0.50，坚果优势评分 0.35（正数偏向翻前加注者）。',
//     '你当前成牌：顶对。',
//     ...
//   ],
//   metrics: { equity: 0.88, betFreq: 0.725, spr: 15.7 },
//   board: { texture: 'dry', rangeAdv: 0.5, nutAdv: 0.35, ... }
// }
```

浏览器里直接 `<script src="engine/gto-engine.js"></script>`，然后 `GTOEngine.advise(...)`。UMD 包装，两种环境都能跑。

完整协议见 **[docs/hand-state.md](docs/hand-state.md)**。

### 它是什么，不是什么

**是**：把 GTO 基线规则编码成代码的启发式引擎。数学部分（牌型评估、权益、底池赔率、MDF）是精确的——牌型评估器已经和暴力枚举做过 30 万局差分测试，零分歧。策略部分是 solver 输出的近似拟合。

**不是**：solver。不做树搜索，不求解纳什均衡，不更新对手模型。

它给出的是「方向正确、量级正确」的建议，附带完整的推理链。对新手来说，**知道为什么**比知道答案更重要——这也是它每条建议至少给 2 条理由的原因。

### 内置能力

```js
GTOEngine.eval7(cards)              // 5/6/7 张牌 → 牌力分值
GTOEngine.simulate(A, B, board, n)  // 范围 vs 范围权益（蒙特卡洛）
GTOEngine.equityVsRange(hero, vill, board, n)  // 底牌 vs 范围
GTOEngine.classifyBoard(cards)      // 牌面纹理 + 范围/坚果优势
GTOEngine.potOdds(pot, toCall)      // 跟注所需权益
GTOEngine.mdf(betFraction)          // 最低防守频率
GTOEngine.alpha(betFraction)        // 对手自动盈利门槛
GTOEngine.geometricSize(spr, n)     // 几何增长下注
GTOEngine.expandRange('22+,A2s+')   // 范围字符串 → 手牌集合
GTOEngine.advise(state)             // 主入口
GTOEngine.replay(states)            // 批量复盘
```

---

## 自测

```bash
node tools/test-engine.js          # 完整，约 14 秒
node tools/test-engine.js --fast   # 抽样，约 6 秒
```

覆盖五组：

1. **基础** —— 牌解析、范围展开（`22+`/`A2s+`/`ATo+`/`AK`）、组合数
2. **牌型评估** —— 与独立的暴力枚举实现做 30 万局差分，要求零分歧
3. **权益** —— 与完整枚举（C(48,5) = 1,712,304 局）对照，并用两套独立实现交叉验证
4. **牌面分类** —— 纹理、顺子潜力、优势归属
5. **全量扫描** —— 翻前 6 位置 × 169 手牌 × 6 场景（6084 例），翻后 3 条街 × 3 种面对下注（5184 例），检查动作合法、频率在 [0,1]、下注类动作必带尺度、弃牌必不带尺度、每条建议至少 2 条理由

---

## 目录

```
.
├── index.html            知识库（13 章）
├── lab.html              分析台（权益/底池/牌面/训练）
├── engine/
│   └── gto-engine.js     决策引擎（零依赖，UMD）
├── demo/
│   └── engine-demo.html  引擎调试台（可视化）
├── docs/
│   └── hand-state.md     hand state 协议
├── tools/
│   └── test-engine.js    自测套件
├── LICENSE
└── README.md
```

---

## 基线条件

所有范围表和频率标注都基于同一组前置条件：

- 6-max 现金局
- 100bb 有效筹码
- 无 ante
- 未计抽水
- Chip EV（无 ICM）

换桌子、换筹码深度、换人数，这些数字都需要重新校准。**文档的目的是建立直觉，不是提供可以直接背下来的表**——这是它反复强调「基线」两个字的原因。

---

## 已知边界

1. **不做树搜索。** 每个决策独立评估，不向前推演对手的再行动。
2. **多人池按单挑处理。** 多人池在结构上不同（更收缩、更少诈唬），需要单独实现。
3. **对手范围是启发式估计。** 按位置查表 + 按压力收窄，不是贝叶斯更新。
4. **没有 ICM、没有抽水。**
5. **翻前范围只覆盖 6-max 100bb 现金局。**

这些限制不影响它作为教学工具：新手最常犯的错误——拿错范围、把牌面看反、尺度乱选、河牌用中等牌下注——都覆盖到了。

---

## 关于「实时对局辅助」

这个项目**不提供、也不会提供**读取游戏客户端、识别屏幕、或挂钩内存来实时提示的插件。

理由不是道德说教，是工程判断：

- 读屏方案要处理 OCR 误差、分辨率适配、动画延迟、版本更新——脆弱且难调试。
- 如果你手上有游戏状态，正确做法是从状态层直接导出 hand state，让引擎订阅它。不需要识别屏幕，因为你本来就知道答案。
- 拿不到状态的场景（打别人的平台），那就该用**复盘**而不是实时提示：把打完的手牌导入 `replay()`，同样能定位问题节点，而且不违反任何服务条款。

`demo/engine-demo.html` 和 `docs/hand-state.md` 就是为第一种情况准备的：协议是公开的，接入口径由你决定。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
