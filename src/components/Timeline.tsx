import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conflict, Cue, DragOp, Issue, Settings } from '../lib/types';
import { applyDrag } from '../lib/solver';
import { formatTick, formatTimecode } from '../lib/time';

const LANE_HEIGHT = 34;
const LANE_GAP = 6;
const RULER_HEIGHT = 28;
const EDGE_HIT = 7;

interface DragState {
  op: DragOp;
  cueId: string;
  /** 指针按下时的原始 cues 快照 */
  baseline: Cue[];
  /** 指针按下时对应的时间（move：目标 start；resize-end：目标 end；resize-start：目标 start） */
  originTime: number;
  /** 指针像素起点 */
  pointerX: number;
  /** 最近一次可行结果，用于撤销时恢复 */
  lastFeasible: Cue[];
  /** 拖动期间是否处于不可行状态 */
  stuck: boolean;
  moved: boolean;
}

interface Props {
  cues: Cue[];
  settings: Settings;
  selectedId: string | null;
  conflict: Conflict | null;
  issues: Issue[];
  pps: number;
  /** 两点同步的虚影预览片段（变换后的受影响片段，与现有片段同 id） */
  ghosts?: Cue[];
  onPps: (pps: number) => void;
  onSelect: (id: string) => void;
  onCommit: (cues: Cue[]) => void;
  onConflict: (c: Conflict | null) => void;
  registerScrollTo: (fn: (id: string) => void) => void;
}

interface LaneItem extends Cue {
  lane: number;
}

/** 贪心分配泳道：按 start 排序，重叠的片段放到不同泳道 */
function assignLanes(cues: Cue[]): { items: LaneItem[]; lanes: number } {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds: number[] = [];
  const items: LaneItem[] = [];
  for (const c of sorted) {
    let lane = laneEnds.findIndex((end) => end <= c.start + 0.0001);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(c.end);
    } else {
      laneEnds[lane] = c.end;
    }
    items.push({ ...c, lane });
  }
  return { items, lanes: Math.max(1, laneEnds.length) };
}

function niceStep(pps: number): number {
  const targetPx = 110;
  const targetSec = targetPx / pps;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s * pps >= targetPx * 0.55) ?? 3600;
}

