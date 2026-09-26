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
   * 总分并列时取副轨索引序列字典序更小的方案。
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
 * 总分并列时，按副轨索引序列的字典序取更小方案：重建时每一步在剩余
 * 目标分数不变的前提下，先取最小的副轨索引、再取最小的主轨索引。
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

  // 贪心重建最优配对：
  // 在状态 (i,j)、剩余目标分数 remaining = F[i][j] 下，第一对 (p,q) 必须
  // 满足 w[p][q] + F[p+1][q+1] == remaining。依次枚举最小的可行 q（副轨
  // 字典序），再取最小的可行 p，递归处理后缀状态。
  const pairs: MergePair[] = [];
  let i = 0;
  let j = 0;
  let remaining = F[0][0];
  while (remaining > EPS) {
    let advanced = false;
    for (let q = j; q < m; q++) {
      let chosenP = -1;
      for (const p of bySecondary[q]) {
        if (p < i) continue; // bySecondary[q] 按 p 升序，首个可行即最小
        if (Math.abs(w[p][q] + F[p + 1][q + 1] - remaining) <= EPS) {
          chosenP = p;
          break;
        }
      }
      if (chosenP >= 0) {
        pairs.push({ primaryIndex: chosenP, secondaryIndex: q, overlap: w[chosenP][q] });
        remaining -= w[chosenP][q];
        i = chosenP + 1;
        j = q + 1;
        advanced = true;
        break;
      }
    }
    if (!advanced) break; // 理论不会发生：remaining>0 时必有可行对；防御性退出
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
