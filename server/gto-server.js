#!/usr/bin/env node
/*!
 * gto-server.js — GTO 分析接口（零依赖）
 * ---------------------------------------------------------------
 * 把 engine/gto-engine.js 包成一个本地 HTTP 服务，供游戏客户端、
 * 插件侧、复盘工具通过 JSON 调用。
 *
 *   node server/gto-server.js --port 8787
 *
 * 设计取向：
 *   1. 默认只监听 127.0.0.1 —— 这是本机工具，不是公网服务。
 *   2. 校验层挡在引擎前面，把「静默算错」变成「明确报错」。
 *   3. 每个响应都带 seed，同样的输入永远得到同样的数值。
 *   4. 同时托管静态站点，一个进程既跑 API 又跑知识库和调试台。
 * ---------------------------------------------------------------
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const engine = require('../engine/gto-engine.js');
const V = require('./validate.js');
const { enrich } = require('./enrich.js');
const { withSeed } = require('./prng.js');
const { EXAMPLES } = require('./examples.js');

const ROOT = path.resolve(__dirname, '..');
const PKG_NAME = 'gto-trainer';
const MAX_BODY = 1024 * 1024;
const MAX_BATCH = 100;
const BATCH_ITER_BUDGET = 400000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ================================================================== */
/* 1. 配置                                                            */
/* ================================================================== */

function parseArgs(argv) {
  const cfg = {
    port: 8787,
    host: '127.0.0.1',
    token: null,
    allowOrigin: '*',
    quiet: false,
    static: true,
    maxBody: MAX_BODY
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port': case '-p': cfg.port = Number(next()); break;
      case '--host': cfg.host = next(); break;
      case '--token': cfg.token = next(); break;
      case '--allow-origin': cfg.allowOrigin = next(); break;
      case '--max-body': cfg.maxBody = Number(next()); break;
      case '--quiet': case '-q': cfg.quiet = true; break;
      case '--no-static': cfg.static = false; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        if (a.startsWith('--')) {
          console.error('未知参数：' + a + '（用 --help 查看用法）');
          process.exit(2);
        }
    }
  }

  if (!Number.isFinite(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    console.error('--port 必须是 1-65535 的整数');
    process.exit(2);
  }
  return cfg;
}

function printHelp() {
  console.log([
    'GTO 分析接口',
    '',
    '用法: node server/gto-server.js [选项]',
    '',
    '  --port, -p <n>        监听端口，默认 8787',
    '  --host <addr>         监听地址，默认 127.0.0.1（只允许本机访问）',
    '  --token <str>         要求请求携带 Authorization: Bearer <str>',
    '  --allow-origin <o>    CORS 允许来源，默认 *',
    '  --max-body <bytes>    请求体上限，默认 1048576',
    '  --no-static           不托管静态站点，只提供 API',
    '  --quiet, -q           不打印访问日志',
    '  --help, -h            显示本帮助',
    '',
    '接口:',
    '  GET  /v1/health             健康检查',
    '  GET  /v1/meta               版本、字段说明、动作枚举',
    '  GET  /v1/examples           标准请求样例',
    '  POST /v1/advise             单次分析',
    '  POST /v1/advise/batch       批量分析（最多 ' + MAX_BATCH + ' 条）',
    '  POST /v1/replay             /v1/advise/batch 的别名',
    ''
  ].join('\n'));
}

/* ================================================================== */
/* 2. 响应工具                                                        */
/* ================================================================== */

const VALIDATION_CODES = new Set([
  'E_NOT_OBJECT', 'E_MISSING_FIELD', 'E_FIELD_TYPE', 'E_BAD_CARD',
  'E_BAD_CARD_FORMAT', 'E_DUP_CARD', 'E_CARD_COUNT', 'E_CARD_CONFLICT',
  'E_BOARD_SIZE', 'E_BAD_STREET', 'E_STREET_MISMATCH', 'E_BAD_POSITION',
  'E_OUT_OF_RANGE', 'E_BAD_RANGE', 'E_RANGE_BLOCKED', 'E_BATCH_SHAPE',
  'E_BATCH_TOO_LARGE', 'E_BATCH_BUDGET'
]);

