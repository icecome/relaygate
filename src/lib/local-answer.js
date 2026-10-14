'use strict';
/**
 * lib/local-answer.js —— 五类「Claude Code 会问、而答案已经在请求体里」的提问，本地直接作答。
 *
 * 这五类请求的共同点：问题固定，答案就在请求体里（额度探针、权限提示背后的命令前缀、
 * 会话标题、suggestion 模式那一轮、文件路径提取）。把它转给上游 = 用上游配额和一整轮
 * 往返去换一个**唯一正确答案**。下面每个检测器只读请求形状并返回定值；形状不匹配的
 * 请求一个字节都不改，由调用方照常转发。
 *
 * 移植自参照项目 `src/local-optimize.js`（纯 JS ESM），它又移植自 Python 网关的
 * `api/optimization_handlers.py`、`api/detection.py`、`api/command_utils.py`。
 * **触发条件、求值顺序、回退行为按原样保留**：两个网关对同一请求必须给出同一答案，
 * 所以这里一个判定式都不「顺手优化」。
 *
 * ## 相对源实现的两处**刻意差异**
 *
 * 1. **绝不写假 usage**。源实现在各检测器里塞了 `{ input: 10, output: 5 }` 之类的假
 *    token 常量（源 :314/325/337/345/369），并把它们一路带到响应体的 `usage` 里。
 *    本项目明确拒绝：假 token 会污染账单标定回归（`src/models/pricing-calib.js` 的
 *    样本直接来自 traffic 日志），所以本模块**返回值里没有任何 `usage` 字段**。
 *    记账由调用方负责，记的是「0 token + 在 traffic 日志里打标」。
 *    同理，源里只为包装假 usage 而存在的 `tryOptimizations` / `toMessagesResponse`
 *    没有移植——它们剩下的价值（选模型、造 response id、`stop_reason`）全在调用方。
 * 2. **任何检测器内部出错都当作「没命中」**。源实现没有显式处理，一旦某个检测器
 *    抛错，整个请求就失败。本地应答只是优化，绝不能因为它让一个本该成功的请求 500，
 *    所以每个检测器各自 try/catch：出错即视为**该检测器**未命中，继续试下一个
 *    （见 `firstAnswer`），函数最外层再兜一层返回 null（见 `detectLocalAnswer`）。
 *
 * `note` 字段形参上留着但本模块不填：没有哪个字段是源实现里有、而 `kind`/`text`
 * 又表达不了的（打标是调用方的事）。
 *
 * @module src/lib/local-answer.js
 */

/**
 * 求值顺序：由省到贵、由常见到罕见。额度探针是「一个整数 + 一次子串判断」，
 * 排在最前就能短路掉后面那几个要解析命令行的检测器。
 */
const OPTIMIZATIONS = ['quota', 'prefix', 'title', 'suggestion', 'filepath'];

/** 第二个词才是操作名的命令，所以两个词一起算前缀。 */
const TWO_WORD_COMMANDS = new Set(['git', 'npm', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'yarn']);

/** 只列名字的命令：mock 没有文件内容可以指向，所以提取不出路径。 */
const LISTING_COMMANDS = new Set(['ls', 'dir', 'find', 'tree', 'pwd', 'cd', 'mkdir', 'rmdir', 'rm']);

/** 读内容的命令：它们的非 flag 参数就是文件路径。 */
const READING_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type']);

/** 会吃掉后一个 token 的 grep flag；`-e`/`-f` 同时还提供 pattern。 */
const GREP_FLAGS_WITH_ARGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C']);

/** shell 风格的 `NAME=value` 词，出现在命令前面的那种形状。 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/;

/** 命令里没有路径时，filepath 提取给出的定值。 */
const EMPTY_FILEPATHS = '<filepaths>\n</filepaths>';

/**
 * @typedef {object} LocalAnswer
 * @property {'quota'|'prefix'|'title'|'suggestion'|'filepath'} kind - 命中的是哪一项优化
 * @property {string} text - 要下发给客户端的正文（**不含** usage，见模块头差异 1）
 * @property {string} [stopReason] - 由 `detectLocalAnswer` 填 `end_turn`
 */

