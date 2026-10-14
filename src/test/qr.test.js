'use strict';
/**
 * test/qr.test.js —— 零依赖二维码编码器的移植保真与结构正确性。
 * 运行：node src/test/qr.test.js
 *
 * ## 为什么这些断言长这样
 *
 * `src/lib/qr.js` 是从参考项目 `dsh-our-free-model` 的
 * `vendor/channel-pack/src/raccoon-qr.ts`（MIT）转译 + 机械规范化的移植。
 * 二维码编码**错了不会报错，只会扫不出来** —— 而它唯一的用途就是让用户扫码
 * 登录 Raccoon。所以这里不满足于「函数能跑通」，而要钉住三件事：
 *
 *   1. **与参考实现逐位一致**：黄金哈希由**参考实现**产出（不是由本实现自证），
 *      覆盖版本 1–10 的每个长度边界、真实登录 URL 形态、UTF-8 多字节、空串。
 *      任何算法改动（掩码选择、纠错码字、格式位）都会让某条哈希变化。
 *   2. **结构正确**：定位图案、定时图案、尺寸公式（17 + 4×version）—— 这些是
 *      扫码器认码的前提，哈希对不上时也能指出「哪一类结构坏了」。
 *   3. **容量边界**：213 字节可编码、214 字节**必须抛错**。静默产出坏码比抛错
 *      糟得多（用户会拿一个扫不出来的码反复试）。
 *
 * ## 黄金哈希是怎么来的（需要重新生成时照此做）
 *
 * 参考实现不在本仓库（`dsh-our-free-model` 是独立仓库）。重新生成的步骤：
 *   1. 取该仓库的 `vendor/channel-pack/src/raccoon-qr.ts`；
 *   2. 用 typescript 转译成 CommonJS（`tsc ref.ts --module commonjs`）；
 *   3. 对与下方 `GOLDENS` 相同的输入调用 `buildQrMatrix`，把
 *      `modules` 按行拼成 0/1 位串，再取 `sha256(bits)` 的前 16 位十六进制；
 *   4. 覆盖回本文件。
 * 转译产物**不要**提交进本仓库——它只是对拍工具。
 */
const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

