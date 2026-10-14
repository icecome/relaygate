'use strict';
/**
 * lib/rtk/applyFilter.js —— 过滤器唯一被允许失败的地方。
 *
 * 过滤器是对「工具碰巧打印出来的任何东西」做纯字符串变换，所以它们面对的都是没人
 * 校验过的输入：截断的 JSON、混合编码、没有正文的 hunk 头。一个抛错的过滤器必须
 * 退化成**零收益**，而绝不能退化成**坏请求** —— 本模块夹在用户回合与上游之间：
 * 这里抛出去会毁掉整个回合，用户为了在工具结果上省几个 token 而丢掉答案。
 *
 * 这也正是「失败只上报、不抛出」的原因：调用方除了把原文透传之外没有任何补救手段，
 * 而透传本来就会发生。
 *
 * @module src/lib/rtk/applyFilter.js
 */

/**
 * 对 `text` 跑一次 `fn`；当 `fn` 抛错、或返回的东西不是字符串时，原样返回 `text`。
 *
 * 非字符串检查不是防御性填充：一个返回 `undefined` 的过滤器（漏了分支）会被直接
 * 赋进请求体，而一个 `null` 的工具结果对模型来说是**另一条消息**，不是它本该概括
 * 的那段输出。
 *
 * @param {Function} fn 过滤器
 * @param {string} text 输入
 * @param {(message:string)=>void} [onError] 失败上报口。给了它，失败只回调（调用方
 *   记进 stats.notes，不打日志）；没给则退回源实现的 console.warn（走 stderr，
 *   与源实现一致），好让直接调用本函数的调用方行为不变。
 * @returns {string} 过滤结果，或原样返回的 `text`
 */
function safeApply(fn, text, onError) {
  if (typeof fn !== 'function') return text;
  const name = fn.filterName || fn.name || 'anonymous';
  const report = (message) => {
    if (typeof onError === 'function') onError(message);
    else console.warn(`[rtk] warning: ${message}`);
  };
  try {
    const out = fn(text);
    if (typeof out !== 'string') {
      report(`filter '${name}' returned ${out === null ? 'null' : typeof out} — passing through raw output`);
      return text;
    }
    return out;
  } catch (err) {
    // Rust：eprintln!("[rtk] warning: filter panicked — passing through raw output")
    report(`filter '${name}' panicked — passing through raw output: ${err?.message || err}`);
    return text;
  }
}

module.exports = { safeApply };