function statusFor(code) {
  if (code === 'E_JSON' || code === 'E_BODY_EMPTY' || code === 'E_NOT_OBJECT') return 400;
  if (code === 'E_TOO_LARGE' || code === 'E_BATCH_TOO_LARGE') return 413;
  if (code === 'E_UNAUTHORIZED') return 401;
  if (code === 'E_FORBIDDEN') return 403;
  if (code === 'E_NOT_FOUND') return 404;
  if (code === 'E_METHOD') return 405;
  if (code === 'E_ENGINE') return 500;
  return VALIDATION_CODES.has(code) ? 422 : 400;
}

function makeError(code, message, hint, field) {
  return { code, message, hint: hint || null, field: field || null };
}

/* ================================================================== */
/* 3. 分析核心                                                        */
/* ================================================================== */

function randomSeed() {
  return crypto.randomInt(0, 4294967296);
}

/** 把内部 state（数字牌）转成可读回显 */
function serializeState(v) {
  return {
    street: v.street,
    hero: {
      pos: v.hero.pos,
      cards: v.hero.cards.map(engine.cardStr),
      stack: v.hero.stack,
      invested: v.hero.invested
    },
    board: v.boardCards.map(engine.cardStr),
    pot: v.pot,
    toCall: v.toCall,
    effectiveStack: v.effectiveStack,
    numPlayers: v.numPlayers,
    raiseCount: v.raiseCount,
    villainPos: v.villainPos,
    villainOpenPos: v.villainOpenPos,
    villainRange: v.villainRange,
    villainRaisedPostflop: v.villainRaisedPostflop,
    iterations: v.iterations,
    handClass: engine.handClass(v.hero.cards[0], v.hero.cards[1])
  };
}

/**
 * 单次分析。永远返回结构化对象，不抛异常。
 * @param {*} raw 客户端原始 JSON
 * @param {object} ctx { requestId, withTeaching }
 */
