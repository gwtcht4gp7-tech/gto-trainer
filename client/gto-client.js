/*!
 * gto-client.js — 客户端 SDK
 * ---------------------------------------------------------------
 * 游戏客户端不该自己拼 fetch、自己算超时、自己决定要不要重试。
 * 这一层把这些脏活包掉，并保证两种模式的返回形状完全一致：
 *
 *   const client = GTOClient.create({ baseUrl: 'http://127.0.0.1:8787' });
 *   const r = await client.ask(state);
 *   if (r.ok) label.textContent = r.teaching.headline;
 *
 * 两种模式：
 *   create(opts)       走 HTTP，适合跨进程 / 跨语言
 *   createLocal()      同进程直调引擎，适合 Node 服务端或浏览器
 *
 * 本地模式必须显式选择。绝不做「HTTP 失败就偷偷本地算」——
 * 那样日志里看到的全是正确结果，但实际链路早就断了。
 * ---------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../engine/gto-engine.js'),
      require('../server/validate.js'),
      require('../server/enrich.js')
    );
  } else {
    root.GTOClient = factory(root.GTOEngine, root.GTOValidate, root.GTOEnrich);
  }
})(typeof self !== 'undefined' ? self : this, function (engine, VALIDATE, ENRICH) {
  'use strict';

  var DEFAULT_BASE = 'http://127.0.0.1:8787';

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function netError(message, cause) {
    return {
      ok: false,
      error: {
        code: 'E_NETWORK',
        message: message,
        hint: '确认服务已启动：node server/gto-server.js；检查 baseUrl 端口是否一致',
        field: null
      },
      cause: cause || null
    };
  }

  /* ------------------------------------------------------------------ */
  /* HTTP 客户端                                                         */
  /* ------------------------------------------------------------------ */

  function create(opts) {
    opts = opts || {};
    var base = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    var timeout = typeof opts.timeout === 'number' ? opts.timeout : 10000;
    var retries = typeof opts.retries === 'number' ? opts.retries : 1;
    var token = opts.token || null;
    var onError = typeof opts.onError === 'function' ? opts.onError : null;
    var fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);

    if (!fetchImpl) {
      throw new Error('当前环境没有 fetch，请传入 opts.fetch');
    }

    function headers() {
      var h = { 'Content-Type': 'application/json' };
      if (token) h['Authorization'] = 'Bearer ' + token;
      return h;
    }

    /**
     * 单次 HTTP 请求。返回 { status, json }；网络层错误抛出带 status=0 的对象。
     */
    function requestOnce(method, path, payload) {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ac ? setTimeout(function () { ac.abort(); }, timeout) : null;

      var init = { method: method, headers: headers() };
      if (payload !== undefined) init.body = JSON.stringify(payload);
      if (ac) init.signal = ac.signal;

      return fetchImpl(base + path, init)
        .then(function (res) {
          return res.text().then(function (text) {
            var json = null;
            try { json = JSON.parse(text); } catch (e) { /* 保留 null */ }
            return { status: res.status, json: json, text: text };
          });
        })
        .then(function (r) {
          if (timer) clearTimeout(timer);
          return r;
        })
        .catch(function (e) {
          if (timer) clearTimeout(timer);
          var err = new Error(e && e.name === 'AbortError'
            ? '请求超时（' + timeout + 'ms）'
            : '网络请求失败：' + (e && e.message ? e.message : e));
          err.status = 0;
          err.cause = e;
          throw err;
        });
    }

    /** 带重试的请求，永远 resolve 成统一的响应对象 */
    function call(method, path, payload) {
      var attempt = 0;

      function next() {
        return requestOnce(method, path, payload).then(function (r) {
          // 5xx 且还有重试额度：退避后重试
          if (r.status >= 500 && attempt < retries) {
            attempt++;
            return sleep(150 * attempt * attempt).then(next);
          }

          if (r.json) return r.json;

          // 非 JSON 响应（多半是打到了静态页而不是接口）
          return {
            ok: false,
            error: {
              code: 'E_BAD_RESPONSE',
              message: '服务返回的不是 JSON（HTTP ' + r.status + '）',
              hint: 'baseUrl 可能指向了静态站点，或端口被别的进程占用',
              field: null
            }
          };
        }).catch(function (e) {
          if (attempt < retries) {
            attempt++;
            return sleep(150 * attempt * attempt).then(next);
          }
          var out = netError(e.message, e.cause || null);
          if (onError) out = onError(out) || out;
          return out;
        });
      }

      return next();
    }

    var api = {
      baseUrl: base,

      /** 健康检查 */
      health: function () {
        return call('GET', '/v1/health');
      },

      /** 字段与枚举说明 */
      meta: function () {
        return call('GET', '/v1/meta');
      },

      /** 预设样例 */
      examples: function () {
        return call('GET', '/v1/examples');
      },

      /**
       * 分析一手牌。
       * @param {object} state hand state
       * @param {object} [o] { teaching:false } 可关掉教学层
       * @returns {Promise<object>} 与服务端响应体一致
       */
      ask: function (state, o) {
        o = o || {};
        var payload = JSON.parse(JSON.stringify(state || {}));
        if (o.teaching === false && payload.teaching === undefined) {
          // 单条接口固定返回 teaching，用 batch 单条来略过
          return call('POST', '/v1/advise/batch', { hands: [payload], teaching: false })
            .then(function (r) {
              if (!r.ok) return r;
              var first = r.results && r.results[0];
              if (!first) return { ok: false, error: { code: 'E_BAD_RESPONSE', message: '空结果' } };
              return first;
            });
        }
        return call('POST', '/v1/advise', payload);
      },

      /**
       * 批量分析。
       * @param {Array} hands
       * @param {object} [o] { seed, iterations, teaching }
       */
      batch: function (hands, o) {
        o = o || {};
        var payload = { hands: hands || [] };
        if (o.seed !== undefined) payload.seed = o.seed;
        if (o.teaching === false) payload.teaching = false;
        if (o.iterations !== undefined) payload.opts = { iterations: o.iterations };
        return call('POST', '/v1/advise/batch', payload);
      },

      /**
       * 只要一句话结论。失败时返回错误码而不是抛异常。
       */
      headline: function (state) {
        return api.ask(state).then(function (r) {
          if (!r.ok) return '[' + (r.error ? r.error.code : 'E_UNKNOWN') + '] '
            + (r.error ? r.error.message : '未知错误');
          return r.teaching ? r.teaching.headline : r.decision.actionCN;
        });
      }
    };

    return api;
  }

  /* ------------------------------------------------------------------ */
  /* 本地客户端                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 同进程调用，不经过网络。
   * 适合：游戏服务端、Electron 客户端、离线训练工具。
   */
  function createLocal(opts) {
    opts = opts || {};
    var defaultOpts = {
      teaching: opts.teaching !== false,
      seed: opts.seed
    };

    function analyse(raw) {
      if (!VALIDATE || !ENRICH) {
        return {
          ok: false,
          error: {
            code: 'E_NO_DEPENDENCY',
            message: '本地模式需要同时加载 validate.js 与 enrich.js',
            hint: '在页面里依次引入 engine/gto-engine.js、server/validate.js、server/enrich.js'
          }
        };
      }

      var v = VALIDATE.validate(raw);
      if (!v.ok) {
        return {
          ok: false,
          error: v.errors[0],
          errors: v.errors,
          warnings: v.warnings
        };
      }

      var seed = (raw && raw.seed !== undefined && raw.seed !== null && raw.seed !== '')
        ? raw.seed : defaultOpts.seed;

      var decision;
      var original = Math.random;
      if (seed !== null && seed !== undefined) {
        var n = typeof seed === 'number'
          ? (Math.abs(Math.floor(seed)) >>> 0)
          : (function (s) {
            var h = 2166136261 >>> 0;
            s = String(s);
            for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
            return h >>> 0;
          })(seed);
        var a = n;
        Math.random = function () {
          a = (a + 0x6D2B79F5) >>> 0;
          var t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      try {
        decision = engine.advise(v.value);
      } catch (e) {
        return {
          ok: false,
          error: { code: 'E_ENGINE', message: e.message, hint: null, field: null }
        };
      } finally {
        Math.random = original;
      }

      var st = v.value;
      var out = {
        ok: true,
        local: true,
        apiVersion: VALIDATE.API_VERSION,
        engineVersion: engine.version,
        seed: seed === undefined ? null : seed,
        input: {
          street: st.street,
          hero: {
            pos: st.hero.pos,
            cards: st.hero.cards.map(engine.cardStr),
            stack: st.hero.stack,
            invested: st.hero.invested
          },
          board: st.boardCards.map(engine.cardStr),
          pot: st.pot,
          toCall: st.toCall,
          handClass: engine.handClass(st.hero.cards[0], st.hero.cards[1])
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

      if (defaultOpts.teaching) out.teaching = ENRICH.enrich(st, decision);
      return out;
    }

    return {
      local: true,
      ask: function (state) {
        return Promise.resolve(analyse(state));
      },
      askSync: analyse,
      batch: function (hands, o) {
        o = o || {};
        var results = (hands || []).map(function (h, i) {
          var merged = Object.assign({}, h);
          if (merged.seed === undefined && o.seed !== undefined) {
            merged.seed = String(o.seed) + '#' + i;
          }
          var r = analyse(merged);
          return Object.assign({ index: i }, r);
        });
        var okCount = results.filter(function (r) { return r.ok; }).length;
        return Promise.resolve({
          ok: true,
          count: results.length,
          okCount: okCount,
          failCount: results.length - okCount,
          results: results
        });
      },
      headline: function (state) {
        var r = analyse(state);
        if (!r.ok) return '[' + r.error.code + '] ' + r.error.message;
        return r.teaching ? r.teaching.headline : r.decision.actionCN;
      }
    };
  }

  return { create: create, createLocal: createLocal, DEFAULT_BASE: DEFAULT_BASE };
});