// 本文件不写任何状态，但保留与其他测试文件一致的隔离声明：
// 一旦将来有人在此追加涉及 config/store 的用例，隔离已经就位。
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `qr-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('qr');

const qr = require('../lib/qr');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

/** 与生成黄金值时完全相同的摘要口径。 */
function digest(modules) {
  const bits = modules.map((row) => row.map((v) => (v ? '1' : '0')).join('')).join('|');
  return crypto.createHash('sha256').update(bits).digest('hex').slice(0, 16);
}

/* ---------- 1. 黄金向量（由参考实现产出） ---------- */

const GOLDENS = [
  { label: 'v1-min', text: '', size: 21, sha: '626fc0aeb2918259' },
  { label: 'v1-max', text: 'A'.repeat(14), size: 21, sha: '27962c43f833201b' },
  { label: 'v2-min', text: '浣'.repeat(5), size: 25, sha: '12d3ceeadede7678' },
  { label: 'v2-max', text: 'A'.repeat(26), size: 25, sha: 'acb4cfc7b42fbd3d' },
  { label: 'v3-min', text: '浣'.repeat(9), size: 29, sha: 'a9d61034c847448c' },
  { label: 'v3-max', text: 'A'.repeat(42), size: 29, sha: '2a6d3e5a1af70e4c' },
  { label: 'v4-min', text: '浣'.repeat(15), size: 33, sha: '66a47f1d71b8f25f' },
  { label: 'v4-max', text: 'A'.repeat(62), size: 33, sha: '803bd4337fd8e759' },
  { label: 'v5-min', text: '浣'.repeat(21), size: 37, sha: 'a06bae0d2b4d3b63' },
  { label: 'v5-max', text: 'A'.repeat(84), size: 37, sha: '74f4a43ed65e496e' },
  { label: 'v6-min', text: '浣'.repeat(29), size: 41, sha: '6bc523049de167bd' },
  { label: 'v6-max', text: 'A'.repeat(106), size: 41, sha: '036a34ffafa6bb4c' },
  { label: 'v7-min', text: '浣'.repeat(36), size: 45, sha: 'a1d2872abadf40d3' },
  { label: 'v7-max', text: 'A'.repeat(122), size: 45, sha: '355cadbd866cc90c' },
  { label: 'v8-min', text: '浣'.repeat(41), size: 49, sha: '5691430064263f42' },
  { label: 'v8-max', text: 'A'.repeat(152), size: 49, sha: 'e762fe0add79125b' },
  { label: 'v9-min', text: '浣'.repeat(51), size: 53, sha: 'f1e576a6e3025a13' },
  { label: 'v9-max', text: 'A'.repeat(180), size: 53, sha: 'f25528d5e8ede7b2' },
  { label: 'v10-min', text: 'A'.repeat(181), size: 57, sha: '45fd4ad079648f64' },
  { label: 'v10-max', text: 'A'.repeat(213), size: 57, sha: '0f7a7aa31f532ae7' },
  {
    label: 'login-url-0000',
    text: 'https://xiaohuanxiong.com/login/mp?code=00000000000000000000000000000000&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91',
    size: 49,
    sha: 'd9f7a58dce897fd9',
  },
  {
    label: 'login-url-random',
    text: 'https://xiaohuanxiong.com/login/mp?code=a1b2c3d4e5f60718293a4b5c6d7e8f90&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91',
    size: 49,
    sha: 'c704775add6e6f94',
  },
  {
    label: 'login-url-ffff',
    text: 'https://xiaohuanxiong.com/login/mp?code=ffffffffffffffffffffffffffffffff&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91',
    size: 49,
    sha: '258a62c6f50a6bcb',
  },
  { label: 'utf8-1', text: '浣', size: 21, sha: 'e7a4a8bb6a87456a' },
  { label: 'utf8-20', text: '浣'.repeat(20), size: 33, sha: '19803ef16a0d7619' },
  { label: 'utf8-60', text: '浣'.repeat(60), size: 53, sha: 'bddda4f29b3ad87c' },
  { label: 'mixed-ascii-cjk', text: '商汤小浣熊 Raccoon Work 混合 mixed 内容 12345', size: 33, sha: 'a5eccf93f639433e' },
  { label: 'empty', text: '', size: 21, sha: '626fc0aeb2918259' },
];

for (const g of GOLDENS) {
  t(`黄金向量 ${g.label}（${Buffer.byteLength(g.text)} 字节 → 尺寸 ${g.size}）`, () => {
    const m = qr.buildQrMatrix(g.text);
    assert.strictEqual(m.size, g.size, `尺寸不符：期望 ${g.size}，实际 ${m.size}`);
    assert.strictEqual(digest(m.modules), g.sha, '位图与参考实现不一致（算法被改动？）');
  });
}

/* ---------- 2. 结构正确性（扫码器认码的前提） ---------- */

/** 7×7 定位图案的期望形状：外环实心 + 中间 3×3 实心 + 之间一圈空。 */
const FINDER = [
  '1111111',
  '1000001',
  '1011101',
  '1011101',
  '1011101',
  '1000001',
  '1111111',
];

function finderAt(modules, r0, c0) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const want = FINDER[r][c] === '1';
      if (modules[r0 + r][c0 + c] !== want) return `(${r0 + r},${c0 + c}) 期望 ${want}`;
    }
  }
  return null;
}

t('三个角都有定位图案（7×7）', () => {
  const { size, modules } = qr.buildQrMatrix('https://xiaohuanxiong.com/login/mp?code=' + 'a'.repeat(32));
  for (const [name, r0, c0] of [['左上', 0, 0], ['右上', 0, size - 7], ['左下', size - 7, 0]]) {
    const bad = finderAt(modules, r0, c0);
    assert.strictEqual(bad, null, `${name}定位图案不符：${bad}`);
  }
});

t('定时图案在第 6 行/列交替，且从偶数偏移起为深色', () => {
  const { size, modules } = qr.buildQrMatrix('https://xiaohuanxiong.com/login/mp?code=' + 'b'.repeat(32));
  for (let i = 0; 8 + i <= size - 9; i++) {
    const want = i % 2 === 0;
    assert.strictEqual(modules[6][8 + i], want, `第 6 行第 ${8 + i} 列定时图案错误`);
    assert.strictEqual(modules[8 + i][6], want, `第 6 列第 ${8 + i} 行定时图案错误`);
  }
});

t('尺寸恒为 17 + 4×version，且 1 ≤ version ≤ 10', () => {
  for (let n = 0; n <= 213; n++) {
    const { size } = qr.buildQrMatrix('A'.repeat(n));
    assert.ok((size - 17) % 4 === 0, `n=${n} 尺寸 ${size} 不是 17+4k`);
    const version = (size - 17) / 4;
    assert.ok(version >= 1 && version <= 10, `n=${n} 版本 ${version} 越界`);
  }
});

t('尺寸随输入字节数单调不减（版本只升不降）', () => {
  let prev = 0;
  for (let n = 0; n <= 213; n++) {
    const { size } = qr.buildQrMatrix('A'.repeat(n));
    assert.ok(size >= prev, `n=${n} 尺寸从 ${prev} 降到 ${size}`);
    prev = size;
  }
});

/* ---------- 3. 容量边界 ---------- */

t('213 字节可编码；214 字节必须抛错（不产出扫不出来的坏码）', () => {
  assert.doesNotThrow(() => qr.buildQrMatrix('A'.repeat(213)), '213 字节应当可编码');
  assert.throws(() => qr.buildQrMatrix('A'.repeat(214)), /过长|213/, '214 字节应当抛错');
});

t('UTF-8 按字节判定容量：71 个汉字（213 字节）可编码，72 个（216 字节）抛错', () => {
  assert.strictEqual(Buffer.byteLength('浣'.repeat(71)), 213);
  assert.doesNotThrow(() => qr.buildQrMatrix('浣'.repeat(71)));
  assert.strictEqual(Buffer.byteLength('浣'.repeat(72)), 216);
  assert.throws(() => qr.buildQrMatrix('浣'.repeat(72)), /过长|213/);
});

/* ---------- 4. 渲染一致性 ---------- */

t('renderQrPath 的方块集合与 buildQrMatrix 完全一致（两者不会漂移）', () => {
  for (const text of ['', 'a', 'hello world', '浣熊', 'A'.repeat(213)]) {
    const { size, modules } = qr.buildQrMatrix(text);
    const { size: pSize, dim, margin, path: d } = qr.renderQrPath(text);
    assert.strictEqual(pSize, size);
    assert.strictEqual(dim, size + margin * 2);

    const rebuilt = Array.from({ length: size }, () => new Array(size).fill(false));
    const re = /M(\d+),(\d+)h1v1h-1z/g;
    let m;
    let count = 0;
    while ((m = re.exec(d)) !== null) {
      const x = Number(m[1]) - margin;
      const y = Number(m[2]) - margin;
      assert.ok(x >= 0 && x < size && y >= 0 && y < size, `path 越界：(${x},${y})`);
      assert.strictEqual(rebuilt[y][x], false, `path 有重复方块：(${x},${y})`);
      rebuilt[y][x] = true;
      count += 1;
    }
    const dark = modules.flat().filter(Boolean).length;
    assert.strictEqual(count, dark, `方块数不符：path ${count} vs 矩阵 ${dark}`);
    assert.deepStrictEqual(rebuilt, modules, 'path 还原出的位图与矩阵不一致');
  }
});

t('renderQrSvg 与 renderQrPath 共用同一段方块表示', () => {
  const text = 'https://xiaohuanxiong.com/login/mp?code=' + 'c'.repeat(32);
  const svg = qr.renderQrSvg(text);
  const path = qr.renderQrPath(text);
  assert.ok(svg.includes(`viewBox="0 0 ${path.dim} ${path.dim}"`), 'svg viewBox 与 path dim 不一致');
  assert.ok(svg.includes(`<path d="${path.path}"`), 'svg 内的 path 与 renderQrPath 不一致');
});

t('同输入两次结果一致（无隐藏随机性）', () => {
  const a = qr.buildQrMatrix('determinism-check');
  const b = qr.buildQrMatrix('determinism-check');
  assert.deepStrictEqual(a.modules, b.modules);
  assert.strictEqual(qr.renderQrSvg('determinism-check'), qr.renderQrSvg('determinism-check'));
});

/* ---------- 5. 边界输入不崩 ---------- */

t('非字符串/空输入不抛未预期错误', () => {
  // 真实调用方只传字符串；但二维码内容来自登录会话，宁可显式失败也不要静默产出坏码
  assert.doesNotThrow(() => qr.buildQrMatrix(''));
  assert.throws(() => qr.buildQrMatrix('A'.repeat(1000)), /过长|213/);
});

/* ---------- 执行 ---------- */

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${name}\n      ${e.message}`);
    }
  }
  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
})();
