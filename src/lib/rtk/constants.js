'use strict';
/**
 * lib/rtk/constants.js —— RTK 工具输出压缩器共享的全部数值阈值与名称字符串。
 *
 * 这些值对齐 Rust 版 RTK 的默认值，而各过滤器逐字节复刻它的输出，所以这些数字是
 * **兼容面**而不是调参旋钮：改掉一个，压缩后的 `git diff` 就不再是「模型已经见过
 * 的形状」。它们集中在一个模块，是因为自动检测器与过滤器必须对同一批数值达成一致
 * —— 检测器用这个窗口判定 blob 是什么，过滤器随后用同一口径压缩它；两边阈值漂移
 * 的后果是「blob 被路由到一个会静默拒绝它的过滤器」。
 *
 * 【与源实现唯一的刻意差异：字节口径】
 * 源实现（纯 JS ESM）用 `text.length`，即 UTF-16 码元数，来衡量体量；本移植版一律
 * 改成 UTF-8 字节（`Buffer.byteLength(text, 'utf8')`）。中文下 UTF-16 码元把真实
 * 字节低估 2-3 倍，源实现报出来的「省了 N 字节」是假数。两个闸门因此重新定性：
 *
 *   - MIN_COMPRESS_SIZE：对 CJK 更**宽松**。300 个汉字的 blob 源实现只数到 300，
 *     够不着 500 于是放过；按 UTF-8 算是 900，**该压的能压到**。
 *   - RAW_CAP：对 CJK 更**严格**。6 MB 汉字的 blob 源实现只数到 6M 码元（在盖下，
 *     会被拖去跑十几个正则），按 UTF-8 算是 18 MB（在盖上，直接放过）—— 这正是
 *     盖子的本意：失控 dump 不该在请求关键路径上花延迟。
 *
 * 唯一保持「字符」口径的是 DETECT_WINDOW：它做的是形状嗅探（头部是不是
 * `diff --git`），不是体量判定，改成字节只会让检测结果与源实现漂移。
 *
 * @module src/lib/rtk/constants.js
 */

/**
 * 单个工具输出 blob 的硬上限（10 MiB，按 UTF-8 字节）。
 *
 * 超过这个量的东西已经不是「工具返回给模型的输出」，而是一次失控的 dump：在它上面
 * 跑十几个正则什么都换不来，却要在请求的关键路径上付出延迟，所以原样放过。
 */
const RAW_CAP = 10 * 1024 * 1024;

/**
 * 小于 500 字节（按 UTF-8 字节）的 blob 永不压缩。
 *
 * 每个过滤器的输出都带 marker 行（`... (N lines truncated)`）和逐文件摘要；在很小的
 * blob 上，这些 marker 比它们替换掉的内容还长，压缩会**花掉**上下文而不是省下它。
 */
const MIN_COMPRESS_SIZE = 500;

/**
 * 自动检测器只看前 1024 个**字符**。
 *
 * 工具输出会在自己的头部自报家门（`diff --git` 行、`total N` 行、npm 摘要），把窗口
 * 定死让检测对每个 blob 都是 O(1) 而不是 O(size) —— 这个省 token 的模块本身必须比
 * 它省下的 token 更便宜，否则就不值得存在。
 */
const DETECT_WINDOW = 1024;

/** 单个 hunk 的行数上限：一个 10000 行的 hunk 不得吃光整份 diff 的预算。 */
const GIT_DIFF_HUNK_MAX_LINES = 100;

/** 变更周围保留的上下文行数（Rust 对齐；JS 移植让 hunk 头部原样通过）。 */
const GIT_DIFF_CONTEXT_KEEP = 3;

/** `git log` 输出行数上限；超过它说明这段历史比本轮需要的更久远。 */
const GIT_LOG_MAX_LINES = 200;

/** dedupLog 的硬上限；长到这个程度的 blob 就是一次循环，marker 就是这么写的。 */
const DEDUP_LINE_MAX = 2000;

/** grep 压缩器的单文件匹配上限（Rust：matches.iter().take(10)）。 */
const GREP_PER_FILE_MAX = 10;

/** find 压缩器的单目录文件上限（Rust：files.iter().take(10)）。 */
const FIND_PER_DIR_MAX = 10;

/** find 压缩器的目录总数上限（Rust：dirs.iter().take(20)）。 */
const FIND_TOTAL_DIR_MAX = 20;

