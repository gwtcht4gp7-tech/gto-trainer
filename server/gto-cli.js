#!/usr/bin/env node
/*!
 * gto-cli.js — stdio 接口
 * ---------------------------------------------------------------
 * 有些场景起 HTTP 服务是多余的：
 *   - 游戏客户端本身就是 Node / Python，spawn 一个子进程最省事
 *   - CI 里要跑断言，不想管端口占用
 *   - 只想在终端里快速问一手牌
 *
 * 这个脚本把同一套分析能力暴露成「一行 JSON 进，一行 JSON 出」，
 * 任何能读写管道语言都能接。
 *
 *   $ echo '{"hero":{"pos":"BTN","cards":["As","Kc"]},"street":"preflop"}' \
 *       | node server/gto-cli.js
 *
 *   node server/gto-cli.js --once '{"hero":{"cards":["As","Kc"]}}'
 *   node server/gto-cli.js --file hands.json --pretty
 * ---------------------------------------------------------------
 */
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const engine = require('../engine/gto-engine.js');
const V = require('./validate.js');
const { enrich } = require('./enrich.js');
const { withSeed } = require('./prng.js');

/* ------------------------------------------------------------------ */

function analyse(raw, opts) {
  const v = V.validate(raw);
  if (!v.ok) {
    return {
      ok: false,
      error: { code: v.errors[0].code, message: v.errors[0].message, hint: v.errors[0].hint, field: v.errors[0].field },
      errors: v.errors,
      warnings: v.warnings
    };
  }

  const seed = (raw && raw.seed !== undefined && raw.seed !== null && raw.seed !== '')
    ? raw.seed
    : 1;   // CLI 默认固定种子，保证脚本可重复

  let decision;
  const t0 = process.hrtime.bigint();
  try {
    decision = withSeed(seed, () => engine.advise(v.value));
  } catch (e) {
    return {
      ok: false,
      error: { code: 'E_ENGINE', message: e.message, hint: null, field: null },
      errors: [{ code: 'E_ENGINE', message: e.message }],
      warnings: v.warnings
    };
  }
  const elapsedMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;

  const out = {
    ok: true,
    apiVersion: V.API_VERSION,
    engineVersion: engine.version,
    seed,
    elapsedMs,
    input: {
      street: v.value.street,
      hero: { pos: v.value.hero.pos, cards: v.value.hero.cards.map(engine.cardStr), stack: v.value.hero.stack, invested: v.value.hero.invested },
      board: v.value.boardCards.map(engine.cardStr),
      pot: v.value.pot,
      toCall: v.value.toCall,
      iterations: v.value.iterations,
      handClass: engine.handClass(v.value.hero.cards[0], v.value.hero.cards[1])
    },
    decision: {
      action: decision.action,
      actionCN: decision.actionCN,
      sizing: decision.sizing || null,
      frequency: decision.frequency,
      confidence: decision.confidence,
      mixed: !!decision.mixed,
      metrics: decision.metrics || {},
      board: decision.board || null,
      reasons: decision.reasons || []
    },
    warnings: v.warnings
  };

  if (opts.teaching) out.teaching = enrich(v.value, decision);
  return out;
}

/** 终端里读的版本（--text） */
function renderText(r) {
  if (!r.ok) {
    const lines = ['', '  ✗ ' + r.error.code + '：' + r.error.message];
    if (r.error.field) lines.push('    字段：' + r.error.field);
    if (r.error.hint) lines.push('    提示：' + r.error.hint);
    if (r.errors && r.errors.length > 1) {
      lines.push('', '  共 ' + r.errors.length + ' 个问题：');
      r.errors.forEach(e => lines.push('    · [' + e.code + '] ' + (e.field || '-') + ' ' + e.message));
    }
    lines.push('');
    return lines.join('\n');
  }

  const t = r.teaching;
  const lines = [''];
  lines.push('  ' + t.headline);
  lines.push('  ' + '-'.repeat(Math.min(66, t.headline.length + 8)));
  lines.push('  频率 ' + t.frequencyPct + '  ·  置信度 ' + t.confidence);
  if (t.metrics.length) {
    lines.push('  ' + t.metrics.map(m => m.label + ' ' + m.display).join('  ·  '));
  }
  if (t.edge) lines.push('  权益差 ' + t.edge.display + '  ' + t.edge.note);
  lines.push('');
  lines.push('  为什么：');
  t.reasons.forEach((x, i) => lines.push('   ' + (i + 1) + '. ' + x));
  lines.push('');
  lines.push('  ' + t.frequencyNote);
  lines.push('  ' + t.practiceTip);
  if (r.warnings && r.warnings.length) {
    lines.push('');
    r.warnings.forEach(w => lines.push('  ! [' + w.code + '] ' + w.message));
  }
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    once: null,
    file: null,
    pretty: false,
    text: false,
    teaching: true,
    strict: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--once': case '-e': opts.once = argv[++i]; break;
      case '--file': case '-f': opts.file = argv[++i]; break;
      case '--pretty': opts.pretty = true; break;
      case '--text': case '-t': opts.text = true; opts.pretty = false; break;
      case '--no-teaching': opts.teaching = false; break;
      case '--strict': opts.strict = true; break;      // 任一条失败则退出码 1
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        if (a.startsWith('-')) {
          console.error('未知参数：' + a);
          process.exit(2);
        }
    }
  }
  return opts;
}

