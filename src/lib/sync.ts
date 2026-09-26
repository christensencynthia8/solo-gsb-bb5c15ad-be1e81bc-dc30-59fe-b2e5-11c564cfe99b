import type { Cue } from './types';

const EPS = 0.0005; // 0.5ms，吸收浮点噪声

export interface SyncConflict {
  /** 涉及的 cue id */
  cueIds: string[];
  reason: string;
  /** 冲突在时间轴上的区间（秒），用于标注 */
  range: [number, number];
}

export interface SyncPlan {
  feasible: boolean;
  /** feasible 时为校准后的完整 cues；否则为未修改的原 cues（不得部分写入） */
  cues: Cue[];
  /** 闭区间内被变换的未锁定 cue id（按时间排序） */
  affectedIds: string[];
  /** 唯一线性映射 t' = scale · t + offset（由两锚点旧/新开始时间确定） */
  scale: number;
  offset: number;
  /** 两锚点旧开始时间确定的闭区间 */
  interval: [number, number];
  /** 映射是否为恒等（无实际变化） */
  identity: boolean;
  conflicts: SyncConflict[];
}

export interface SyncOptions {
  cues: Cue[];
  anchorAId: string;
  anchorBId: string;
  newStartA: number;
  newStartB: number;
  minDuration: number;
  minGap: number;
}

/**
 * 两点同步批量校准。
 *
 * 由两个按时间排序的未锁定锚点（旧开始时间 oldA < oldB）及其新开始时间
 * （newA < newB）确定唯一线性映射 t' = scale·t + offset，将闭区间
 * [oldA, oldB] 内所有未锁定片段的 start/end 一并变换；区间外片段与锁定
 * 片段保持不变。
 *
 * 以下情况判定为不可行（feasible=false），调用方不得部分写入：
 *  - 锚点缺失/相同/被锁定，或旧锚点顺序无效（oldA ≥ oldB）
 *  - 新锚点顺序无效（newA ≥ newB）
 *  - 变换后片段时长低于当前最小时长，或开始时间早于 00:00.000
 *  - 校准后区间内及两侧边界的相邻片段不满足当前最小间隔（含重叠）
 * 所有冲突一次性收集返回，便于在面板中完整列出。
 */