/** `git status` 每个分段的文件上限（Rust config::limits().status_max_files）。 */
const STATUS_MAX_FILES = 10;

/** `git status` 未跟踪文件上限（Rust config::limits().status_max_untracked）。 */
const STATUS_MAX_UNTRACKED = 10;

/** `ls` 摘要行里显示的扩展名 Top-N。 */
const LS_EXT_SUMMARY_TOP = 5;

/**
 * `ls` 在列目录之前丢掉的目录名。
 *
 * 这些是构建产物与依赖树：模型读一份项目清单时，从 40000 条 `node_modules` 里学不到
 * 任何东西，而目录本身存在这件事，一行目录名就够了。`.env` 刻意**不在**这个名单里
 * —— 它是清单有正当理由要暴露的 dotfile；而历史上的 virtualenv 目录 `env` 是按名字
 * 匹配的，不是按通配符。
 */
const LS_NOISE_DIRS = [
  'node_modules', '.git', 'target', '__pycache__',
  '.next', 'dist', 'build', '.cache', '.turbo',
  '.vercel', '.pytest_cache', '.mypy_cache', '.tox',
  '.venv', 'venv',
  'env', // Python 历史遗留的 virtualenv；.env（dotenv）刻意排除
  'coverage', '.nyc_output', '.DS_Store', 'Thumbs.db',
  '.idea', '.vscode', '.vs', '*.egg-info', '.eggs'
];

/** `tree` 输出上限（Rust 原版没有上限；这份实现保留一个上限以求稳）。 */
const TREE_MAX_LINES = 200;

/** Cursor Glob 搜索结果清单压缩器的单目录上限。 */
const SEARCH_LIST_PER_DIR_MAX = 10;

/** Cursor Glob 搜索结果清单压缩器的目录总数上限。 */
const SEARCH_LIST_TOTAL_DIR_MAX = 20;

/** 智能截断兜底保留的头部行数。 */
const SMART_TRUNCATE_HEAD = 120;

/** 智能截断兜底保留的尾部行数。 */
const SMART_TRUNCATE_TAIL = 60;

/**
 * 智能截断只在超过 250 行时启用。
 *
 * 低于这个量，头+尾窗口加上它的 marker 并不能稳定地比原文更小；而模型读完一份
 * 200 行的日志是有收益的。
 */
const SMART_TRUNCATE_MIN_LINES = 250;

/**
 * 前 100 行里必须有这个比例的 `N|` 行，blob 才算是「编号文件转储」。
 * 0.7 容忍少数折行或未编号的行。
 */
const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

/**
 * 过滤器名称字符串。
 *
 * 这些名字会出现在 `stats.filters` 里，也是 Rust 工具打印的同一批字符串，因此它们
 * 属于**移植过来的契约**，而不是给人看的显示文案。
 */
const FILTERS = {
  GIT_DIFF: 'git-diff',
  GIT_STATUS: 'git-status',
  GIT_LOG: 'git-log',
  GREP: 'grep',
  FIND: 'find',
  LS: 'ls',
  TREE: 'tree',
  DEDUP_LOG: 'dedup-log',
  SMART_TRUNCATE: 'smart-truncate',
  READ_NUMBERED: 'read-numbered',
  SEARCH_LIST: 'search-list',
  BUILD_OUTPUT: 'build-output'
};

module.exports = {
  RAW_CAP,
  MIN_COMPRESS_SIZE,
  DETECT_WINDOW,
  GIT_DIFF_HUNK_MAX_LINES,
  GIT_DIFF_CONTEXT_KEEP,
  GIT_LOG_MAX_LINES,
  DEDUP_LINE_MAX,
  GREP_PER_FILE_MAX,
  FIND_PER_DIR_MAX,
  FIND_TOTAL_DIR_MAX,
  STATUS_MAX_FILES,
  STATUS_MAX_UNTRACKED,
  LS_EXT_SUMMARY_TOP,
  LS_NOISE_DIRS,
  TREE_MAX_LINES,
  SEARCH_LIST_PER_DIR_MAX,
  SEARCH_LIST_TOTAL_DIR_MAX,
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_TAIL,
  SMART_TRUNCATE_MIN_LINES,
  READ_NUMBERED_MIN_HIT_RATIO,
  FILTERS,
};
