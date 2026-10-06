'use strict';
/**
 * lib/version-defaults.js — Trae 客户端版本指纹默认值（m-35：从 lib/auth.js 抽出，
 * auth 与 headers 共用，避免拆分后出现两份声明）。
 *
 * 对齐 TraeWorkAssistant 实测可用的 SOLO 线指纹（0.1.50 / 20260811），
 * 旧值 3.3.67 / 20260401 与当前在售客户端脱节，易被上游风控识别。
 */
module.exports = {
  DEFAULT_IDE_VERSION_CN: '0.1.50',
  DEFAULT_IDE_VERSION_SG: '0.1.50',
  DEFAULT_IDE_VERSION_CODE: '20260811',
};
