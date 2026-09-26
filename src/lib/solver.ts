import type { Conflict, Cue, DragOp } from './types';

export interface SolveOptions {
  cues: Cue[];
  targetId: string;
  op: DragOp;
  /** 期望的移动起点/结束点（秒，未经钳制的原始期望） */
  desired: number;
  minDuration: number;
  minGap: number;
}

export interface SolveResult {
  feasible: boolean;
  /** 成功时：调整后的完整 cues（按 start 排序） */
  cues: Cue[];
  conflict?: Conflict;
}

const EPS = 0.0005; // 0.5ms，吸收浮点噪声

/**
 * 核心约束传播求解器。
 *
 * 两遍扫描（向右推移为例）：
 *  1. 刚性推进：后续未锁定片段保持时长整体右移，直到 (a) 无压力、
 *     (b) 到达链尾（向右无边界）或 (c) 撞上锁定片段；
 *  2. 压缩吸收：撞锁定片段时，从近到远让中间片段从右缘收缩（保持最小时长），
 *     仍装不下 => 无解。
 * 向左为镜像过程，边界为锁定片段或时间轴起点 0s。
 *
 *  - 锁定片段绝不改变
 *  - move 时目标保持时长；resize 时先做最小时长/非负本地校验
 *  - 无解返回 feasible=false 与标红区间，调用方撤销本次调整
 *
 * 每次拖动都以“调整前的原始 cues”为基准重新求解。
 */
export function applyDrag(opts: SolveOptions): SolveResult {
  const { cues, targetId, op, minDuration, minGap } = opts;
  const desired = opts.desired;

  const work = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const idx = work.findIndex((c) => c.id === targetId);
  if (idx === -1) return { feasible: false, cues };
  const target = work[idx];

  let newStart = target.start;
  let newEnd = target.end;

  if (op === 'move') {
    const shift = desired - target.start;
    if (target.locked || Math.abs(shift) < EPS) return { feasible: true, cues: toSorted(work) };
    newStart = desired;
    newEnd = desired + (target.end - target.start);
    if (shift > 0) {
      const r = pushRight(work, idx, newEnd, minDuration, minGap);
      if (!r.ok) return fail(work, target, r.failure!, 'move');
    } else {
      const r = pushLeft(work, idx, newStart, minDuration, minGap);
      if (!r.ok) return fail(work, target, r.failure!, 'move');
    }
  } else if (op === 'resize-end') {
    if (target.locked) return { feasible: true, cues: toSorted(work) };
    newEnd = desired;
    if (newEnd <= target.start + EPS) {
      return fail(work, target, { range: [target.start, Math.max(target.start, newEnd)], reason: '结束时间必须晚于开始时间。' }, op);
    }
    if (newEnd - target.start + EPS < minDuration) {
      return fail(work, target, { range: [target.start, newEnd], reason: `片段短于最小时长 ${minDuration.toFixed(2)}s。` }, op);
    }
    if (newEnd > target.end + EPS) {
      const r = pushRight(work, idx, newEnd, minDuration, minGap);
      if (!r.ok) return fail(work, target, r.failure!, op);
    }
  } else {
    // resize-start
    if (target.locked) return { feasible: true, cues: toSorted(work) };
    newStart = desired;
    if (newStart + EPS >= target.end) {
      return fail(work, target, { range: [Math.min(newStart, target.end), target.end], reason: '开始时间必须早于结束时间。' }, op);
    }
    if (target.end - newStart + EPS < minDuration) {
      return fail(work, target, { range: [newStart, target.end], reason: `片段短于最小时长 ${minDuration.toFixed(2)}s。` }, op);
    }
    if (newStart < -EPS) {
      return fail(work, target, { range: [0, Math.max(0, target.end)], reason: '调整超出时间轴起点（00:00.000）。' }, op);
    }
    if (newStart < target.start - EPS) {
      const r = pushLeft(work, idx, newStart, minDuration, minGap);
      if (!r.ok) return fail(work, target, r.failure!, op);
    }
  }

  work[idx] = { ...target, start: newStart, end: newEnd };
  return { feasible: true, cues: toSorted(work) };
}

interface Failure {
  range: [number, number];
  reason: string;
}

interface PassResult {
  ok: boolean;
  failure?: Failure;
}

