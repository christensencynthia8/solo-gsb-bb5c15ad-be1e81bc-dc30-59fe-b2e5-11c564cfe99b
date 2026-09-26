import { useEffect, useMemo, useState } from 'react';
import type { Cue, Settings } from '../lib/types';
import { planTwoPointSync } from '../lib/sync';
import { formatTimecode } from '../lib/time';
import TimeCodeInput from './TimeCodeInput';

interface Props {
  cues: Cue[]; // 已按 start 排序
  settings: Settings;
  /** 虚影预览变化（可行且非恒等时为变换后的受影响片段，否则为空） */
  onPreview: (ghosts: Cue[]) => void;
  /** 确认应用：一次性写入全部校准结果 */
  onApply: (next: Cue[], affected: number) => void;
  onJump: (id: string) => void;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.replace(/<[^>]+>/g, '') ?? '';
}

/**
 * 两点同步批量校准面板：
 * 选择两个按时间排序的未锁定锚点并分别输入新开始时间，
 * 由唯一线性映射整体校准闭区间内的未锁定片段；
 * 输入的同时在时间轴上以虚影预览，确认后一次性写入。
 */
export default function SyncPanel({ cues, settings, onPreview, onApply, onJump }: Props) {
  const [anchorAId, setAnchorAId] = useState('');
  const [anchorBId, setAnchorBId] = useState('');
  const [newA, setNewA] = useState<number | null>(null);
  const [newB, setNewB] = useState<number | null>(null);

  const anchorA = cues.find((c) => c.id === anchorAId) ?? null;
  const anchorB = cues.find((c) => c.id === anchorBId) ?? null;
  // 未手动输入时默认取锚点当前开始时间（恒等映射）
  const effNewA = newA ?? anchorA?.start ?? null;
  const effNewB = newB ?? anchorB?.start ?? null;

  const plan = useMemo(() => {
    if (!anchorA || !anchorB || effNewA === null || effNewB === null) return null;
    return planTwoPointSync({
      cues,
      anchorAId: anchorA.id,
      anchorBId: anchorB.id,
      newStartA: effNewA,
      newStartB: effNewB,
      minDuration: settings.minDuration,
      minGap: settings.minGap,
    });
  }, [cues, anchorA, anchorB, effNewA, effNewB, settings]);

  const ghosts = useMemo(
    () =>
      plan && plan.feasible && !plan.identity
        ? plan.cues.filter((c) => plan.affectedIds.includes(c.id))
        : [],
    [plan],
  );

  useEffect(() => {
    onPreview(ghosts);
    return () => onPreview([]);
  }, [ghosts, onPreview]);

  const canApply = !!plan && plan.feasible && !plan.identity && plan.affectedIds.length > 0;

  function apply() {
    if (!plan || !canApply) return;
    onApply(plan.cues, plan.affectedIds.length);
    // 写入后新开始时间回到“当前开始时间”，等待下一次校准
    setNewA(null);
    setNewB(null);
  }

  function reset() {
    setAnchorAId('');
    setAnchorBId('');
    setNewA(null);
    setNewB(null);
  }

  const unlockedCount = cues.filter((c) => !c.locked).length;

  function anchorSelect(
    value: string,
    onChange: (id: string) => void,
  ) {
    return (
      <select
        className="sync-select mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">（选择片段）</option>
        {cues.map((c, i) => (
          <option key={c.id} value={c.id} disabled={c.locked}>
            #{i + 1} {formatTimecode(c.start)} {c.locked ? '🔒 ' : ''}
            {firstLine(c.text).slice(0, 12) || '(空文本)'}
          </option>
        ))}
      </select>
    );
  }

  return (
    <section className="panel sync-panel">
      <h2>
        两点同步
        <span className="muted small ml">批量校准</span>
      </h2>
      {unlockedCount < 2 ? (
        <p className="muted small">至少需要两个未锁定片段作为锚点才能进行两点同步。</p>
      ) : (
        <>
          <p className="muted small">
            选择两个按时间排序的未锁定锚点并输入新开始时间，闭区间内所有未锁定片段将按唯一线性映射整体校准。
          </p>

          <div className="row">
            <label className="field-label">锚点 1（较早）</label>
            {anchorSelect(anchorAId, (id) => {
              setAnchorAId(id);
              setNewA(null);
            })}
          </div>
          {anchorA && (
            <div className="row time-row">
              <span>新开始 1</span>
              <TimeCodeInput key={`na-${anchorA.id}`} value={effNewA ?? 0} onCommit={setNewA} />
              <span className="muted small mono">原 {formatTimecode(anchorA.start)}</span>
            </div>
          )}

          <div className="row">
            <label className="field-label">锚点 2（较晚）</label>
            {anchorSelect(anchorBId, (id) => {
              setAnchorBId(id);
              setNewB(null);
            })}
          </div>
          {anchorB && (
            <div className="row time-row">
              <span>新开始 2</span>
              <TimeCodeInput key={`nb-${anchorB.id}`} value={effNewB ?? 0} onCommit={setNewB} />
              <span className="muted small mono">原 {formatTimecode(anchorB.start)}</span>
            </div>
          )}

          {plan && plan.interval[1] > plan.interval[0] && (
            <div className="row muted small mono">
              映射 t′ = {plan.scale.toFixed(4)}·t {plan.offset >= 0 ? '+' : '−'}
              {Math.abs(plan.offset).toFixed(3)}s · 区间 {formatTimecode(plan.interval[0])} –{' '}
              {formatTimecode(plan.interval[1])}
            </div>
          )}

          {plan && plan.affectedIds.length > 0 && (
            <div
              className={`sync-status ${plan.feasible ? (plan.identity ? '' : 'ok') : 'bad'}`}
            >
              {plan.feasible
                ? plan.identity
                  ? '当前映射为恒等（无实际变化），修改任一锚点的新开始时间后即可预览。'
                  : `✅ 将影响 ${plan.affectedIds.length} 个片段，时间轴虚影为预览，确认后一次性写入。`
                : `⛔ 存在 ${plan.conflicts.length} 处冲突，已禁止应用，不会部分写入。`}
            </div>
          )}

          {plan && plan.conflicts.length > 0 && (
            <ul className="issue-list sync-conflicts">
              {plan.conflicts.map((c, i) => (
                <li
                  key={i}
                  className="issue-item error"
                  onClick={() => c.cueIds[0] && onJump(c.cueIds[0])}
                >
                  <span className="issue-icon">⛔</span>
                  <span>{c.reason}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="sync-actions">
            <button className="btn primary" disabled={!canApply} onClick={apply}>
              应用校准
            </button>
            <button className="btn" onClick={reset}>
              重置
            </button>
          </div>
        </>
      )}
    </section>
  );
}
