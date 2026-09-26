import type { Cue } from './types';

/**
 * 画面布局（cue settings）工具：
 * - 把 cue 设置拆成有序 token，编辑四个布局字段（line/position/size/align）时
 *   保留其它未知设置的原始顺序与内容；
 * - 校验四个字段的取值（WebVTT 规范）；
 * - 估算字幕框在 16:9 画面中的几何位置，并检测是否超出 10% 安全区。
 */

/** 四个可独立编辑的布局字段 */
export const LAYOUT_KEYS = ['line', 'position', 'size', 'align'] as const;
export type LayoutKey = (typeof LAYOUT_KEYS)[number];

export interface CueSettingToken {
  key: string;
  value: string;
}

/** 把 cue 设置字符串拆成有序 token 列表（未知设置原样保留） */
export function parseCueSettings(settings: string): CueSettingToken[] {
  return settings
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const i = tok.indexOf(':');
      return i === -1 ? { key: tok, value: '' } : { key: tok.slice(0, i), value: tok.slice(i + 1) };
    });
}

/** 把 token 列表拼回设置字符串（单空格分隔） */
export function serializeCueSettings(tokens: CueSettingToken[]): string {
  return tokens.map((t) => (t.value ? `${t.key}:${t.value}` : t.key)).join(' ');
}

/** 读取某个设置项的值（同名设置取第一个，与规范一致）；未设置返回 '' */
export function getCueSetting(settings: string, key: LayoutKey): string {
  return parseCueSettings(settings).find((t) => t.key === key)?.value ?? '';
}

/**
 * 更新四个布局字段之一：
 * - 已存在则就地替换（保持在设置串中的原有位置），并移除同名的后续重复项；
 * - 不存在则追加到末尾；
 * - 传入空字符串则删除该设置。
 * 其它（未知）设置的内容与相对顺序完全保留。
 */
export function updateCueSetting(settings: string, key: LayoutKey, value: string): string {
  const tokens = parseCueSettings(settings);
  const v = value.trim();
  const idx = tokens.findIndex((t) => t.key === key);
  if (v === '') {
    if (idx >= 0) tokens.splice(idx, 1);
  } else if (idx >= 0) {
    tokens[idx] = { key, value: v };
    for (let i = tokens.length - 1; i > idx; i--) {
      if (tokens[i].key === key) tokens.splice(i, 1);
    }
  } else {
    tokens.push({ key, value: v });
  }
  return serializeCueSettings(tokens);
}

// ---------- 取值校验（WebVTT 规范） ----------

const LINE_PCT_RE = /^(\d+(?:\.\d+)?)%(?:,(start|center|end))?$/;
const LINE_NUM_RE = /^(-?\d+)(?:,(start|center|end))?$/;
const POSITION_RE = /^(\d+(?:\.\d+)?)%(?:,(line-left|center|line-right|auto))?$/;
const SIZE_RE = /^(\d+(?:\.\d+)?)%$/;
export const ALIGN_VALUES = ['start', 'center', 'end', 'left', 'right'] as const;
export type TextAlign = (typeof ALIGN_VALUES)[number];

/** 校验单个布局字段的值，合法返回 null，非法返回中文错误描述 */
export function validateLayoutValue(key: LayoutKey, value: string): string | null {
  switch (key) {
    case 'line': {
      const pct = LINE_PCT_RE.exec(value);
      if (pct) {
        return parseFloat(pct[1]) > 100 ? `line 百分比“${value}”超出 0–100% 范围` : null;
      }
      if (LINE_NUM_RE.test(value)) return null;
      return `line 值“${value}”非法：应为 0–100% 百分比（如 90%）或整数行号（如 12、-1），可带 ,start/,center/,end`;
    }
    case 'position': {
      const m = POSITION_RE.exec(value);
      if (!m) return `position 值“${value}”非法：应为 0–100% 百分比（如 50%），可带 ,line-left/,center/,line-right`;
      return parseFloat(m[1]) > 100 ? `position 百分比“${value}”超出 0–100% 范围` : null;
    }
    case 'size': {
      const m = SIZE_RE.exec(value);
      if (!m) return `size 值“${value}”非法：应为 0–100% 百分比（如 80%）`;
      return parseFloat(m[1]) > 100 ? `size 百分比“${value}”超出 0–100% 范围` : null;
    }
    case 'align': {
      return (ALIGN_VALUES as readonly string[]).includes(value)
        ? null
        : `align 值“${value}”非法：应为 start / center / end / left / right`;
    }
  }
}

// ---------- 几何估算与安全区检测 ----------

/** WebVTT 行高：视频高度的 5.33%（规范值） */
const LINE_HEIGHT_PCT = 5.33;
/** 默认字号 5% 屏高，换算为屏宽百分比（16:9） */
const FONT_WIDTH_PCT = 5 * (9 / 16);
/** 安全区边距（四边各 10%） */
export const SAFE_MARGIN_PCT = 10;
/** 安全区判定容差，避免边界数值抖动造成误报 */
const SAFE_EPS = 0.5;

