/** 时间码与 id 工具 */

let counter = 0;

export function uid(): string {
  counter += 1;
  return `cue_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * 解析 WebVTT 时间戳：
 *   mm:ss.mmm | hh:mm:ss.mmm   （. 或 , 均可）
 * 失败返回 null。
 */
export function parseTimecode(raw: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*$/.exec(raw)
    ?? /^\s*(\d{1,2}):(\d{2})[.,](\d{1,3})\s*$/.exec(raw);
  if (!m) return null;

  let h: number, min: number, s: number, fracStr: string;
  if (m.length === 5) {
    h = Number(m[1]);
    min = Number(m[2]);
    s = Number(m[3]);
    fracStr = m[4];
  } else {
    h = 0;
    min = Number(m[1]);
    s = Number(m[2]);
    fracStr = m[3];
  }
  if (min >= 60 || s >= 60) return null;
  const ms = Number(fracStr.padEnd(3, '0'));
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** 规范 WebVTT 时间戳：HH:MM:SS.mmm（超过 1 小时才显示小时部分） */
export function formatTimecode(sec: number): string {
  const clamped = Math.max(0, sec);
  const totalMs = Math.round(clamped * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const min = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const mm = String(min).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}

/** 时间轴标尺上的紧凑显示：0:00 / 1:05 / 12:34（秒以下不显示） */
export function formatTick(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const min = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(min).padStart(2, '0')}:${ss}` : `${min}:${ss}`;
}