/**
 * 把消息体或 system block 列表拼成文本。
 *
 * block 之间**不插分隔符**是刻意的：下面的检测器全是子串判断，插一个分隔符可能
 * 恰好切断一个跨 block 的短语。任何带非空 `text` 的 block 都算，不看它的 `type`——
 * Python 侧的提取器读的是属性，不是类型。
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (typeof block?.text === 'string' && block.text !== '') text += block.text;
  }
  return text;
}

/** 顶部 system 文本 + 每一条内联 system 消息，用换行连接。 */
function systemText(request) {
  const parts = [];
  const top = textOf(request?.system);
  if (top !== '') parts.push(top);
  for (const message of request?.messages ?? []) {
    if (message?.role !== 'system') continue;
    const text = textOf(message.content);
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 唯一的那一轮对话 user 消息，忽略 system 上下文。
 *
 * 没有、或形状不满足这些优化所需时返回 `undefined`：第二轮 user、assistant 轮、
 * 工具回复，都算「不满足」。
 */
function singleUserTurn(request) {
  let turn;
  for (const message of request?.messages ?? []) {
    if (message?.role === 'system') continue;
    if (message?.role !== 'user' || turn !== undefined) return undefined;
    turn = message;
  }
  return turn;
}

/** 请求是否声明了 tools——标题与 filepath 这类提问永远不带 tools 的那种形状。 */
function hasTools(request) {
  const tools = request?.tools;
  return Array.isArray(tools) ? tools.length > 0 : Boolean(tools);
}

/** 引号外能被反斜杠转义的字符；其它位置上的 `\` 是路径分隔符。 */
const ESCAPABLE = new Set([' ', '\t', '\n', '\r', '\f', '\v', "'", '"']);

/**
 * 把一个命令行切成 shell 词，不执行任何东西。
 *
 * 只建模权限提示里会出现的形状：空白分隔、单双引号（引号被去掉，所以带引号的路径
 * 到手里就是路径）、反斜杠转义。反斜杠**只在空白或引号前**才算转义，在其它字符前
 * 是字面量，于是 Windows 路径（`type C:\notes\todo.md`）能活下来——按 POSIX 读法
 * 会把 `\n` 悄悄吃掉。引号不闭合时按 `shlex.split` 的语义抛错，让调用方走它们那个
 * 「朴素切分」的回退（对 shell 自己也会拒绝的一行，不猜引号）。
 */
function shellWords(command) {
  const words = [];
  let word = null;
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = ''; continue; }
      if (char === '\\') {
        const next = command[index + 1];
        // 双引号内 shell 只剥掉它赋予了含义的字符前的反斜杠；其它情况原样保留。
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          word += next;
          index += 1;
        } else word += '\\';
        continue;
      }
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      if (word === null) word = '';
      continue;
    }
    if (char === '\\' && ESCAPABLE.has(command[index + 1])) {
      if (word === null) word = '';
      word += command[index + 1];
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
      if (word !== null) { words.push(word); word = null; }
      continue;
    }
    if (word === null) word = '';
    word += char;
  }
  if (quote !== '') throw new Error('no closing quotation');
  if (word !== null) words.push(word);
  return words;
}

/** 一个词是不是 shell 风格的环境变量赋值（`FOO=bar`、`FOO="a b"`）。 */
function isEnvAssignment(part) {
  return ENV_ASSIGNMENT.test(part);
}

/** 去掉开头的环境变量赋值后剩下的命令词。 */
function stripEnvAssignments(parts) {
  let start = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isEnvAssignment(parts[index])) break;
    start = index + 1;
  }
  return parts.slice(start);
}

/**
 * 权限提示问的那个前缀：`git`、`git commit`、`npm install`——或者无法推导的原因。
 *
 * 命令替换会执行第二条命令，而前缀只是权限对话框上的标签、不是拿来执行的东西，
 * 所以带命令替换的行**报原因而不解析**。
 *
 * @param {string} command 原始命令行
 * @returns {string} 前缀、`none`、或 `command_injection_detected`
 */
function extractCommandPrefix(command) {
  const text = typeof command === 'string' ? command : '';
  if (text.includes('`') || text.includes('$(')) return 'command_injection_detected';

  let parts;
  try {
    parts = shellWords(text);
  } catch {
    // shell 自己会拒绝这一行；按 Python 网关 shlex 回退的做法用空白切分作答，
    // 而不是去猜引号。
    const fallback = stripEnvAssignments(text.split(/\s+/).filter(part => part !== ''));
    return fallback.length > 0 ? fallback[0] : 'none';
  }
  if (parts.length === 0) return 'none';

  const env = [];
  let start = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isEnvAssignment(parts[index])) break;
    env.push(parts[index]);
    start = index + 1;
  }
  if (start >= parts.length) return 'none';

  const commandParts = parts.slice(start);
  const first = commandParts[0];
  if (TWO_WORD_COMMANDS.has(first) && commandParts.length > 1) {
    const second = commandParts[1];
    if (!second.startsWith('-')) return `${first} ${second}`;
    return first;
  }
  // 从 Python 网关照搬的非对称行为：单词命令保留 env 前缀（`FOO=1 ls`），而上面
  // 的双词分支把它丢掉（`FOO=1 git status` 答 `git status`）。两者都只是对话框标签，
  // 不是要执行的命令——保持原样，免得两个网关对同一请求给出不同标签。
  return env.length === 0 ? first : `${env.join(' ')} ${first}`;
}

