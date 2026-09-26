import type { Cue } from './types';

/** 候选判定阈值：时间交集占较短片段时长的比例不得低于 50% */
export const OVERLAP_RATIO = 0.5;
/** 吸收浮点噪声（时间戳为毫秒精度，真正的分数差至少 1ms） */
const EPS = 1e-6;

export interface MergeCandidate {
  primaryIndex: number;
  secondaryIndex: number;
  /** 时间交集时长（秒） */
  overlap: number;
  /** 主、副之间较短一方的片段时长（秒） */
  shorterDuration: number;
}

export interface MergePair {
  primaryIndex: number;
  secondaryIndex: number;
  overlap: number;
}

export interface MergePlan {
  /** 按 start 排序后的主轨副本 */
  primary: Cue[];
  /** 按 start 排序后的副轨副本 */
  secondary: Cue[];
  /** 全部满足“交集 / 较短片段时长 ≥ 50%”的候选对 */
  candidates: MergeCandidate[];
  /**
   * 最优配对：保持双方顺序、每条片段最多使用一次、总交集时长最大；
   * 总分并列时取副轨索引序列全局字典序最小的方案（同一最小副轨索引
   * 对应多个可行主轨时，比较各可行后缀后决定，而非直接固定最小主轨索引）。
   */
  pairs: MergePair[];
  totalOverlap: number;
  /** 未参与配对的主轨索引（按时间顺序） */
  unmatchedPrimary: number[];
  /** 未参与配对的副轨索引（按时间顺序，确认后不会写入） */
  unmatchedSecondary: number[];
}

export interface MergeEntry {
  primaryId: string;
  mergedText: string;
}

const byTime = (a: Cue, b: Cue) => a.start - b.start || a.end - b.end;

/**
 * 计算双语轨合并方案。
 *
 * 候选：主、副片段时间交集 > 0，且 交集时长 / min(主时长, 副时长) ≥ 50%。
 * 最优配对：在候选之上求“保持双方索引顺序、每条最多使用一次”的最大权
 * （权 = 交集秒数）非交叉匹配，等价于带权 LCS，O(n·m) 动态规划求解。
 * 总分并列时取副轨索引序列全局字典序最小的方案：重建时每一步先取最小
 * 的可行副轨索引；若同一副轨索引可匹配多个主轨（各自都保持总分最优），
 * 则分别重建对应后缀并比较，取完整副轨索引序列字典序最小者——不能直接
 * 固定最小主轨索引，因为不同主轨消耗的前缀与剩余目标分数不同，会产生
 * 不同的后续副轨序列。
 */
