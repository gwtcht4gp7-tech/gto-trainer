/*!
 * prng.js — 让 Monte Carlo 可复现
 * ---------------------------------------------------------------
 * 引擎内部用 Math.random() 做权益抽样。同一手牌连算两次，
 * 权益会差 ±1% 左右。对教学没问题，但对接口不行：
 *
 *   - 复盘模块要对比「我这手 vs 基线」，抖动会被误读成决策差异
 *   - 自动化测试没法断言具体数值
 *   - 前端每次刷新结果微变，用户会以为有 bug
 *
 * 做法：调用引擎前把 Math.random 换成带种子的 PRNG，算完恢复。
 * 引擎是纯同步的（没有任何 await），所以不存在并发污染。
 * ---------------------------------------------------------------
 */
'use strict';

/** mulberry32：32 位状态，速度快，分布对抽样来说足够均匀 */
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串种子 -> 32 位整数（FNV-1a），让 seed:"hand-42" 也能用 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 任意 seed（数字或字符串）-> 32 位无符号整数 */
function toSeedInt(seed) {
  if (typeof seed === 'number' && isFinite(seed)) return (Math.abs(Math.floor(seed)) >>> 0);
  return hashSeed(String(seed));
}

/**
 * 在固定种子下执行 fn。fn 必须是同步的。
 * 若 seed 为 null/undefined，直接用原生随机，不做替换。
 */
function withSeed(seed, fn) {
  if (seed === null || seed === undefined) return fn();
  const original = Math.random;
  Math.random = mulberry32(toSeedInt(seed));
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

module.exports = { mulberry32, hashSeed, toSeedInt, withSeed };
