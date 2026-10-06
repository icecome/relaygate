/** @type {import('tailwindcss').Config} */

// 色值权威来源为 styles/tokens.css（映射 TraeWork 设计系统），
// 此处只提供 Tailwind 侧的等价命名，供模板类使用。
// 组件层禁止硬编码色值，一律走这两处。
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 品牌紫：TraeWork brand group
        brand: {
          50: '#f2f7ff',
          100: '#e5eaff',
          200: '#cfd8ff',
          300: '#aab7ff',
          400: '#8894ff',
          500: '#6a6fff',
          600: '#4b3fe3',
          700: '#3f31c6',
          800: '#2c2290',
          900: '#1a1759',
        },
        // 中性灰：TraeWork brand-grey group
        grey: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a1a1a1',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
        },
        // 语义文字
        ink: {
          DEFAULT: '#171717',
          soft: '#404040',
          faint: '#737373',
          disabled: '#a1a1a1',
        },
        // 语义状态：仅表达真实业务状态
        ok: { DEFAULT: '#15a877', soft: 'rgba(64, 176, 139, 0.12)' },
        warn: { DEFAULT: '#e27900', soft: 'rgba(226, 121, 0, 0.12)' },
        danger: { DEFAULT: '#e8463a', soft: 'rgba(232, 70, 58, 0.12)' },
        info: { DEFAULT: '#2f74ff', soft: 'rgba(47, 116, 255, 0.12)' },
        // 描边：使用 alpha 灰，保证在任意底色上层级一致
        line: {
          DEFAULT: 'rgba(115, 115, 115, 0.12)',
          strong: 'rgba(115, 115, 115, 0.18)',
          stronger: 'rgba(115, 115, 115, 0.36)',
        },
        surf: {
          DEFAULT: '#ffffff',
          soft: '#f5f5f5',
          2: '#e5e5e5',
        },
      },
      fontFamily: {
        sans: ['SF Pro Text', 'PingFang SC', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        heading: ['SF Pro', 'PingFang SC', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        metric: ['Inter', 'SF Pro Text', 'PingFang SC', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xs: '2px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '10px',
        '2xl': '12px',
      },
    },
  },
  plugins: [],
};