/**
 * 命令读取的文件路径，装进 Claude Code 解析的 `<filepaths>` 块。
 *
 * listing 命令只是列名字、不读内容，所以没有可提取的东西，块是空的；reading 命令的
 * 非 flag 参数就是路径；grep 的 pattern 不是路径，跳过。
 *
 * 收下 `output` 是因为调用方手里正好有请求的 `Output:` 段（Python 侧签名也收），但
 * **从不读它**：一条命令的读取目标就是它自己的参数。截断那一段是检测器的活。
 *
 * @param {string} command `Command:` 段
 * @param {string} [output] 请求的 `Output:` 段（不使用，仅为签名一致）
 * @returns {string} `<filepaths>` 块
 */
function extractFilepathsFromCommand(command, output) {
  void output;
  const text = typeof command === 'string' ? command : '';
  let parts;
  try {
    parts = shellWords(text);
  } catch {
    return EMPTY_FILEPATHS;
  }
  const commandParts = stripEnvAssignments(parts);
  if (commandParts.length === 0) return EMPTY_FILEPATHS;

  const base = commandParts[0].split('/').pop().split('\\').pop().toLowerCase();
  if (LISTING_COMMANDS.has(base)) return EMPTY_FILEPATHS;
  if (READING_COMMANDS.has(base)) {
    return filepathBlock(commandParts.slice(1).filter(part => !part.startsWith('-')));
  }
  if (base !== 'grep') return EMPTY_FILEPATHS;

  // `-e pattern` / `--regexp pattern` 提供了 pattern，那剩下的每个位置参数都是路径；
  // 否则第一个位置参数就是 pattern，其余才是路径。`--regexp=pattern` 不占单独一个词。
  let patternViaFlag = false;
  const positional = [];
  let skipNext = false;
  for (const part of commandParts.slice(1)) {
    if (skipNext) { skipNext = false; continue; }
    if (!part.startsWith('-')) { positional.push(part); continue; }
    if (part === '-e' || part === '-f' || part === '--regexp') {
      patternViaFlag = true;
      skipNext = true;
    } else if (part.startsWith('--regexp=')) {
      patternViaFlag = true;
    } else if (GREP_FLAGS_WITH_ARGS.has(part)) {
      skipNext = true;
    }
  }
  return filepathBlock(patternViaFlag ? positional : positional.slice(1));
}

/** 一个列出这些路径的 `<filepaths>` 块；没有路径时是空块。 */
function filepathBlock(paths) {
  return paths.length === 0 ? EMPTY_FILEPATHS : `<filepaths>\n${paths.join('\n')}\n</filepaths>`;
}

/**
 * `Output:` 段在第一个标签或空行处结束。
 *
 * 这一段是命令的 stdout，Claude Code 的提示词会在它后面追加自己的标记，尾部永远不是
 * 输出的一部分。在答案里看不出来（路径来自命令），保留是为了让这一段的截断位置与
 * Python 检测器**完全一致**。
 */
function truncateOutput(output) {
  let text = output;
  for (const marker of ['<', '\n\n']) {
    if (text.includes(marker)) text = text.split(marker)[0].trim();
  }
  return text;
}

/** `max_tokens: 1` + 唯一一轮 user 且在说 "quota"，就是额度探针。 */
function quotaAnswer(request) {
  const message = singleUserTurn(request);
  if (message === undefined) return null;
  const maxTokens = request?.max_tokens;
  // Python 侧模型会把线上的数字字符串强制转换；两种拼写都收。
  if (!(maxTokens === 1 || maxTokens === '1')) return null;
  if (!textOf(message.content).toLowerCase().includes('quota')) return null;
  return { text: 'Quota check passed.' };
}

/** policy spec + `Command:` 段，就是权限前缀提问。 */
function prefixAnswer(request) {
  const message = singleUserTurn(request);
  if (message === undefined) return null;
  const content = textOf(message.content);
  if (!content.includes('<policy_spec>') || !content.includes('Command:')) return null;
  // 最后一个标记胜出：它上面的 policy spec 里自己也可能引用这个词。
  const start = content.lastIndexOf('Command:') + 'Command:'.length;
  return { text: extractCommandPrefix(content.slice(start).trim()) };
}

/** 标题提示词靠 system 文本识别，且从不带 tools。 */
function titleAnswer(request) {
  if (hasTools(request)) return null;
  const system = systemText(request).toLowerCase();
  if (!system.includes('title')) return null;
  const sentenceCase = system.includes('sentence-case title');
  const jsonField = system.includes('return json') && system.includes('field')
    && (system.includes('coding session') || system.includes('this session'));
  if (!sentenceCase && !jsonField) return null;
  return { text: 'Conversation' };
}