// CJK/全角字符区间（Hangul Jamo、CJK 统一表意、Hangul 音节、兼容表意、CJK 兼容形式、全角形式）
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 估算单行文本渲染宽度（相对屏宽 %）：全角≈1em，半角≈0.55em */
export function estimateTextWidthPct(line: string): number {
  let w = 0;
  for (const ch of line) {
    w += WIDE_CHAR.test(ch) ? FONT_WIDTH_PCT : FONT_WIDTH_PCT * 0.55;
  }
  return w;
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

export interface LayoutAnalysis {
  /** 四个字段的原始值（未设置为 ''） */
  raw: Record<LayoutKey, string>;
  /** 非法值描述列表 */
  errors: string[];
  /** 是否显式设置了 line/position/size 之一（决定是否做安全区判定） */
  hasGeometry: boolean;
  /** 字幕实际占位区域（相对屏宽/屏高的百分比），即预览与安全区检测所用的“字幕框” */
  left: number;
  top: number;
  width: number;
  height: number;
  textAlign: TextAlign;
  /** 占位区域是否超出 10% 安全区（纯几何结论；是否上报由 hasGeometry 决定） */
  outsideSafe: boolean;
  /** 越界方位描述，如 ['下侧 97.3% > 90%'] */
  safeViolations: string[];
}

/**
 * 解析所选片段的 line/position/size/align，估算字幕框位置。
 * 默认值按规范：position 50%、size 100%、line 自动（贴底）、align center。
 * size 未显式设置时，默认 100% 的 cue 框只是渲染细节，实际占位是框内
 * 按 align 对齐的文本区域，因此水平方向改用估算文本宽度。
 */
export function analyzeCueLayout(cue: Pick<Cue, 'settings' | 'text'>): LayoutAnalysis {
  const tokens = parseCueSettings(cue.settings);
  const raw: Record<LayoutKey, string> = { line: '', position: '', size: '', align: '' };
  for (const key of LAYOUT_KEYS) raw[key] = tokens.find((t) => t.key === key)?.value ?? '';

  const errors: string[] = [];
  for (const key of LAYOUT_KEYS) {
    if (raw[key] === '') continue;
    const err = validateLayoutValue(key, raw[key]);
    if (err) errors.push(err);
  }

  // 非法 align 按未设置处理（错误已在 errors 中报告）
  const textAlign: TextAlign = (ALIGN_VALUES as readonly string[]).includes(raw.align)
    ? (raw.align as TextAlign)
    : 'center';

  // --- 水平方向 ---
  const sizeM = SIZE_RE.exec(raw.size);
  const sizePct = sizeM ? Math.min(100, parseFloat(sizeM[1])) : 100;
  const posM = POSITION_RE.exec(raw.position);
  const positionPct = posM ? Math.min(100, parseFloat(posM[1])) : 50;
  const posAlignRaw = posM?.[2] ?? 'auto';
  // position 对齐缺省（auto）时按文本对齐推导（规范行为）
  const posAlign: 'line-left' | 'center' | 'line-right' =
    posAlignRaw === 'line-left' || posAlignRaw === 'center' || posAlignRaw === 'line-right'
      ? posAlignRaw
      : textAlign === 'left' || textAlign === 'start'
        ? 'line-left'
        : textAlign === 'right' || textAlign === 'end'
          ? 'line-right'
          : 'center';
  const boxLeft =
    posAlign === 'line-left' ? positionPct : posAlign === 'center' ? positionPct - sizePct / 2 : positionPct - sizePct;

  // --- 垂直方向 ---
  const textLines = cue.text.split('\n').filter((l) => l.trim().length > 0);
  const lineCount = Math.max(1, textLines.length);
  const height = lineCount * LINE_HEIGHT_PCT;
  const linePctM = LINE_PCT_RE.exec(raw.line);
  const lineNumM = linePctM ? null : LINE_NUM_RE.exec(raw.line);
  const lineAlign = (linePctM?.[2] ?? lineNumM?.[2] ?? 'start') as 'start' | 'center' | 'end';
  let top: number;
  if (linePctM) {
    const p = Math.min(100, parseFloat(linePctM[1]));
    top = lineAlign === 'end' ? p - height : lineAlign === 'center' ? p - height / 2 : p;
  } else if (lineNumM) {
    const n = parseInt(lineNumM[1], 10);
    const anchor = n >= 0 ? n * LINE_HEIGHT_PCT : 100 + n * LINE_HEIGHT_PCT;
    top = lineAlign === 'end' ? anchor - height : lineAlign === 'center' ? anchor - height / 2 : anchor;
  } else {
    // 未设置 line：贴底（播放器默认行为）
    top = 100 - height;
  }

  // --- 实际占位区域（安全区检测对象） ---
  let left = boxLeft;
  let width = sizePct;
  if (!sizeM) {
    const longest = textLines.reduce((m, l) => Math.max(m, estimateTextWidthPct(stripTags(l))), 0);
    width = Math.min(sizePct, Math.max(longest, FONT_WIDTH_PCT));
    if (textAlign === 'left' || textAlign === 'start') left = boxLeft;
    else if (textAlign === 'right' || textAlign === 'end') left = boxLeft + sizePct - width;
    else left = boxLeft + (sizePct - width) / 2;
  }

  const hasGeometry = raw.line !== '' || raw.position !== '' || raw.size !== '';
  const safeViolations: string[] = [];
  const lo = SAFE_MARGIN_PCT;
  const hi = 100 - SAFE_MARGIN_PCT;
  if (left < lo - SAFE_EPS) safeViolations.push(`左侧 ${left.toFixed(1)}% < ${lo}%`);
  if (left + width > hi + SAFE_EPS) safeViolations.push(`右侧 ${(left + width).toFixed(1)}% > ${hi}%`);
  if (top < lo - SAFE_EPS) safeViolations.push(`上侧 ${top.toFixed(1)}% < ${lo}%`);
  if (top + height > hi + SAFE_EPS) safeViolations.push(`下侧 ${(top + height).toFixed(1)}% > ${hi}%`);

  return {
    raw,
    errors,
    hasGeometry,
    left,
    top,
    width,
    height,
    textAlign,
    outsideSafe: safeViolations.length > 0,
    safeViolations,
  };
}
