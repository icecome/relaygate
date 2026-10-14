'use strict';
/**
 * lib/rtk/hitLine.js —— 搜索输出行（`file:line:content`）的解析。
 *
 * 移植自上游 PR #285（9a6733313c45ed29850fcb8f452130b7cf63a513），它修的是 issue #280。
 *
 * 保留它「识别盘符的分割」与「保守的候选判定」这两条。单独一行看起来像路径，并不
 * 证明整个工具结果就是搜索结果：网页内容里同样会出现时间戳、host:port 文本和源码
 * 引用。因此每一行非空内容都必须通过校验才允许改写；拿不准就整块保留。反过来，
 * **不要**用严格的候选判定去丢匹配行：真实文件名可以带空格，也可以没有扩展名
 * （README、Makefile）。
 *
 * @module src/lib/rtk/hitLine.js
 */

/** 行首的 `C:` / `c:\` / `C:/` —— 这是盘符，不是文件名。 */
const RE_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/** 路径分隔符或点扩展名：让 file 字段看起来像路径的东西。 */
const RE_PATH_SHAPE = /[\\/.]/;

/** 仅用于保守的检测种子；不是对已解析文件名的限制。 */
const RE_PATH_REJECT = /\s/;

/**
 * 把一行候选切成三个字段，但不判断它们是否可信。检测用 isGrepHit；
 * 整份输出解析时只校验行号字段是不是数字，不因此否掉合法的文件名。
 *
 * 「从盘符之后开始找冒号」正是让这个切分在 Windows 上也能工作的原因：它随后找到的
 * 两个冒号才是真正的字段分隔符。
 *
 * @param {string} line 工具输出的一行
 * @returns {{file:string, line:string, content:string}|null} 三个字段；该行少于两个
 *   冒号、不可能是一条命中时返回 null
 */
function splitGrepHit(line) {
  const start = RE_DRIVE_PREFIX.test(line) ? 2 : 0;
  const first = line.indexOf(':', start);
  if (first === -1) return null;
  const second = line.indexOf(':', first + 1);
  if (second === -1) return null;
  return {
    file: line.slice(0, first),
    line: line.slice(first + 1, second),
    content: line.slice(second + 1),
  };
}

/**
 * 这一行是不是 `file:N:content`（行号是数字、file 字段有可能真的指向一个文件）？
 *
 * 这只是保守的**检测种子**，永远不是工具身份的证明：带点的 host:port 行同样能匹配。
 * 要改写之前必须先走 parseGrepOutput。
 *
 * @param {string} line
 * @returns {boolean}
 */
function isGrepHit(line) {
  const hit = splitGrepHit(line);
  if (hit === null) return false;
  if (!/^\d+$/.test(hit.line)) return false;
  if (hit.file === '' || RE_PATH_REJECT.test(hit.file)) return false;
  return RE_PATH_SHAPE.test(hit.file);
}

/**
 * 解析完整的搜索输出；只要有任何一行说不通，就拒绝整个 blob。严格的检测器适合用来
 * 选过滤器，但**不能**拿它当丢弃行的理由：真实文件名可以带空格、也可以没有扩展名
 * （README、Makefile）。空行分隔符无害；任何其它无法解析的行都会让输入原样保留。
 * 检查的是完整文本，包括检测窗口之外的行。
 *
 * @param {string} text
 * @returns {Array<{file:string,line:string,content:string}>|null}
 */
function parseGrepOutput(text) {
  const hits = [];
  for (const row of text.split('\n')) {
    if (row.trim() === '') continue;
    const hit = splitGrepHit(row);
    if (hit === null || hit.file.trim() === '' || !/^\d+$/.test(hit.line)) return null;
    hits.push(hit);
  }
  return hits.length > 0 ? hits : null;
}

module.exports = { splitGrepHit, isGrepHit, parseGrepOutput };