/** suggestion 模式的标记可能在任意一条 user 消息里；答案就是「没有建议」。 */
function suggestionAnswer(request) {
  for (const message of request?.messages ?? []) {
    if (message?.role !== 'user') continue;
    if (textOf(message.content).includes('[SUGGESTION MODE:')) {
      // text 为空字符串是**源语义**而不是遗漏：这一轮的正确答案是「无建议」，
      // 下发一句话本身就是错的。见本文件头「刻意差异」。
      return { text: '' };
    }
  }
  return null;
}

/** 一对 `Command:`/`Output:` 在问文件路径，且没有 tools 掺和。 */
function filepathAnswer(request) {
  const message = singleUserTurn(request);
  if (message === undefined || hasTools(request)) return null;
  const content = textOf(message.content);
  if (!content.includes('Command:') || !content.includes('Output:')) return null;

  const lower = content.toLowerCase();
  const userNamesFilepaths = lower.includes('filepaths') || lower.includes('<filepaths>');
  const system = systemText(request).toLowerCase();
  const systemAsksForPaths = system.includes('extract any file paths') || system.includes('file paths that this command');
  if (!userNamesFilepaths && !systemAsksForPaths) return null;

  const start = content.indexOf('Command:') + 'Command:'.length;
  const marker = content.indexOf('Output:', start);
  if (marker === -1) return null;
  const command = content.slice(start, marker).trim();
  const output = truncateOutput(content.slice(marker + 'Output:'.length).trim());
  return { text: extractFilepathsFromCommand(command, output) };
}

/** 每个优化项对应的检测器，键名就是 {@link OPTIMIZATIONS} 用的名字。 */
const DETECTORS = {
  quota: quotaAnswer,
  prefix: prefixAnswer,
  title: titleAnswer,
  suggestion: suggestionAnswer,
  filepath: filepathAnswer,
};

/**
 * 按求值顺序返回第一个命中的优化项，没有则 null。
 *
 * 每个检测器独立 try/catch：某个判定式内部出错（畸形请求体、代理对象上的
 * throwing getter、意料之外的类型）只让**它自己**按「没命中」处理，后面的检测器
 * 照常继续试。本地应答是优化，不能因为一个检测器坏了就丢掉这次本地作答的机会，
 * 更不能让请求失败。
 */
function firstAnswer(request, enabled) {
  for (const kind of OPTIMIZATIONS) {
    if (enabled?.[kind] === false) continue;
    let answer = null;
    try {
      answer = DETECTORS[kind](request);
    } catch {
      // 该检测器出错 ⇒ 当作没命中，继续下一个（见文件头「刻意差异」2）。
      continue;
    }
    if (answer !== null) return { kind, ...answer };
  }
  return null;
}

/**
 * 哪一项优化会应答这个请求（只看 kind，不产生正文）。
 *
 * @param {object} request 原始 Anthropic 形态请求体
 * @param {{quota?: boolean, prefix?: boolean, title?: boolean, suggestion?: boolean, filepath?: boolean}} [enabled]
 *   - 不写某一项就是开着；写 `false` 才关掉
 * @returns {'quota'|'prefix'|'title'|'suggestion'|'filepath'|null}
 */
function detectOptimization(request, enabled) {
  try {
    return firstAnswer(request, enabled)?.kind ?? null;
  } catch {
    return null;
  }
}

/**
 * 命中就返回本地应答，未命中返回 null（调用方照常转发上游）。
 *
 * never-throw 的两层含义：`firstAnswer` 里每个检测器各自兜底，这里再对整个函数兜一层
 * ——万一出错路径不在检测器自己的 try 里，结果也只是「没命中」，而不是让一个本该成功
 * 的请求 500。
 *
 * @param {object} request 客户端**原始** Anthropic 形态请求体（`{model, system, messages, tools, ...}`；
 *   `messages[].content` 可能是 block 数组，`system` 可能是字符串或 block 数组）
 * @param {{enabled?: object}} [options] `enabled[kind] === false` 时跳过该项优化
 * @returns {LocalAnswer|null} `kind` ∈ OPTIMIZATIONS，`text` 是下发给客户端的正文
 */
function detectLocalAnswer(request, options) {
  try {
    const answer = firstAnswer(request, options?.enabled);
    if (answer === null) return null;
    // stopReason 固定 end_turn：本地应答就是一轮完整回答，源实现包装响应时同样
    // 硬编码 end_turn。调用方若要别的语义，在外面覆盖即可。
    return { kind: answer.kind, text: answer.text, stopReason: 'end_turn' };
  } catch {
    return null;
  }
}

module.exports = {
  detectLocalAnswer,
  OPTIMIZATIONS,
  // 便于单测 / 接线的内部件：名字与源实现保持一致。
  detectOptimization,
  extractCommandPrefix,
  extractFilepathsFromCommand,
};