function analyseOne(raw, ctx) {
  const t0 = process.hrtime.bigint();
  const requestId = ctx.requestId;

  // --- 契约校验 ---
  const v = V.validate(raw);
  if (!v.ok) {
    return {
      ok: false,
      requestId,
      error: {
        code: v.errors[0].code,
        message: v.errors[0].message,
        hint: v.errors[0].hint,
        field: v.errors[0].field
      },
      errors: v.errors,
      warnings: v.warnings
    };
  }

  // --- 种子 ---
  let seed;
  if (raw && raw.seed !== undefined && raw.seed !== null && raw.seed !== '') {
    seed = typeof raw.seed === 'number' ? raw.seed : String(raw.seed);
  } else {
    seed = randomSeed();
  }

  // --- 决策（固定种子，可复现）---
  let decision;
  try {
    decision = withSeed(seed, () => engine.advise(v.value));
  } catch (e) {
    return {
      ok: false,
      requestId,
      seed,
      error: makeError('E_ENGINE', '引擎执行失败：' + e.message, '这是引擎缺陷，请带 state 提 issue'),
      errors: [makeError('E_ENGINE', e.message)],
      warnings: v.warnings
    };
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const out = {
    ok: true,
    apiVersion: V.API_VERSION,
    engineVersion: engine.version,
    requestId,
    seed,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    input: serializeState(v.value),
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

  if (v.echo && Object.keys(v.echo).length) out.echo = v.echo;

  if (ctx.withTeaching !== false) {
    out.teaching = enrich(v.value, decision);
  }

  return out;
}

/* ================================================================== */
/* 4. HTTP 工具                                                       */
/* ================================================================== */

function corsHeaders(cfg) {
  return {
    'Access-Control-Allow-Origin': cfg.allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function sendJson(res, status, payload, cfg, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Api-Version': V.API_VERSION
  }, corsHeaders(cfg), extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
  return Buffer.byteLength(body);
}

/**
 * 统一错误响应：无论哪一层出错，客户端都能只读 error.message，
 * 也能遍历 errors 拿到全部问题。契约一致性比省几个字节重要。
 */
function sendError(res, requestId, err, cfg, warnings) {
  const payload = {
    ok: false,
    requestId,
    error: err,
    errors: [err]
  };
  if (warnings && warnings.length) payload.warnings = warnings;
  return sendJson(res, statusFor(err.code), payload, cfg);
}

/** 读请求体，超限时立即中断 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];

    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(makeError('E_TOO_LARGE',
          '请求体超过 ' + limit + ' 字节上限',
          '正确用法是一手牌一条请求，不要把整局牌谱一起提交'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', e => {
      if (done) return;
      done = true;
      reject(makeError('E_BODY_READ', '读取请求体失败：' + e.message));
    });
  });
}

function parseJson(text) {
  if (!text || !text.trim()) {
    return { ok: false, error: makeError('E_BODY_EMPTY', '请求体为空', '需要一个 JSON 对象，例如 {"hero":{"cards":["As","Kc"]}}') };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    return {
      ok: false,
      error: makeError('E_JSON', 'JSON 解析失败：' + e.message,
        m ? '错误出现在第 ' + m[1] + ' 个字符附近' : '检查引号、逗号和尾随逗号')
    };
  }
}

/* ================================================================== */
/* 5. 路由                                                            */
/* ================================================================== */

function handleHealth(req, res, cfg, requestId) {
  sendJson(res, 200, {
    ok: true,
    apiVersion: V.API_VERSION,
    engineVersion: engine.version,
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    limits: {
      maxBody: cfg.maxBody,
      maxBatch: MAX_BATCH,
      iterations: V.LIMITS.iterations
    }
  }, cfg);
}

function handleMeta(req, res, cfg) {
  sendJson(res, 200, {
    ok: true,
    name: PKG_NAME,
    apiVersion: V.API_VERSION,
    engineVersion: engine.version,
    endpoints: [
      { method: 'GET', path: '/v1/health', desc: '健康检查' },
      { method: 'GET', path: '/v1/meta', desc: '本响应：字段与枚举说明' },
      { method: 'GET', path: '/v1/examples', desc: '标准请求样例' },
      { method: 'POST', path: '/v1/advise', desc: '单次分析' },
      { method: 'POST', path: '/v1/advise/batch', desc: '批量分析（≤' + MAX_BATCH + ' 条）' },
      { method: 'POST', path: '/v1/replay', desc: 'batch 别名' }
    ],
    enums: {
      street: V.STREETS,
      position: V.POSITIONS,
      action: V.ACTIONS,
      confidence: ['high', 'medium', 'low'],
      sizingUnit: ['pot', 'bb']
    },
    actionCN: V.ACTION_CN,
    fields: V.FIELDS,
    limits: {
      maxBody: cfg.maxBody,
      maxBatch: MAX_BATCH,
      batchIterBudget: BATCH_ITER_BUDGET,
      iterations: V.LIMITS.iterations
    },
    semantics: {
      pot: '当前底池总额（含对手本次下注）。跟注所需权益 = toCall / (pot + toCall)。',
      sizingUnit: 'bb 表示「加到多少 bb」；pot 表示「占底池比例」，absolute 字段恒为 bb。',
      frequency: '该动作在均衡中的建议频率，<1 表示混合节点。',
      seed: '固定 seed 时同一输入得到完全相同的数值输出。'
    },
    notes: [
      '本引擎是规则拟合，不是 solver：不做树搜索，多人池按单挑 + 死钱处理，无 ICM。',
      '所有策略结论都附 reasons 数组，可用作教学解释。'
    ]
  }, cfg);
}

function handleExamples(req, res, cfg) {
  sendJson(res, 200, { ok: true, count: EXAMPLES.length, examples: EXAMPLES }, cfg);
}

async function handleAdvise(req, res, cfg, requestId) {
  const text = await readBody(req, cfg.maxBody);
  const parsed = parseJson(text);
  if (!parsed.ok) return sendError(res, requestId, parsed.error, cfg);

  const result = analyseOne(parsed.value, { requestId, withTeaching: true });
  if (!result.ok) {
    return sendJson(res, statusFor(result.error.code),
      { ok: false, requestId, error: result.error, errors: result.errors, warnings: result.warnings }, cfg);
  }
  return sendJson(res, 200, result, cfg);
}

async function handleBatch(req, res, cfg, requestId) {
  const text = await readBody(req, cfg.maxBody);
  const parsed = parseJson(text);
  if (!parsed.ok) return sendError(res, requestId, parsed.error, cfg);

  const body = parsed.value;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, requestId, makeError('E_BATCH_SHAPE',
      '请求体必须是对象，形如 {"hands":[ ... ]}', '单条请用 POST /v1/advise'), cfg);
  }

  const hands = body.hands;
  if (!Array.isArray(hands)) {
    return sendError(res, requestId, makeError('E_BATCH_SHAPE',
      'body.hands 必须是数组', '{"hands":[{"hero":{"cards":["As","Kc"]},...}, ...]}'), cfg);
  }
  if (hands.length === 0) {
    return sendError(res, requestId, makeError('E_BATCH_SHAPE', 'body.hands 为空数组', null), cfg);
  }
  if (hands.length > MAX_BATCH) {
    return sendError(res, requestId, makeError('E_BATCH_TOO_LARGE',
      '单次最多 ' + MAX_BATCH + ' 条，收到 ' + hands.length + ' 条',
      '复盘请分批提交；一次请求是同步计算的，条数过大会让客户端等到超时'), cfg);
  }

  // 计算预算：总抽样次数不能爆掉单进程
  const shareOpts = body.opts && typeof body.opts === 'object' ? body.opts : {};
  const baseIter = Number(shareOpts.iterations) || 6000;
  const budget = hands.length * baseIter;
  if (budget > BATCH_ITER_BUDGET) {
    return sendError(res, requestId, makeError('E_BATCH_BUDGET',
      '总抽样量 ' + budget + ' 超过预算 ' + BATCH_ITER_BUDGET,
      '降低 iterations，或拆成多次请求。例：' + hands.length + ' 条 × '
        + Math.floor(BATCH_ITER_BUDGET / hands.length) + ' 次 = 可接受'), cfg);
  }

  const withTeaching = body.teaching !== false;
  const t0 = Date.now();
  const seedBase = body.seed;

  const results = hands.map((h, i) => {
    const merged = Object.assign({}, shareOpts, h);
    // 每条派生独立种子：整体可复现，条与条之间不相关
    if (merged.seed === undefined) {
      merged.seed = (seedBase === undefined || seedBase === null)
        ? (i + 1) * 7919 + 13
        : String(seedBase) + '#' + i;
    }
    const r = analyseOne(merged, { requestId: requestId + '-' + i, withTeaching });
    return Object.assign({ index: i }, r);
  });

  const okCount = results.filter(r => r.ok).length;
  sendJson(res, 200, {
    ok: true,
    requestId,
    count: results.length,
    okCount,
    failCount: results.length - okCount,
    elapsedMs: Date.now() - t0,
    results
  }, cfg);
}

/* --------------------------- 静态站点 --------------------------- */

function serveStatic(req, res, cfg, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch (e) {
    return sendError(res, null, makeError('E_BAD_PATH', 'URL 编码非法'), cfg);
  }

  if (rel === '/' || rel === '') rel = '/index.html';

  const abs = path.resolve(ROOT, '.' + rel);
  const relative = path.relative(ROOT, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return sendError(res, null, makeError('E_FORBIDDEN', '路径越界'), cfg);
  }
  // .git 与 node_modules 不对外
  const segs = relative.split(path.sep);
  if (segs.indexOf('.git') >= 0 || segs.indexOf('node_modules') >= 0) {
    return sendError(res, null, makeError('E_FORBIDDEN', '该路径不对外提供'), cfg);
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      return sendError(res, null, makeError('E_NOT_FOUND',
        '找不到资源：' + urlPath,
        'API 见 /v1/meta，站点首页是 /index.html'), cfg);
    }

    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = Object.assign({
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    }, corsHeaders(cfg));

    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(abs);
    stream.pipe(res);
    stream.on('error', () => res.destroy());
  });
}

