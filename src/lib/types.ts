export interface Cue {
  id: string;
  /** 可选的 WebVTT cue 标识符（NOTE 上方那一行），不参与时序 */
  identifier: string;
  start: number; // 秒
  end: number; // 秒
  text: string;
  /** cue 设置，如 "line:90% position:50% align:middle"，原样保留 */
  settings: string;
  locked: boolean;
}

export interface Settings {
  /** 最小片段时长（秒） */
  minDuration: number;
  /** 相邻片段最小间隔（秒） */
  minGap: number;
}

export type IssueKind = 'overlap' | 'gap' | 'duration' | 'negative' | 'layout';
export type Severity = 'error' | 'warning';

export interface Issue {
  key: string;
  kind: IssueKind;
  severity: Severity;
  message: string;
  /** 涉及的 cue（按 start 排序后的索引列表） */
  cueIds: string[];
  /** 问题在时间轴上的区间（秒） */
  range: [number, number];
}

export type DragOp = 'move' | 'resize-start' | 'resize-end';

export interface Conflict {
  /** 冲突区间（秒），用于在时间轴上标红 */
  range: [number, number];
  reason: string;
  /** 触发冲突的 cue id */
  cueId: string;
}