function printHelp() {
  console.log([
    'GTO 分析 · stdio 接口',
    '',
    '用法:',
    '  node server/gto-cli.js                      从 stdin 逐行读 JSON，逐行输出',
    '  node server/gto-cli.js --once \'<json>\'      单次',
    '  node server/gto-cli.js --file hands.json    从文件读（数组或 NDJSON 均可）',
    '',
    '选项:',
    '  --once, -e <json>   单条 hand state',
    '  --file, -f <path>   JSON 数组 或 每行一条 JSON',
    '  --pretty            格式化输出（仅单次 / 文件模式）',
    '  --text, -t          人类可读的教学卡片（终端调试用）',
    '  --no-teaching       不输出 teaching 字段，响应更小',
    '  --strict            stdin 流模式下任一条失败则退出码为 1',
    '',
    '管道协议:',
    '  输入：每行一个 JSON 对象，空行与 # 开头的行被忽略',
    '  输出：每行一个 JSON 结果，字段与 HTTP 接口的响应体一致',
    ''
  ].join('\n'));
}

/* ------------------------------------------------------------------ */

function runOnce(raw, opts) {
  const r = analyse(raw, opts);
  if (opts.text) return renderText(r);
  return JSON.stringify(r, null, opts.pretty ? 2 : 0);
}

function runStream(opts) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let failures = 0;
  let paused = false;

  rl.on('line', line => {
    const s = line.trim();
    if (!s || s.charAt(0) === '#') return;

    let raw;
    try {
      raw = JSON.parse(s);
    } catch (e) {
      failures++;
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: 'E_JSON', message: '输入行不是合法 JSON：' + e.message, hint: null, field: null }
      }) + '\n');
      return;
    }

    const r = analyse(raw, opts);
    if (!r.ok) failures++;

    const ok = process.stdout.write((opts.text ? renderText(r) : JSON.stringify(r)) + '\n');
    if (!ok && !paused) {
      paused = true;
      rl.pause();
      process.stdout.once('drain', () => {
        paused = false;
        rl.resume();
      });
    }
  });

  rl.on('close', () => {
    if (opts.strict && failures > 0) process.exitCode = 1;
  });
  process.stdout.on('error', () => process.exit(0));
}

/* ------------------------------------------------------------------ */

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 单条
  if (opts.once !== null) {
    let raw;
    try {
      raw = JSON.parse(opts.once);
    } catch (e) {
      console.error('--once 的参数不是合法 JSON：' + e.message);
      process.exit(2);
    }
    const r = analyse(raw, opts);
    process.stdout.write((opts.text ? renderText(r) : JSON.stringify(r, null, opts.pretty ? 2 : 0)) + '\n');
    if (!r.ok) process.exitCode = 1;
    return;
  }

  // 文件
  if (opts.file) {
    let text;
    try {
      text = fs.readFileSync(opts.file, 'utf8');
    } catch (e) {
      console.error('读不到文件：' + opts.file);
      process.exit(2);
    }

    let items;
    let single = false;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        items = parsed;
      } else if (Array.isArray(parsed.hands)) {
        items = parsed.hands;
      } else {
        items = [parsed];
        single = true;
      }
    } catch (e) {
      // 不是整体 JSON，按 NDJSON 处理
      items = text.split('\n').map(l => l.trim())
        .filter(l => l && l.charAt(0) !== '#')
        .map(l => JSON.parse(l));
    }

    let failures = 0;
    const results = items.map(it => {
      const r = analyse(it, opts);
      if (!r.ok) failures++;
      return r;
    });

    if (opts.text) {
      results.forEach(r => process.stdout.write(renderText(r)));
    } else {
      const payload = single
        ? results[0]
        : { ok: failures === 0, count: results.length, failCount: failures, results };
      process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    }
    if (failures > 0) process.exitCode = 1;
    return;
  }

  // stdin 流
  if (process.stdin.isTTY) {
    printHelp();
    console.error('\n提示：交互式终端请用 --once \'<json>\' 或 --text；管道用法见上。\n');
    process.exit(0);
  }
  runStream(opts);
}

module.exports = { analyse, renderText };

if (require.main === module) main();
