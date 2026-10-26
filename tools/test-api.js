#!/usr/bin/env node
/*!
 * test-api.js — 接口自测
 * ---------------------------------------------------------------
 * 覆盖三块：HTTP 契约、校验错误码、CLI 管道协议。
 * 不依赖任何测试框架，`node tools/test-api.js` 直接跑。
 *
 * 重点不是「能返回 200」，而是：
 *   - 同样的 seed 必须给出同样的数字（否则复盘对不齐）
 *   - 每一个校验分支都必须落到唯一确定的错误码
 *   - 并发请求不能互相污染（引擎是同步的，但 Math.random 替换是全局的）
 * ---------------------------------------------------------------
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createServer } = require('../server/gto-server.js');
const { EXAMPLES } = require('../server/examples.js');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

/* ------------------------------- 断言 ------------------------------- */

let pass = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) {
    pass++;
  } else {
    failures.push({ name, detail: detail === undefined ? '' : String(detail) });
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, name, same ? '' : '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function section(title) {
  console.log('\n  ' + title);
}

/* ------------------------------ 起服务 ------------------------------ */

function start(cfg) {
  return new Promise((resolve, reject) => {
    const server = createServer(Object.assign({ quiet: true }, cfg));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        base: 'http://127.0.0.1:' + port,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

async function req(base, method, pathname, body, headers) {
  const opts = { method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + pathname, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON 就留 null */ }
  return { status: res.status, headers: res.headers, text, json };
}

/* ------------------------------ 用例 ------------------------------ */

async function testBasics(base) {
  section('基础接口');

  const h = await req(base, 'GET', '/v1/health');
  eq(h.status, 200, 'health 返回 200');
  eq(h.json.ok, true, 'health ok=true');
  ok(typeof h.json.apiVersion === 'string', 'health 带 apiVersion');
  ok(Number.isFinite(h.json.uptimeSec), 'health 带 uptimeSec');

  const m = await req(base, 'GET', '/v1/meta');
  eq(m.status, 200, 'meta 返回 200');
  ok(Array.isArray(m.json.fields) && m.json.fields.length > 10, 'meta 返回字段说明表');
  eq(m.json.enums.street, ['preflop', 'flop', 'turn', 'river'], 'meta 街道枚举正确');
  eq(m.json.enums.position, ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'], 'meta 位置枚举正确');
  ok(m.json.semantics && m.json.semantics.pot, 'meta 写明 pot 语义');

  const ex = await req(base, 'GET', '/v1/examples');
  eq(ex.status, 200, 'examples 返回 200');
  ok(ex.json.count === EXAMPLES.length, 'examples 数量一致');
  ok(ex.json.examples[0].state !== undefined, 'examples 每条带 state');
}

async function testAdvise(base) {
  section('单次分析');

  const state = EXAMPLES.find(e => e.id === 'flop-tptk-cbet').state;
  const r = await req(base, 'POST', '/v1/advise', state);

  eq(r.status, 200, 'advise 返回 200');
  eq(r.json.ok, true, 'advise ok=true');
  ok(typeof r.json.seed === 'number' || typeof r.json.seed === 'string', 'advise 回传 seed');
  ok(Number.isFinite(r.json.elapsedMs), 'advise 回传耗时');
  ok(typeof r.json.requestId === 'string', 'advise 回传 requestId');

  // 契约：动作与尺度
  ok(typeof r.json.decision.action === 'string', 'decision.action 存在');
  ok(r.json.decision.frequency >= 0 && r.json.decision.frequency <= 1, 'frequency 在 [0,1]');
  ok(['high', 'medium', 'low'].indexOf(r.json.decision.confidence) >= 0, 'confidence 枚举合法');

  const isAggressive = ['bet', 'raise', '3bet', '4bet', 'allin'].indexOf(r.json.decision.action) >= 0;
  if (isAggressive) {
    ok(r.json.decision.sizing !== null, '下注/加注必须带 sizing');
    ok(['pot', 'bb'].indexOf(r.json.decision.sizing.unit) >= 0, 'sizing.unit 枚举合法');
    ok(r.json.decision.sizing.absolute > 0, 'sizing.absolute 为正');
  } else {
    ok(r.json.decision.sizing === null, '弃牌/过牌/跟注不带 sizing（' + r.json.decision.action + '）');
  }

  ok(Array.isArray(r.json.decision.reasons) && r.json.decision.reasons.length >= 2, '至少 2 条 reasons');

  // 教学层
  const t = r.json.teaching;
  ok(t && typeof t.headline === 'string' && t.headline.length > 0, 'teaching.headline 存在');
  ok(Array.isArray(t.metrics) && t.metrics.length >= 1, 'teaching.metrics 非空');
  ok(t.assumptions.length >= 2, 'teaching.assumptions 说明隐含假设');
  ok(/Q|%/.test(t.frequencyPct), 'teaching.frequencyPct 是百分比');

  // 回显可读牌
  eq(r.json.input.hero.cards, ['Ac', 'Kc'], 'input 回显字符串牌');
  eq(r.json.input.board, ['As', '7d', '2c'], 'input 回显公共牌');
  eq(r.json.input.handClass, 'AKs', 'input 带 handClass');
}

async function testDeterminism(base) {
  section('可复现性');

  const state = Object.assign({}, EXAMPLES.find(e => e.id === 'flop-flushdraw-face-bet').state, { seed: 20261026 });
  const a = await req(base, 'POST', '/v1/advise', state);
  const b = await req(base, 'POST', '/v1/advise', state);
  const c = await req(base, 'POST', '/v1/advise', state);

  eq(a.json.decision.metrics.equity, b.json.decision.metrics.equity, '同 seed 两次权益完全相同');
  eq(b.json.decision.metrics.equity, c.json.decision.metrics.equity, '同 seed 三次权益完全相同');
  eq(a.json.decision.action, c.json.decision.action, '同 seed 动作相同');

  // 服务端生成的 seed 必须可用于复现
  const auto = await req(base, 'POST', '/v1/advise', EXAMPLES.find(e => e.id === 'flop-flushdraw-face-bet').state);
  const replay = await req(base, 'POST', '/v1/advise',
    Object.assign({}, EXAMPLES.find(e => e.id === 'flop-flushdraw-face-bet').state, { seed: auto.json.seed }));
  eq(auto.json.decision.metrics.equity, replay.json.decision.metrics.equity,
    '用返回的 seed 能复现同一结果');

  // 不同 seed 应产生不同抽样（允许极小概率相同，用 4 个 seed 兜底）
  const vals = new Set();
  for (let i = 0; i < 4; i++) {
    const r = await req(base, 'POST', '/v1/advise',
      Object.assign({}, EXAMPLES.find(e => e.id === 'flop-flushdraw-face-bet').state, { seed: 1000 + i }));
    vals.add(r.json.decision.metrics.equity);
  }
  ok(vals.size >= 2, '不同 seed 给出不同权益（说明确实在抽样）');
}

async function testValidation(base) {
  section('校验与错误码');

  const rawCases = [
    { name: '空 body', body: '', code: 'E_BODY_EMPTY', status: 400 },
    { name: '非法 JSON', body: '{hero:1}', code: 'E_JSON', status: 400 },
    { name: 'body 是数组', body: [], code: 'E_NOT_OBJECT', status: 400 },
    { name: '缺手牌', body: { street: 'preflop' }, code: 'E_MISSING_FIELD', status: 422 },
    { name: '手牌只有一张', body: { hero: { cards: ['As'] } }, code: 'E_CARD_COUNT', status: 422 },
    { name: '手牌非法', body: { hero: { cards: ['Xs', 'Kc'] } }, code: 'E_BAD_CARD', status: 422 },
    { name: '手牌重复', body: { hero: { cards: ['As', 'As'] } }, code: 'E_DUP_CARD', status: 422 },
    { name: '牌面 2 张', body: { hero: { cards: ['As', 'Kc'] }, board: ['Ah', '7d'] }, code: 'E_BOARD_SIZE', status: 422 },
    { name: '牌面与手牌冲突', body: { hero: { cards: ['As', 'Kc'] }, board: ['As', '7d', '2c'] }, code: 'E_CARD_CONFLICT', status: 422 },
    { name: '街道拼错', body: { hero: { cards: ['As', 'Kc'] }, street: 'riverr' }, code: 'E_BAD_STREET', status: 422 },
    { name: '街道与牌面不符', body: { hero: { cards: ['Kd', 'Kc'] }, street: 'turn', board: ['As', '7d', '2c'] }, code: 'E_STREET_MISMATCH', status: 422 },
    { name: '未知位置', body: { hero: { pos: 'BUTTON', cards: ['As', 'Kc'] } }, code: 'E_BAD_POSITION', status: 422 },
    { name: 'iterations 越界', body: { hero: { cards: ['As', 'Kc'] }, iterations: 999999 }, code: 'E_OUT_OF_RANGE', status: 422 },
    { name: 'pot 为负', body: { hero: { cards: ['As', 'Kc'] }, pot: -5 }, code: 'E_OUT_OF_RANGE', status: 422 },
    { name: '范围写错', body: { hero: { cards: ['Kd', 'Kc'] }, board: ['Ah', '7d', '2c'], villainRange: 'ZZZZ' }, code: 'E_BAD_RANGE', status: 422 },
    { name: '紧凑牌面写法', body: { hero: { cards: 'AsKc' }, board: 'Ah7d2c' }, code: null, status: 200 },
    { name: '范围与已知牌冲突', body: { hero: { cards: ['Kd', 'Kc'] }, board: ['2s', '2h', '2d'], villainRange: '22' }, code: 'E_RANGE_BLOCKED', status: 422 }
  ];

  for (const c of rawCases) {
    const r = await req(base, 'POST', '/v1/advise', c.body);
    eq(r.status, c.status, c.name + ' → HTTP ' + c.status);
    if (c.code) {
      eq(r.json && r.json.error ? r.json.error.code : null, c.code, c.name + ' → ' + c.code);
      ok(r.json.error.message && r.json.error.message.length > 0, c.name + ' 有可读 message');
      ok(Array.isArray(r.json.errors), c.name + ' 带 errors 数组');
    } else {
      eq(r.json.ok, true, c.name + ' 应成功');
    }
  }

  // 一次报全：多个问题同时出现时不能只报第一个
  const multi = await req(base, 'POST', '/v1/advise', {
    hero: { pos: 'XX', cards: ['As'] }, pot: -1
  });
  eq(multi.status, 422, '多个错误 → 422');
  ok(multi.json.errors.length >= 3, '多个错误一次性返回（实际 ' + (multi.json.errors || []).length + ' 条）');

  // 警告不阻断
  const warn = await req(base, 'POST', '/v1/advise', {
    hero: { pos: 'BB', cards: ['9h', '8h'] },
    street: 'preflop', pot: 1.5, toCall: 1
  });
  eq(warn.status, 200, '警告不阻断请求');
  ok(warn.json.warnings.some(w => w.code === 'W_PREFLOP_TO_CALL_TRAP'),
    '翻前 toCall=1 触发 W_PREFLOP_TO_CALL_TRAP');

  const multiway = await req(base, 'POST', '/v1/advise',
    EXAMPLES.find(e => e.id === 'multiway-pot').state);
  ok(multiway.json.warnings.some(w => w.code === 'W_MULTIWAY'), '三人池触发 W_MULTIWAY');

  // 未识别字段回显
  const echo = await req(base, 'POST', '/v1/advise', {
    hero: { cards: ['As', 'Kc'], playerId: 'p-77' },
    street: 'preflop', handId: 'H-2026-001'
  });
  eq(echo.status, 200, '带自定义字段仍成功');
  eq(echo.json.echo.handId, 'H-2026-001', '自定义字段回显到 echo.handId');
  eq(echo.json.echo['hero.playerId'], 'p-77', 'hero 下的自定义字段回显');
}

async function testMethodAndRouting(base) {
  section('路由与协议');

  const nf = await req(base, 'GET', '/v1/nope');
  eq(nf.status, 404, '未知 /v1 接口 → 404');
  eq(nf.json.error.code, 'E_NOT_FOUND', '未知接口错误码 E_NOT_FOUND');

  const wrongMethod = await req(base, 'GET', '/v1/advise');
  eq(wrongMethod.status, 405, 'GET /v1/advise → 405');
  eq(wrongMethod.json.error.code, 'E_METHOD', '方法错误码 E_METHOD');

  const pre = await fetch(base + '/v1/advise', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' }
  });
  eq(pre.status, 204, 'OPTIONS 预检 → 204');
  eq(pre.headers.get('access-control-allow-origin'), '*', 'CORS 允许任意来源');
  ok((pre.headers.get('access-control-allow-headers') || '').toLowerCase().indexOf('authorization') >= 0,
    'CORS 允许 Authorization 头');

  const posted = await req(base, 'POST', '/v1/advise', EXAMPLES[0].state);
  eq(posted.headers.get('access-control-allow-origin'), '*', '实际响应也带 CORS 头');
  eq(posted.headers.get('x-api-version'), '1.0', '响应带 X-Api-Version');
  eq(posted.headers.get('cache-control'), 'no-store', '响应不缓存');
}

async function testBatch(base) {
  section('批量接口');

  const hands = [
    EXAMPLES.find(e => e.id === 'preflop-btn-open').state,
    EXAMPLES.find(e => e.id === 'flop-tptk-cbet').state,
    { hero: { cards: ['As'] } }   // 故意坏一条
  ];

  const r = await req(base, 'POST', '/v1/advise/batch', { hands, seed: 'batch-A' });
  eq(r.status, 200, 'batch 整体返回 200');
  eq(r.json.ok, true, 'batch ok=true');
  eq(r.json.count, 3, 'batch count=3');
  eq(r.json.okCount, 2, 'batch okCount=2');
  eq(r.json.failCount, 1, 'batch failCount=1');
  eq(r.json.results[2].ok, false, '坏的那条单独标记失败');
  eq(r.json.results[2].error.code, 'E_CARD_COUNT', '坏的那条带错误码');
  ok(r.json.results[0].decision !== undefined, '好的一条仍带 decision');

  // 每条派生种子：整体可复现
  const again = await req(base, 'POST', '/v1/advise/batch', { hands, seed: 'batch-A' });
  eq(JSON.stringify(again.json.results.map(x => x.ok ? x.seed : null)),
    JSON.stringify(r.json.results.map(x => x.ok ? x.seed : null)), 'batch 派生种子稳定');
  eq(again.json.results[1].decision.metrics.equity, r.json.results[1].decision.metrics.equity,
    'batch 同 seed 权益可复现');

  // replay 是别名
  const rp = await req(base, 'POST', '/v1/replay', { hands });
  eq(rp.status, 200, '/v1/replay 与 batch 等价');
  eq(rp.json.count, 3, 'replay count 一致');

  // 结构错误
  const bad1 = await req(base, 'POST', '/v1/advise/batch', { hands: 'x' });
  eq(bad1.json.error.code, 'E_BATCH_SHAPE', 'hands 非数组 → E_BATCH_SHAPE');

  const bad2 = await req(base, 'POST', '/v1/advise/batch', { hands: [] });
  eq(bad2.json.error.code, 'E_BATCH_SHAPE', 'hands 空数组 → E_BATCH_SHAPE');

  const many = [];
  for (let i = 0; i < 101; i++) many.push(EXAMPLES[0].state);
  const bad3 = await req(base, 'POST', '/v1/advise/batch', { hands: many });
  eq(bad3.status, 413, '超过 100 条 → 413');
  eq(bad3.json.error.code, 'E_BATCH_TOO_LARGE', '超限错误码 E_BATCH_TOO_LARGE');

  // 预算保护
  const heavy = [];
  for (let i = 0; i < 80; i++) heavy.push(Object.assign({}, EXAMPLES[1].state, { iterations: 50000 }));
  const bad4 = await req(base, 'POST', '/v1/advise/batch', { hands: heavy });
  eq(bad4.json.error.code, 'E_BATCH_BUDGET', '总抽样量超预算 → E_BATCH_BUDGET');
  ok(bad4.json.error.hint && bad4.json.error.hint.indexOf('iterations') >= 0,
    '预算错误给出可操作建议');
}

async function testConcurrency(base) {
  section('并发');

  const state = EXAMPLES.find(e => e.id === 'flop-flushdraw-face-bet').state;
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(req(base, 'POST', '/v1/advise', Object.assign({}, state, { seed: 999 })));
  }
  const rs = await Promise.all(jobs);
  const allOk = rs.every(r => r.status === 200 && r.json.ok);
  ok(allOk, '20 个并发请求全部成功');

  const equities = new Set(rs.map(r => r.json.decision.metrics.equity));
  eq(equities.size, 1, '并发下同 seed 结果不被串改（Math.random 隔离有效）');
}

async function testLimits() {
  section('体积限制与鉴权');

  const small = await start({ maxBody: 512 });
  try {
    const big = await req(small.base, 'POST', '/v1/advise', {
      hero: { cards: ['As', 'Kc'], stack: 100, invested: 0 },
      street: 'preflop',
      filler: 'x'.repeat(2000)
    });
    eq(big.status, 413, '超过 maxBody → 413');
    eq(big.json.error.code, 'E_TOO_LARGE', '体积超限错误码 E_TOO_LARGE');
  } finally {
    await small.close();
  }

  const guarded = await start({ token: 'secret-token' });
  try {
    const noAuth = await req(guarded.base, 'POST', '/v1/advise', EXAMPLES[0].state);
    eq(noAuth.status, 401, '无令牌 → 401');
    eq(noAuth.json.error.code, 'E_UNAUTHORIZED', '鉴权错误码 E_UNAUTHORIZED');

    const badAuth = await req(guarded.base, 'POST', '/v1/advise', EXAMPLES[0].state,
      { Authorization: 'Bearer wrong' });
    eq(badAuth.status, 401, '错误令牌 → 401');

    const goodAuth = await req(guarded.base, 'POST', '/v1/advise', EXAMPLES[0].state,
      { Authorization: 'Bearer secret-token' });
    eq(goodAuth.status, 200, '正确令牌 → 200');

    const headerAuth = await req(guarded.base, 'POST', '/v1/advise', EXAMPLES[0].state,
      { 'X-Api-Key': 'secret-token' });
    eq(headerAuth.status, 200, 'X-Api-Key 等价于 Bearer');
  } finally {
    await guarded.close();
  }
}

async function testStatic(base) {
  section('静态托管');

  const idx = await req(base, 'GET', '/');
  eq(idx.status, 200, 'GET / 返回首页');
  ok(idx.text.indexOf('<!DOCTYPE html>') >= 0, '/ 返回 HTML');

  const lab = await req(base, 'GET', '/demo/api-lab.html');
  eq(lab.status, 200, '调试台页面可访问');

  const eng = await req(base, 'GET', '/engine/gto-engine.js');
  eq(eng.status, 200, '引擎脚本可访问');
  ok((eng.headers.get('content-type') || '').indexOf('javascript') >= 0, '引擎脚本 MIME 正确');

  const miss = await req(base, 'GET', '/nope.html');
  eq(miss.status, 404, '不存在的静态文件 → 404');

  const traversal = await req(base, 'GET', '/../package.json');
  ok(traversal.status === 404 || traversal.status === 403, '路径穿越被拦（' + traversal.status + '）');

  const git = await req(base, 'GET', '/.git/config');
  ok(git.status === 403 || git.status === 404, '.git 不对外提供（' + git.status + '）');
}

/* ------------------------------- CLI ------------------------------- */

function cli(args, input) {
  const r = spawnSync(NODE, [path.join(ROOT, 'server/gto-cli.js')].concat(args), {
    input: input === undefined ? undefined : input,
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60000
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function testCli() {
  section('CLI 管道协议');

  const preflop = JSON.stringify(EXAMPLES.find(e => e.id === 'preflop-btn-open').state);

  const one = cli(['--once', preflop]);
  eq(one.status, 0, '--once 退出码 0');
  let parsed = null;
  try { parsed = JSON.parse(one.stdout.trim()); } catch (e) { /* 留给断言 */ }
  ok(parsed && parsed.ok === true, '--once 输出合法 JSON 且 ok=true');
  ok(parsed && parsed.decision && parsed.decision.action, '--once 带 decision');

  const withTeaching = cli(['--once', preflop, '--no-teaching']);
  ok(!JSON.parse(withTeaching.stdout).teaching, '--no-teaching 去掉 teaching 字段');

  const bad = cli(['--once', '{"hero":{"cards":["As"]}}']);
  eq(bad.status, 1, '校验失败时退出码 1');
  ok(JSON.parse(bad.stdout).ok === false, '失败输出 ok=false');

  const text = cli(['--once', preflop, '--text']);
  ok(text.stdout.indexOf('翻前') >= 0, '--text 输出教学卡片');

  // 流模式：三行进三行出，坏行不影响后续
  const lines = [
    preflop,
    '# 这是注释行，应被忽略',
    JSON.stringify(EXAMPLES.find(e => e.id === 'flop-tptk-cbet').state),
    '{"hero":{"cards":["As"]}}',
    JSON.stringify(EXAMPLES.find(e => e.id === 'river-bluffcatch').state)
  ].join('\n');

  const stream = cli([], lines + '\n');
  const outLines = stream.stdout.trim().split('\n').filter(Boolean);
  eq(outLines.length, 4, '流模式：4 个有效输入 → 4 行输出（注释被忽略）');
  ok(outLines.every(l => {
    try { JSON.parse(l); return true; } catch (e) { return false; }
  }), '流模式每行都是独立合法 JSON');
  eq(JSON.parse(outLines[2]).ok, false, '流模式坏行标记失败但不中断');
  eq(JSON.parse(outLines[3]).ok, true, '坏行之后的输入仍被处理');

  const strict = cli(['--strict'], lines + '\n');
  eq(strict.status, 1, '--strict 有失败则退出码 1');

  // 流模式默认固定 seed：两次运行结果必须一致（耗时字段除外，它本来就该变）
  const stripTiming = s => {
    try {
      const o = JSON.parse(s);
      delete o.elapsedMs;
      return JSON.stringify(o);
    } catch (e) { return s; }
  };
  const s1 = cli([], preflop + '\n');
  const s2 = cli([], preflop + '\n');
  eq(stripTiming(s1.stdout), stripTiming(s2.stdout), '流模式两次运行数值完全一致（默认固定 seed）');
}

/* ------------------------------- SDK ------------------------------- */

async function testClient(base) {
  section('客户端 SDK');

  const C = require('../client/gto-client.js');
  const c = C.create({ baseUrl: base, retries: 0, timeout: 5000 });
  const state = EXAMPLES.find(e => e.id === 'flop-tptk-cbet').state;

  const health = await c.health();
  eq(health.ok, true, 'SDK health ok');

  const r = await c.ask(state);
  eq(r.ok, true, 'SDK ask 成功');
  ok(r.teaching && typeof r.teaching.headline === 'string', 'SDK ask 带 teaching');

  const headline = await c.headline(state);
  ok(typeof headline === 'string' && headline.indexOf('→') >= 0, 'SDK headline 返回一句话');

  const bad = await c.ask({ hero: { cards: ['As'] } });
  eq(bad.ok, false, 'SDK 校验失败返回 ok=false（不抛异常）');
  eq(bad.error.code, 'E_CARD_COUNT', 'SDK 正确传递错误码');

  const lean = await c.ask(state, { teaching: false });
  eq(lean.ok, true, 'SDK teaching:false 仍成功');
  ok(!lean.teaching, 'SDK teaching:false 不带 teaching');

  const dead = C.create({ baseUrl: 'http://127.0.0.1:1', retries: 0, timeout: 800 });
  const nr = await dead.ask(state);
  eq(nr.ok, false, '连不上时返回 ok=false 而不是抛异常');
  eq(nr.error.code, 'E_NETWORK', '网络错误码 E_NETWORK');

  // 本地客户端
  const local = C.createLocal({ seed: 7 });
  const lr = await local.ask(state);
  eq(lr.ok, true, '本地客户端 ok');
  ok(lr.teaching && lr.teaching.headline, '本地客户端带 teaching');
  const lr2 = await local.ask(state);
  eq(lr2.decision.metrics.equity, lr.decision.metrics.equity, '本地客户端固定 seed 可复现');

  // 关键：本地直算与服务端必须给出同一个数字
  const withSeed = Object.assign({}, state, { seed: 7 });
  const remoteSeeded = await c.ask(withSeed);
  const localSeeded = local.askSync(withSeed);
  eq(localSeeded.decision.metrics.equity, remoteSeeded.decision.metrics.equity,
    '本地直算与服务端同 seed 权益完全一致');

  const lb = await local.batch([state, { hero: { cards: ['As'] } }]);
  eq(lb.count, 2, '本地批量 count=2');
  eq(lb.failCount, 1, '本地批量能标出失败条目');
}

/* ------------------------------- 主流程 ------------------------------- */

(async function main() {
  console.log('\n  GTO 接口自测');
  console.log('  ' + '='.repeat(56));

  const app = await start({});
  try {
    await testBasics(app.base);
    await testAdvise(app.base);
    await testDeterminism(app.base);
    await testValidation(app.base);
    await testMethodAndRouting(app.base);
    await testBatch(app.base);
    await testConcurrency(app.base);
    await testClient(app.base);
    await testStatic(app.base);
  } finally {
    await app.close();
  }

  await testLimits();
  testCli();

  console.log('\n  ' + '='.repeat(56));
  if (failures.length === 0) {
    console.log('  全部通过：' + pass + ' 项');
    console.log('');
    process.exit(0);
  }
  console.log('  通过 ' + pass + ' 项，失败 ' + failures.length + ' 项：');
  failures.forEach(f => console.log('   · ' + f.name + (f.detail ? '  → ' + f.detail : '')));
  console.log('');
  process.exit(1);
})().catch(e => {
  console.error('\n测试脚本自身出错：', e);
  process.exit(2);
});