export function planMerge(primaryInput: Cue[], secondaryInput: Cue[]): MergePlan {
  const primary = [...primaryInput].sort(byTime);
  const secondary = [...secondaryInput].sort(byTime);
  const n = primary.length;
  const m = secondary.length;

  // 候选矩阵（稀疏）：w[i][j] 为交集时长，非候选为 0
  const candidates: MergeCandidate[] = [];
  const w: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  // 每个副轨索引对应的候选主轨索引（按主轨索引升序），供按副轨字典序重建
  const bySecondary: number[][] = Array.from({ length: m }, () => []);
  for (let i = 0; i < n; i++) {
    const p = primary[i];
    for (let j = 0; j < m; j++) {
      const s = secondary[j];
      const overlap = Math.min(p.end, s.end) - Math.max(p.start, s.start);
      if (overlap <= 0) continue;
      const shorter = Math.min(p.end - p.start, s.end - s.start);
      if (overlap >= OVERLAP_RATIO * shorter - EPS) {
        w[i][j] = overlap;
        candidates.push({ primaryIndex: i, secondaryIndex: j, overlap, shorterDuration: shorter });
        bySecondary[j].push(i);
      }
    }
  }

  // F[i][j]：仅使用主轨 i..n-1 与副轨 j..m-1 时可取得的最大总交集时长
  const F: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(F[i + 1][j], F[i][j + 1]);
      if (w[i][j] > 0) best = Math.max(best, w[i][j] + F[i + 1][j + 1]);
      F[i][j] = best;
    }
  }

  // —— 重建最优配对：总分并列时取副轨索引序列全局字典序最小 ——
  //
  // 状态 (i,j) 表示子问题“仅用主轨 i..n-1 与副轨 j..m-1 取得恰好 F[i][j] 分”。
  // 从 (i,j) 出发的第一对 (p,q) 必须满足 w[p][q] + F[p+1][q+1] == F[i][j]：
  //  - q 取满足条件的最小副轨索引（首元素更小则整个序列必然更小）；
  //  - 同一 q 可能有多个可行 p：不同 p 消耗的主轨前缀不同、留给后缀的目标
  //    分数 F[p+1][q+1] 也不同，会产生不同的后续副轨序列，因此不能直接
  //    固定最小 p，而要比较各可行后缀，取完整序列字典序最小者。
  //
  // 分两遍迭代实现（避免递归深度随配对数线性增长）：
  //  1. 从 (0,0) 前向发现所有可达状态，并缓存每个状态的出边（最小可行 q
  //     与全部可行 p）；
  //  2. 按主轨下标降序回填各状态的最优序列——子状态 (p+1,q+1) 的主轨下标
  //     严格更大，必先于父状态完成。序列用链表节点共享后缀，比较只沿链表走。
  interface SeqNode {
    p: number;
    q: number;
    next: SeqNode | null;
  }
  interface StateEdge {
    q: number;
    ps: number[];
  }
  const keyOf = (i: number, j: number) => i * (m + 1) + j;
  /** 副轨索引序列字典序比较：逐项比较，前缀相同则短序列更小 */
  const compareSeq = (a: SeqNode | null, b: SeqNode | null): number => {
    let x = a;
    let y = b;
    while (x && y) {
      if (x.q !== y.q) return x.q - y.q;
      x = x.next;
      y = y.next;
    }
    if (x) return 1;
    if (y) return -1;
    return 0;
  };
  // 状态 (i,j) 的出边：满足 w[p][q] + F[p+1][q+1] == F[i][j] 的最小 q 与全部可行 p（升序）
  const edgesOf = (i: number, j: number): StateEdge | null => {
    const target = F[i][j];
    for (let q = j; q < m; q++) {
      let ps: number[] | null = null;
      for (const p of bySecondary[q]) {
        if (p < i) continue; // bySecondary[q] 按 p 升序，跳过已消耗的主轨
        if (Math.abs(w[p][q] + F[p + 1][q + 1] - target) <= EPS) (ps ??= []).push(p);
      }
      if (ps) return { q, ps };
    }
    return null;
  };

  // 第一遍：可达状态发现 + 出边缓存（null 表示目标分数为 0 的叶子状态）
  const edges = new Map<number, StateEdge | null>();
  const walk: Array<[number, number]> = [];
  if (F[0][0] > EPS) walk.push([0, 0]);
  while (walk.length > 0) {
    const [i, j] = walk.pop()!;
    const k = keyOf(i, j);
    if (edges.has(k)) continue;
    const e = edgesOf(i, j);
    edges.set(k, e);
    if (e) for (const p of e.ps) walk.push([p + 1, e.q + 1]);
  }

  // 第二遍：按主轨下标降序回填各状态的最优副轨序列
  const bestSeq = new Map<number, SeqNode | null>();
  const states = [...edges.keys()].map((k) => [Math.floor(k / (m + 1)), k % (m + 1)] as const);
  states.sort((a, b) => b[0] - a[0]);
  for (const [i, j] of states) {
    const k = keyOf(i, j);
    const e = edges.get(k);
    if (!e) {
      bestSeq.set(k, null);
      continue;
    }
    let best: SeqNode | null | undefined;
    let bestP = -1;
    for (const p of e.ps) {
      // p 升序遍历、严格更小才替换：后缀序列完全相同时取最小 p，保证确定性
      const child = bestSeq.get(keyOf(p + 1, e.q + 1)) ?? null;
      if (best === undefined || compareSeq(child, best) < 0) {
        best = child;
        bestP = p;
      }
    }
    bestSeq.set(k, { p: bestP, q: e.q, next: best ?? null });
  }

  const pairs: MergePair[] = [];
  let node = bestSeq.get(keyOf(0, 0)) ?? null;
  while (node) {
    pairs.push({ primaryIndex: node.p, secondaryIndex: node.q, overlap: w[node.p][node.q] });
    node = node.next;
  }

  const matchedP = new Set(pairs.map((x) => x.primaryIndex));
  const matchedS = new Set(pairs.map((x) => x.secondaryIndex));
  const unmatchedPrimary: number[] = [];
  const unmatchedSecondary: number[] = [];
  for (let k = 0; k < n; k++) if (!matchedP.has(k)) unmatchedPrimary.push(k);
  for (let k = 0; k < m; k++) if (!matchedS.has(k)) unmatchedSecondary.push(k);

  return {
    primary,
    secondary,
    candidates,
    pairs,
    totalOverlap: F[0][0],
    unmatchedPrimary,
    unmatchedSecondary,
  };
}

/**
 * 确认合并：仅把配对副轨文本作为新一行追加到主轨文本之后。
 * 主轨时间、标识符、设置与锁定状态由调用方原样保留。
 */
export function joinBilingualText(primaryText: string, secondaryText: string): string {
  return `${primaryText.replace(/\s+$/, '')}\n${secondaryText.replace(/\s+$/, '')}`;
}
