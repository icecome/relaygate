/// <reference types="vite/client" />

// vite.config.ts 的 define 注入（版本号单一事实源在根 package.json）
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
