/** @type {import('tailwindcss').Config} */

// 色值与语义状态统一由 src/styles/global.css 的 CSS 变量层提供
// （--rg-* 令牌），组件层一律引用变量，不走 Tailwind 语义色。
// 这里只保留真正被 className 使用的原子工具：字体等宽族与圆角阶梯。
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xs: '2px',
        sm: '4px',
        md: '6px',
        lg: '8px',
      },
    },
  },
  plugins: [],
};