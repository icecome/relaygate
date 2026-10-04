/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 灰阶主体（Linear / Vercel / GitHub 式：白底 + 灰边 + 单一强调色）
        // faint 取 #667085 而非更浅的灰：白底对比度 4.6:1，达到 WCAG AA 正文要求
        ink: {
          DEFAULT: '#111111',
          soft: '#4B5563',
          faint: '#667085',
        },
        line: {
          DEFAULT: '#E5E7EB',
          strong: '#D1D5DB',
          // 表面阶梯的分界描边。比 line 略深，保证在 #EAECEF 页面底上仍可辨
          hairline: '#E4E7EB',
        },
        surf: {
          DEFAULT: '#FFFFFF',
          soft: '#F6F7F8',
          // 二级表面：表头 / 输入框 / 嵌套区。比卡片暗一阶，让层级靠明度而非阴影区分
          '2': '#F7F8FA',
        },
        // 单一强调色：深翠绿（唯一品牌/交互色，克制使用）
        acc: {
          DEFAULT: '#047857',
          hover: '#065F46',
          soft: '#ECFDF5',
        },
        // 分段控件的轨道底色
        track: {
          DEFAULT: '#EFF1F3',
          line: '#E1E4E8',
        },
        warn: {
          DEFAULT: '#B45309',
          soft: '#FFFBEB',
          line: '#FDE68A',
        },
        danger: {
          DEFAULT: '#B91C1C',
          soft: '#FEF2F2',
          line: '#FDBA74',
        },
        // 页面底：承载留白，不承载内容。比 surf-2 再暗一阶，
        // 使白色卡片能靠明度差「浮起来」，而非依赖阴影堆叠
        bg: '#EAECEF',
      },
      fontFamily: {
        sans: ['system-ui', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
        pop: '0 8px 24px rgba(16,24,40,0.12)',
      },
      borderRadius: {
        card: '10px',
        ctl: '8px',
      },
    },
  },
  plugins: [],
};
