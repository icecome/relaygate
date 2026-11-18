/** @type {import('tailwindcss').Config} */

// 色值与语义状态统一由 src/styles/global.css 的 CSS 变量层提供
// （--rg-* 令牌），组件层一律引用变量，不走 Tailwind 语义色。
// 这里只保留真正被 className 使用的原子工具：字体等宽族与圆角阶梯。
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /*
       * 等宽字体栈
       *
       * 与 global.css 的 --rg-font-mono 必须逐字一致：两处都定义了同一个
       * font-family 的「最终归属」，不一致时 className 版本（utilities 层，
       * 排在 components 之后）总是胜出，CSS 变量版本看起来写了但没生效。
       *
       * 顺序按「确定存在的字体优先」：
       *   Cascadia Mono / Code  — Windows Terminal 附带，Win10 1809+ 起随系统
       *   Consolas              — 全版本 Windows 都有
       *   ui-monospace          — macOS / iOS 的系统等宽
       *   monospace             — 兜底
       * 原来的首选 JetBrains Mono 在 Windows 上不随系统分发（本机实测未安装），
       * 写了等于没写，只会让「以为在用 JetBrains Mono」的错觉持续存在。
       */
      fontFamily: {
        mono: ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'ui-monospace', 'monospace'],
      },
      /*
       * 圆角阶梯
       *
       * 改为引用 CSS 变量，而不是再写一遍字面值：此前 --rg-radius-* 五档
       * 在 global.css 里定义但零引用（组件层用 rounded-lg 等 Tailwind 类），
       * 于是「改圆角」要同时改两个文件，只改一处必然漂移。
       */
      borderRadius: {
        xs: 'var(--rg-radius-xs)',
        sm: 'var(--rg-radius-sm)',
        md: 'var(--rg-radius-md)',
        lg: 'var(--rg-radius-lg)',
        xl: 'var(--rg-radius-xl)',
      },
    },
  },
  plugins: [],
};