export function planTwoPointSync(opts: SyncOptions): SyncPlan {
  const { cues, anchorAId, anchorBId, newStartA, newStartB, minDuration, minGap } = opts;
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const num = (id: string) => sorted.findIndex((c) => c.id === id) + 1;

  const fail = (conflicts: SyncConflict[]): SyncPlan => ({
    feasible: false,
    cues: sorted,
    affectedIds: [],
    scale: 1,
    offset: 0,
    interval: [0, 0],
    identity: false,
    conflicts,
  });

  const a = sorted.find((c) => c.id === anchorAId);
  const b = sorted.find((c) => c.id === anchorBId);
  if (!a || !b) return fail([{ cueIds: [], reason: '请选择两个锚点片段。', range: [0, 0] }]);
  if (a.id === b.id) {
    return fail([{ cueIds: [a.id], reason: '两个锚点必须是不同的片段。', range: [a.start, a.end] }]);
  }
  if (a.locked || b.locked) {
    const lockedOnes = [a, b].filter((c) => c.locked).map((c) => `#${num(c.id)}`).join('、');
    return fail([{
      cueIds: [a, b].filter((c) => c.locked).map((c) => c.id),
      reason: `锚点片段必须处于未锁定状态（片段 ${lockedOnes} 已锁定）。`,
      range: [Math.min(a.start, b.start), Math.max(a.end, b.end)],
    }]);
  }
  if (b.start - a.start < EPS) {
    return fail([{
      cueIds: [a.id, b.id],
      reason: '锚点顺序无效：锚点 1 的开始时间必须早于锚点 2。',
      range: [Math.min(a.start, b.start), Math.max(a.end, b.end)],
    }]);
  }
  if (newStartB - newStartA < EPS) {
    return fail([{
      cueIds: [a.id, b.id],
      reason: '新锚点顺序无效：锚点 2 的新开始时间必须晚于锚点 1。',
      range: [Math.max(0, Math.min(newStartA, newStartB)), Math.max(newStartA, newStartB)],
    }]);
  }

  const oldA = a.start;
  const oldB = b.start;
  const scale = (newStartB - newStartA) / (oldB - oldA);
  const offset = newStartA - scale * oldA;
  const interval: [number, number] = [oldA, oldB];
  const identity = Math.abs(scale - 1) < 1e-9 && Math.abs(offset) < EPS;

  const inInterval = (c: Cue) => c.start >= oldA - EPS && c.start <= oldB + EPS;
  const inIntervalIds = new Set(sorted.filter(inInterval).map((c) => c.id));

  const affectedIds: string[] = [];
  const mapped = sorted.map((c) => {
    if (!inIntervalIds.has(c.id) || c.locked) return c;
    affectedIds.push(c.id);
    return { ...c, start: scale * c.start + offset, end: scale * c.end + offset };
  });
  const affectedSet = new Set(affectedIds);

  const conflicts: SyncConflict[] = [];

  // —— 变换后片段自身合法性：非负、时长不低于最小时长 ——
  for (const c of mapped) {
    if (!affectedSet.has(c.id)) continue;
    const n = num(c.id);
    if (c.start < -EPS) {
      conflicts.push({
        cueIds: [c.id],
        reason: `片段 #${n} 校准后开始时间早于时间轴起点（00:00.000）。`,
        range: [0, Math.max(0, c.end)],
      });
    }
    if (c.end <= c.start + EPS) {
      conflicts.push({
        cueIds: [c.id],
        reason: `片段 #${n} 校准后结束时间不晚于开始时间。`,
        range: [Math.max(0, c.start), Math.max(c.start, c.end)],
      });
    } else if (c.end - c.start < minDuration - EPS) {
      conflicts.push({
        cueIds: [c.id],
        reason: `片段 #${n} 校准后时长 ${(c.end - c.start).toFixed(2)}s，低于最小时长 ${minDuration.toFixed(2)}s。`,
        range: [Math.max(0, c.start), c.end],
      });
    }
  }

  // —— 校准后区间内及两侧边界的相邻片段必须满足最小间隔 ——
  // 按校准后的新顺序检查所有“至少一端在区间内”的相邻对；
  // 完全在区间外的相邻对未被本次校准改变，不参与判定。
  const reSorted = [...mapped].sort((x, y) => x.start - y.start || x.end - y.end);
  for (let i = 0; i + 1 < reSorted.length; i++) {
    const p = reSorted[i];
    const q = reSorted[i + 1];
    if (!inIntervalIds.has(p.id) && !inIntervalIds.has(q.id)) continue;
    const gap = q.start - p.end;
    if (gap < minGap - EPS) {
      const reason = gap < -EPS
        ? `片段 #${num(p.id)} 与 #${num(q.id)} 校准后重叠 ${(-gap).toFixed(2)}s。`
        : `片段 #${num(p.id)} 与 #${num(q.id)} 校准后间隔仅 ${Math.max(0, gap).toFixed(2)}s，小于最小间隔 ${minGap.toFixed(2)}s。`;
      conflicts.push({
        cueIds: [p.id, q.id],
        range: [Math.max(0, Math.min(p.end, q.start)), Math.max(p.end, q.start)],
        reason,
      });
    }
  }

  if (conflicts.length > 0) {
    // 禁止部分写入：返回原始 cues
    return { feasible: false, cues: sorted, affectedIds, scale, offset, interval, identity, conflicts };
  }
  return { feasible: true, cues: reSorted, affectedIds, scale, offset, interval, identity, conflicts: [] };
}