export default function Timeline(props: Props) {
  const { cues, settings, selectedId, conflict, issues, pps, ghosts = [] } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hint, setHint] = useState<{ x: number; text: string; stuck: boolean } | null>(null);
  const [, forceTick] = useState(0);

  const { items, lanes } = useMemo(() => assignLanes(cues), [cues]);
  const laneById = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.id, it.lane);
    return m;
  }, [items]);
  const trackHeight = lanes * (LANE_HEIGHT + LANE_GAP) + 12;

  const extent = useMemo(() => {
    const endMax = cues.reduce((m, c) => Math.max(m, c.end), 0);
    const ghostMax = ghosts.reduce((m, c) => Math.max(m, c.end), 0);
    return Math.max(30, endMax * 1.18 + 4, ghostMax + 2, (conflict ? conflict.range[1] : 0) + 2);
  }, [cues, ghosts, conflict]);

  const step = niceStep(pps);
  const ticks: number[] = [];
  for (let t = 0; t <= extent + 1e-6; t += step) ticks.push(t);

  const issueRanges = useMemo(() => {
    // 同一区间的多个问题合并显示
    return issues.map((i) => ({ key: i.key, range: i.range, severity: i.severity }));
  }, [issues]);

  useEffect(() => {
    props.registerScrollTo((id: string) => {
      const c = cues.find((x) => x.id === id);
      if (!c || !scrollRef.current) return;
      const x = c.start * pps;
      scrollRef.current.scrollTo({ left: Math.max(0, x - 120), behavior: 'smooth' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cues, pps]);

  function eventTime(e: React.PointerEvent): number {
    const rect = contentRef.current!.getBoundingClientRect();
    return (e.clientX - rect.left) / pps;
  }

  function onBlockPointerDown(e: React.PointerEvent, cue: Cue, op: DragOp) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    props.onSelect(cue.id);
    if (cue.locked) return;
    const target = (e.target as HTMLElement);
    target.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      op,
      cueId: cue.id,
      baseline: props.cues,
      originTime: op === 'resize-end' ? cue.end : cue.start,
      pointerX: e.clientX,
      lastFeasible: props.cues,
      stuck: false,
      moved: false,
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !contentRef.current) return;
    const dx = e.clientX - d.pointerX;
    if (Math.abs(dx) < 2 && !d.moved) return;
    d.moved = true;
    const desired = d.originTime + dx / pps;

    const res = applyDrag({
      cues: d.baseline,
      targetId: d.cueId,
      op: d.op,
      desired,
      minDuration: settings.minDuration,
      minGap: settings.minGap,
    });

    if (res.feasible) {
      d.stuck = false;
      d.lastFeasible = res.cues;
      props.onConflict(null);
      props.onCommit(res.cues);
    } else {
      d.stuck = true;
      props.onConflict(res.conflict ?? null);
      props.onCommit(d.lastFeasible);
    }
    forceTick((n) => n + 1);

    const rect = scrollRef.current!.getBoundingClientRect();
    const opLabel = d.op === 'move' ? '移动到' : d.op === 'resize-end' ? '结束于' : '开始于';
    setHint({
      x: e.clientX - rect.left + scrollRef.current!.scrollLeft,
      text: `${opLabel} ${formatTimecode(Math.max(0, desired))}${d.stuck ? '（约束无解，已撤销）' : ''}`,
      stuck: d.stuck,
    });
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (d.moved && d.stuck) {
      // 约束无解：撤销到最近一次可行状态，保留冲突标注
      props.onCommit(d.lastFeasible);
    } else if (d.moved) {
      props.onConflict(null);
    }
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setHint(null);
    forceTick((n) => n + 1);
  }

  const hoverCue = hoverId ? cues.find((c) => c.id === hoverId) : null;

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <span className="muted">缩放</span>
        <button onClick={() => props.onPps(Math.max(5, pps / 1.4))} title="缩小">－</button>
        <button onClick={() => props.onPps(Math.min(600, pps * 1.4))} title="放大">＋</button>
        <button
          onClick={() => {
            const w = scrollRef.current?.clientWidth ?? 800;
            props.onPps(Math.max(8, Math.min(600, (w - 80) / Math.max(1, extent))));
          }}
        >
          适应窗口
        </button>
        <span className="muted ml">拖动片段中部移动 · 拖动左右边界改时长 · 🔒 锁定片段不参与传播</span>
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div
          ref={contentRef}
          className="timeline-content"
          style={{ width: extent * pps, height: RULER_HEIGHT + trackHeight }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* 标尺 */}
          <div className="ruler" style={{ height: RULER_HEIGHT }}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * pps }}>
                <span>{formatTick(t)}</span>
              </div>
            ))}
          </div>

          {/* 轨道网格 */}
          <div className="track" style={{ top: RULER_HEIGHT, height: trackHeight }}>
            {ticks.map((t) => (
              <div key={t} className="gridline" style={{ left: t * pps }} />
            ))}

            {/* 问题区间 */}
            {issueRanges.map((r) => (
              <div
                key={r.key}
                className={`issue-range ${r.severity}`}
                style={{ left: r.range[0] * pps, width: Math.max(3, (r.range[1] - r.range[0]) * pps) }}
                title={issues.find((i) => i.key === r.key)?.message}
              />
            ))}

            {/* 冲突区间 */}
            {conflict && (
              <div
                className="conflict-range"
                style={{
                  left: conflict.range[0] * pps,
                  width: Math.max(6, (conflict.range[1] - conflict.range[0]) * pps),
                }}
                title={conflict.reason}
              />
            )}

            {/* 片段 */}
            {items.map((c) => {
              const selected = c.id === selectedId;
              return (
                <div
                  key={c.id}
                  className={
                    'cue-block'
                    + (selected ? ' selected' : '')
                    + (c.locked ? ' locked' : '')
                    + (dragRef.current?.cueId === c.id && dragRef.current?.stuck ? ' stuck' : '')
                  }
                  style={{
                    left: c.start * pps,
                    width: Math.max(10, (c.end - c.start) * pps),
                    top: 6 + c.lane * (LANE_HEIGHT + LANE_GAP),
                    height: LANE_HEIGHT,
                  }}
                  onPointerDown={(e) => onBlockPointerDown(e, c, 'move')}
                  onPointerEnter={() => setHoverId(c.id)}
                  onPointerLeave={() => setHoverId(null)}
                >
                  {!c.locked && (
                    <>
                      <span
                        className="edge edge-l"
                        onPointerDown={(e) => onBlockPointerDown(e, c, 'resize-start')}
                      />
                      <span
                        className="edge edge-r"
                        onPointerDown={(e) => onBlockPointerDown(e, c, 'resize-end')}
                      />
                    </>
                  )}
                  <div className="cue-label">
                    {c.locked && <span className="lock-badge">🔒</span>}
                    <span className="cue-text">{firstLine(c.text)}</span>
                  </div>
                </div>
              );
            })}

            {/* 两点同步虚影预览：与原片段同泳道，虚线框标示校准后的位置 */}
            {ghosts.map((g) => (
              <div
                key={`ghost-${g.id}`}
                className="cue-block ghost"
                style={{
                  left: g.start * pps,
                  width: Math.max(10, (g.end - g.start) * pps),
                  top: 6 + (laneById.get(g.id) ?? 0) * (LANE_HEIGHT + LANE_GAP),
                  height: LANE_HEIGHT,
                }}
                title={`预览：${formatTimecode(g.start)} → ${formatTimecode(g.end)}`}
              >
                <div className="cue-label">
                  <span className="cue-text">{firstLine(g.text)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* 拖动时间提示 */}
          {hint && (
            <div className={`drag-hint ${hint.stuck ? 'stuck' : ''}`} style={{ left: Math.min(hint.x + 12, extent * pps - 200) }}>
              {hint.text}
            </div>
          )}
        </div>
      </div>

      {/* 悬停/选中片段的时间码读数 */}
      <div className="timeline-readout">
        {(() => {
          const c = hoverCue ?? (selectedId ? cues.find((x) => x.id === selectedId) : null);
          if (!c) return <span className="muted">将鼠标移到片段上查看时间码</span>;
          return (
            <>
              <strong>{firstLine(c.text) || '(空文本)'}</strong>
              <span className="mono">
                {formatTimecode(c.start)} → {formatTimecode(c.end)}
              </span>
              <span className="muted mono">时长 {(c.end - c.start).toFixed(3)}s</span>
              {c.locked && <span className="tag tag-locked">已锁定</span>}
            </>
          );
        })()}
      </div>
    </div>
  );
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.replace(/<[^>]+>/g, '') ?? '';
}