/* ================================================================== */
/* 6. 服务器                                                          */
/* ================================================================== */

function createServer(cfg) {
  cfg = Object.assign({
    port: 8787, host: '127.0.0.1', token: null,
    allowOrigin: '*', quiet: false, static: true, maxBody: MAX_BODY
  }, cfg || {});

  const server = http.createServer(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const requestId = crypto.randomUUID();
    const urlPath = (req.url || '/').split('?')[0];
    let accounted = 0;

    // 记录响应字节数（仅用于日志）
    const origEnd = res.end.bind(res);
    res.end = function (chunk, ...rest) {
      if (chunk) accounted += Buffer.byteLength(chunk);
      return origEnd(chunk, ...rest);
    };

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(cfg));
      return res.end();
    }

    // 令牌
    if (cfg.token) {
      const auth = req.headers['authorization'] || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const key = bearer || req.headers['x-api-key'] || '';
      if (key !== cfg.token) {
        return sendError(res, requestId, makeError('E_UNAUTHORIZED',
          '缺少或错误的访问令牌',
          '请求头加 Authorization: Bearer <token>，token 是服务启动参数 --token 的值'), cfg);
      }
    }

    try {
      // ---------- API ----------
      if (urlPath === '/v1/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendError(res, requestId, makeError('E_METHOD', '该接口只支持 GET'), cfg);
        }
        return handleHealth(req, res, cfg, requestId);
      }

      if (urlPath === '/v1/meta') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendError(res, requestId, makeError('E_METHOD', '该接口只支持 GET'), cfg);
        }
        return handleMeta(req, res, cfg);
      }

      if (urlPath === '/v1/examples') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendError(res, requestId, makeError('E_METHOD', '该接口只支持 GET'), cfg);
        }
        return handleExamples(req, res, cfg);
      }

      if (urlPath === '/v1/advise') {
        if (req.method !== 'POST') {
          return sendError(res, requestId, makeError('E_METHOD',
            '该接口只支持 POST', '把 hand state 放进 JSON 请求体'), cfg);
        }
        return await handleAdvise(req, res, cfg, requestId);
      }

      if (urlPath === '/v1/advise/batch' || urlPath === '/v1/replay') {
        if (req.method !== 'POST') {
          return sendError(res, requestId, makeError('E_METHOD',
            '该接口只支持 POST', '把 hand state 数组放进 body.hands'), cfg);
        }
        return await handleBatch(req, res, cfg, requestId);
      }

      if (urlPath.startsWith('/v1/')) {
        return sendError(res, requestId, makeError('E_NOT_FOUND',
          '未知接口：' + urlPath, '已知接口见 GET /v1/meta'), cfg);
      }

      // ---------- 静态 ----------
      if (cfg.static && (req.method === 'GET' || req.method === 'HEAD')) {
        return serveStatic(req, res, cfg, urlPath);
      }

      return sendError(res, requestId, makeError('E_NOT_FOUND', '找不到：' + urlPath), cfg);
    } catch (e) {
      if (e && e.code && e.message) {
        return sendError(res, requestId, e, cfg);
      }
      if (!cfg.quiet) console.error('[error]', e);
      return sendError(res, requestId, makeError('E_INTERNAL',
        '服务内部错误：' + (e && e.message ? e.message : String(e))), cfg);
    } finally {
      if (!cfg.quiet) {
        const ms = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);
        const stamp = new Date().toTimeString().slice(0, 8);
        console.log('[' + stamp + '] ' + res.statusCode + ' '
          + req.method + ' ' + urlPath + ' ' + ms + 'ms ' + accounted + 'B');
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/* ================================================================== */
/* 7. 启动                                                            */
/* ================================================================== */

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const server = createServer(cfg);

  server.listen(cfg.port, cfg.host, () => {
    const base = 'http://' + (cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host) + ':' + cfg.port;
    const lines = [
      '',
      '  GTO 分析接口已启动',
      '  ' + '-'.repeat(52),
      '  地址      ' + base,
      '  单次      POST ' + base + '/v1/advise',
      '  批量      POST ' + base + '/v1/advise/batch',
      '  字段说明  GET  ' + base + '/v1/meta',
      '  样例      GET  ' + base + '/v1/examples'
    ];
    if (cfg.static) lines.push('  调试台    ' + base + '/demo/api-lab.html');
    if (cfg.static) lines.push('  知识库    ' + base + '/index.html');
    if (cfg.token) lines.push('  令牌      已启用（Authorization: Bearer ...）');
    lines.push('  ' + '-'.repeat(52));

    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && !cfg.token) {
      lines.push('');
      lines.push('  ! 你监听了 ' + cfg.host + ' 且没有设置 --token。');
      lines.push('    这会把分析接口暴露给同网络的其他人，建议加 --token。');
    }
    lines.push('');
    console.log(lines.join('\n'));
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error('端口 ' + cfg.port + ' 已被占用。换一个：--port 8788');
      process.exit(1);
    }
    console.error('启动失败：' + e.message);
    process.exit(1);
  });

  const shutdown = sig => {
    console.log('\n收到 ' + sig + '，正在关闭...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

module.exports = { createServer, analyseOne, parseArgs, ROOT };

if (require.main === module) main();