/** 目标右缘固定在 targetEnd，把压力向右传播。就地修改 work。 */
function pushRight(work: Cue[], idx: number, targetEnd: number, minDuration: number, minGap: number): PassResult {
  // —— 第一遍：刚性推进 ——
  let prevEnd = targetEnd;
  let blocker = -1; // 锁定片段下标；work.length 表示“无边界”
  for (let i = idx + 1; i < work.length; i++) {
    const c = work[i];
    if (c.locked) {
      if (c.start + EPS >= prevEnd + minGap) return { ok: true };
      blocker = i;
      break;
    }
    const earliest = prevEnd + minGap;
    if (c.start + EPS >= earliest) return { ok: true }; // 此片段已无压力，链终止
    const s = earliest;
    work[i] = { ...c, start: s, end: s + (c.end - c.start) };
    prevEnd = work[i].end;
  }
  if (blocker === -1) return { ok: true }; // 右侧是开放的

  // —— 第二遍：从锁定片段向左压缩吸收 ——
  // 注意：第一遍被推动的片段都已越界，必须全部参与压缩，不能在中间停止。
  let rightBound = work[blocker].start - minGap;
  for (let j = blocker - 1; j > idx; j--) {
    const c = work[j];
    let e = Math.min(c.end, rightBound);
    let s = c.start;
    if (e < s + minDuration) s = e - minDuration;
    work[j] = { ...c, start: s, end: e };
    rightBound = s - minGap;
  }
  if (rightBound + EPS < targetEnd) {
    const need = targetEnd - rightBound;
    return {
      ok: false,
      failure: {
        range: [targetEnd, work[blocker].end],
        reason: `向右调整空间不足：锁定片段 #${blocker + 1} 不可移动，还差 ${(need + minGap).toFixed(2)}s 的空间（已让中间片段收缩到最小时长）。`,
      },
    };
  }
  return { ok: true };
}

/** 目标左缘固定在 targetStart，把压力向左传播。就地修改 work。 */
function pushLeft(work: Cue[], idx: number, targetStart: number, minDuration: number, minGap: number): PassResult {
  if (idx === 0) {
    if (targetStart < -EPS) {
      return { ok: false, failure: { range: [0, Math.max(0, targetStart)], reason: '调整超出时间轴起点（00:00.000）。' } };
    }
    return { ok: true };
  }

  // —— 第一遍：刚性推进 ——
  let nextStart = targetStart;
  let blocker = -1; // 锁定片段下标；-1 的特殊值 0 墙用 blockerWall
  let wall = false;
  for (let i = idx - 1; i >= 0; i--) {
    const c = work[i];
    if (c.locked) {
      if (c.end - EPS <= nextStart - minGap) return { ok: true };
      blocker = i;
      break;
    }
    const latest = nextStart - minGap;
    if (c.end - EPS <= latest) return { ok: true }; // 此片段已无压力，链终止
    const e = latest;
    const s = e - (c.end - c.start);
    work[i] = { ...c, start: s, end: e };
    nextStart = s;
    if (i === 0 && s < -EPS) {
      wall = true;
      break;
    }
  }
  if (blocker === -1 && !wall) return { ok: true };

  // —— 第二遍：从阻挡处向右压缩吸收 ——
  // 撞墙时最前方片段的起点隐式钳制在 0（超出 0 的部分由它吸收）
  let leftBound: number;
  let range: [number, number];
  if (wall) {
    leftBound = 0;
    range = [0, targetStart];
  } else {
    leftBound = work[blocker].end + minGap;
    range = [work[blocker].start, targetStart];
  }
  const first = wall ? 0 : blocker + 1;
  for (let j = first; j < idx; j++) {
    const c = work[j];
    // 第一遍被推动的片段都必须参与压缩
    const s = Math.max(0, Math.max(c.start, leftBound));
    let e = c.end;
    if (s > e - minDuration) e = s + minDuration;
    work[j] = { ...c, start: s, end: e };
    leftBound = e + minGap;
  }
  if (leftBound - EPS > targetStart) {
    const need = leftBound - targetStart;
    const reason = wall
      ? `向左调整空间不足：到达时间轴起点（00:00.000），还差 ${need.toFixed(2)}s。`
      : `向左调整空间不足：锁定片段 #${blocker + 1} 不可移动，还差 ${(need + minGap).toFixed(2)}s 的空间（已让中间片段收缩到最小时长）。`;
    return { ok: false, failure: { range, reason } };
  }
  return { ok: true };
}

function fail(cues: Cue[], target: Cue, f: Failure, _op: DragOp): SolveResult {
  const lo = Math.max(0, Math.min(f.range[0], f.range[1]));
  const hi = Math.max(f.range[0], f.range[1]);
  return {
    feasible: false,
    cues: toSorted(cues),
    conflict: { range: [lo, hi], reason: f.reason, cueId: target.id },
  };
}

function toSorted(cues: Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}
