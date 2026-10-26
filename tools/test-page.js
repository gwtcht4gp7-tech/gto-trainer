#!/usr/bin/env node
/*!
 * test-page.js — 页面烟测
 * ---------------------------------------------------------------
 * 静态检查能发现「引用了不存在的 id」，但发现不了「渲染时对
 * undefined 取属性」这类运行时错误。这个脚本用 vm + 最小 DOM 桩
 * 真的把页面脚本跑一遍：加载 → 填表 → 点发送 → 检查渲染结果。
 *
 * 没有引入 jsdom：桩只实现页面实际用到的那几个 API，
 * 一旦页面用了新 API 就会在这里暴露出来，而不是在用户浏览器里。
 * ---------------------------------------------------------------
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) pass++;
  else {
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

/* ------------------------------ DOM 桩 ------------------------------ */

function makeEl(id) {
  const listeners = {};
  let inner = '';
  const el = {
    id: id || '',
    tagName: 'DIV',
    value: '',
    textContent: '',
    checked: false,
    children: [],
    style: {},
    className: '',
    classList: {
      add() {}, remove() {}, contains() { return false; },
      toggle() {}
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(child) { el.children.push(child); return child; },
    remove() {},
    getAttribute() { return null; },
    setAttribute() {},
    closest() { return null; },
    select() {},
    focus() {},
    _listeners: listeners,
    _fire(type, ev) {
      (listeners[type] || []).forEach(fn => fn(ev || { target: el, preventDefault() {} }));
    }
  };

  // innerHTML 赋值要真的清空子节点，否则 renderCards 这类
  // 「先清空再 append」的逻辑在桩里会变成不断累积。
  // 注意：桩不解析 HTML 字符串，innerHTML 里的元素不会变成 children。
  Object.defineProperty(el, 'innerHTML', {
    get() { return inner; },
    set(v) {
      inner = String(v);
      el.children.length = 0;
    }
  });

  return el;
}

function makeDocument(ids) {
  const store = {};
  ids.forEach(id => { store[id] = makeEl(id); });

  const doc = {
    getElementById(id) {
      if (!store[id]) store[id] = makeEl(id);
      return store[id];
    },
    createElement(tag) {
      const el = makeEl('');
      el.tagName = String(tag).toUpperCase();
      return el;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    body: makeEl('body'),
    documentElement: { scrollTop: 0, scrollHeight: 1, clientHeight: 1 },
    execCommand() { return true; },
    _store: store
  };
  return doc;
}

/* --------------------------- 页面脚本加载 --------------------------- */

function loadPageScripts(ctx, files) {
  files.forEach(f => {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  });
}

/** 取出 html 里的内联脚本（不含 src 的） */
function inlineScripts(htmlPath) {
  const html = fs.readFileSync(path.join(ROOT, htmlPath), 'utf8');
  const out = [];
  const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/* ------------------------------ 烟测 ------------------------------ */

async function testApiLab() {
  console.log('\n  api-lab.html 烟测');

  const scripts = inlineScripts('demo/api-lab.html');
  ok(scripts.length === 1, 'api-lab 只有一个内联脚本', '实际 ' + scripts.length);

  const ids = [
    'baseUrl', 'btnPing', 'connState', 'formMode', 'jsonMode', 'jsonBox',
    'f-street', 'f-numPlayers', 'posGroup', 'f-hero', 'f-board', 'heroCards',
    'boardCards', 'boardHint', 'f-pot', 'f-toCall', 'f-stack', 'f-villainPos',
    'f-advanced-toggle', 'advanced', 'f-iterations', 'f-seed', 'f-villainRange',
    'f-raiseCount', 'preset', 'btnSend', 'sendHint', 'reqPreview', 'timing',
    'respBody', 'codeTabs', 'btnCopyReq', 'btnCopyCode', 'codeBox'
  ];

  const doc = makeDocument(ids);
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Boolean,
    isFinite,
    location: { protocol: 'http:', href: 'http://127.0.0.1:8787/demo/api-lab.html' },
    navigator: {},
    performance: { now: () => Date.now() },
    AbortController,
    // 一律失败：让页面走「离线 → 本地引擎」这条分支
    fetch: () => Promise.reject(new Error('offline')),
    document: doc
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  let loadError = null;
  try {
    loadPageScripts(ctx, [
      'engine/gto-engine.js',
      'server/validate.js',
      'server/enrich.js',
      'server/examples.js'
    ]);
    vm.runInContext(scripts[0], ctx, { filename: 'demo/api-lab.html#inline' });
  } catch (e) {
    loadError = e;
  }
  ok(!loadError, '页面脚本加载无异常', loadError && loadError.message);
  if (loadError) return;

  // 依赖是否挂上
  ok(!!sandbox.GTOEngine, 'window.GTOEngine 已加载');
  ok(!!sandbox.GTOValidate, 'window.GTOValidate 已加载');
  ok(!!sandbox.GTOEnrich, 'window.GTOEnrich 已加载');
  ok(!!sandbox.GTOExamples, 'window.GTOExamples 已加载');

  // 预设下拉：每个样例一项。桩不解析 innerHTML，
  // 所以那个 "— 载入预设局面 —" 占位项不算在内。
  const preset = doc.getElementById('preset');
  ok(preset.children.length === sandbox.GTOExamples.EXAMPLES.length,
    '预设下拉为每个样例生成了一项',
    '实际 ' + preset.children.length + ' / 期望 ' + sandbox.GTOExamples.EXAMPLES.length);

  // 请求预览应该已经渲染出 JSON
  const preview = doc.getElementById('reqPreview').innerHTML;
  ok(preview.indexOf('hero') >= 0, '请求预览已渲染');

  // 填一个能算的局面
  doc.getElementById('f-hero').value = 'Ac Kc';
  doc.getElementById('f-board').value = 'As 7d 2c';
  doc.getElementById('f-pot').value = '5.1';
  doc.getElementById('f-toCall').value = '0';
  doc.getElementById('f-stack').value = '97.7';
  doc.getElementById('f-numPlayers').value = '2';
  doc.getElementById('f-villainPos').value = 'BB';

  // 触发 input 事件，让页面同步牌面视图和预览
  ['f-hero', 'f-board'].forEach(id => doc.getElementById(id)._fire('input'));

  ok(doc.getElementById('heroCards').children.length === 2, '手牌视图渲染 2 张');
  ok(doc.getElementById('boardCards').children.length === 3, '公共牌视图渲染 3 张');

  // 点发送（离线 → 本地引擎，内部有 60ms 的 setTimeout）
  doc.getElementById('btnSend')._fire('click');
  await new Promise(r => setTimeout(r, 400));

  const body = doc.getElementById('respBody').innerHTML;
  ok(body.indexOf('verdict') >= 0, '响应区渲染出结论卡片');
  ok(body.indexOf('翻牌圈') >= 0, '结论里有街名与牌面', body.slice(0, 120));
  ok(body.indexOf('下注') >= 0 || body.indexOf('过牌') >= 0, '结论里有动作');
  ok(body.indexOf('为什么是这个动作') >= 0, '渲染了理由区');
  ok(body.indexOf('隐含假设') >= 0, '渲染了假设区');
  ok(body.indexOf('本地引擎') >= 0 || body.indexOf('HTTP') >= 0, '标注了计算来源');

  // 错误路径：清空手牌再发
  doc.getElementById('f-hero').value = '';
  doc.getElementById('f-hero')._fire('input');
  doc.getElementById('btnSend')._fire('click');
  await new Promise(r => setTimeout(r, 400));

  const errBody = doc.getElementById('respBody').innerHTML;
  ok(errBody.indexOf('E_') >= 0, '错误路径渲染出错误码', errBody.slice(0, 160));
  ok(errBody.indexOf('errbox') >= 0, '错误用了专门的样式块');

  // 代码片段应该跟着当前请求走
  const code = doc.getElementById('codeBox').innerHTML;
  ok(code.indexOf('curl') >= 0 || code.indexOf('POST') >= 0, '代码片段已生成');
}

async function testEngineDemo() {
  console.log('\n  engine-demo.html 烟测');

  const scripts = inlineScripts('demo/engine-demo.html');
  if (scripts.length === 0) {
    console.log('  （该页面没有内联脚本，跳过）');
    return;
  }

  // 只做加载检查：页面用到的 id 很多，桩不好覆盖，能无异常执行即算通过
  const doc = makeDocument([]);
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Number, String,
    Array, Object, Boolean, isFinite,
    location: { protocol: 'http:' },
    navigator: {},
    performance: { now: () => Date.now() },
    fetch: () => Promise.reject(new Error('offline')),
    document: doc
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  let err = null;
  try {
    loadPageScripts(ctx, ['engine/gto-engine.js']);
    scripts.forEach(s => vm.runInContext(s, ctx, { filename: 'demo/engine-demo.html#inline' }));
  } catch (e) {
    err = e;
  }
  ok(!err, 'engine-demo 脚本执行无异常', err && err.message);
}

/* ------------------------------ 主流程 ------------------------------ */

(async function main() {
  console.log('\n  页面烟测');
  console.log('  ' + '='.repeat(56));

  await testApiLab();
  await testEngineDemo();

  console.log('\n  ' + '='.repeat(56));
  if (failures.length === 0) {
    console.log('  全部通过：' + pass + ' 项\n');
    process.exit(0);
  }
  console.log('  通过 ' + pass + ' 项，失败 ' + failures.length + ' 项：');
  failures.forEach(f => console.log('   · ' + f));
  console.log('');
  process.exit(1);
})();
