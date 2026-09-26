import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { parseVTT } from '../lib/vtt';
import { planMerge, joinBilingualText, OVERLAP_RATIO, type MergeEntry } from '../lib/merge';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 主轨：当前字幕（已按 start 排序），确认后其时间/标识符/设置/锁定状态原样保留 */
  cues: Cue[];
  /** 确认合并：把每条配对副轨文本作为新一行追加到对应主轨 */
  onApply: (entries: MergeEntry[], paired: number) => void;
  onJump: (id: string) => void;
}

/**
 * 合并双语轨面板：
 * 粘贴或选择另一份 WebVTT 作为副轨；仅把时间交集占较短片段 ≥50% 的主副
 * 片段列为候选，并求保持双方顺序、每条最多用一次、总交集时长最大的配对
 * （并列时取副轨索引序列字典序更小方案）。解析后只预览不改数据；确认后
 * 仅将配对副轨文本作为新一行追加到主轨，未配对副轨不写入。
 */
export default function MergePanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [secondary, setSecondary] = useState<Cue[] | null>(null);

  const plan = useMemo(
    () => (secondary ? planMerge(cues, secondary) : null),
    [cues, secondary],
  );
  const pairByPrimary = useMemo(
    () => new Map((plan?.pairs ?? []).map((p) => [p.primaryIndex, p])),
    [plan],
  );

  function parse(rawText: string) {
    const res = parseVTT(rawText);
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
    setSecondary(res.cues);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setRaw(text);
      parse(text);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function backToInput() {
    setSecondary(null);
  }

  function cancelAll() {
    // 取消而不改数据：丢弃副轨与预览，回到收起状态
    setSecondary(null);
    setRaw('');
    setError(null);
    setOpen(false);
  }

  function confirm() {
    if (!plan || plan.pairs.length === 0) return;
    const entries: MergeEntry[] = plan.pairs.map((pair) => {
      const primary = plan.primary[pair.primaryIndex];
      const sub = plan.secondary[pair.secondaryIndex];
      return { primaryId: primary.id, mergedText: joinBilingualText(primary.text, sub.text) };
    });
    onApply(entries, entries.length);
    cancelAll();
  }

  if (!open) {
    return (
      <section className="panel merge-panel">
        <h2>
          合并双语轨
          <span className="muted small ml">主轨 + 副轨</span>
        </h2>
        <p className="muted small">
          以当前字幕为主轨，再提供一份 WebVTT 作为副轨：按时间交集自动配对，确认后仅把配对副轨文本追加为新一行。
        </p>
        <button className="btn primary" disabled={cues.length === 0} onClick={() => setOpen(true)}>
          选择 / 粘贴副轨 WebVTT
        </button>
      </section>
    );
  }

  return (
    <section className="panel merge-panel">
      <h2>
        合并双语轨
        <span className="muted small ml">主轨 {cues.length} 条{secondary ? ` · 副轨 ${secondary.length} 条` : ''}</span>
      </h2>

      {!secondary && (
        <>
          <p className="muted small">
            当前字幕为主轨。选择或粘贴另一份 WebVTT 作为副轨后仅做解析与预览，不会改动任何数据。
          </p>
          <div className="merge-actions">
            <label className="btn primary">
              选择 .vtt 文件…
              <input type="file" accept=".vtt,text/vtt,text/plain" hidden onChange={onFile} />
            </label>
            <button className="btn" onClick={() => setRaw('')}>清空</button>
          </div>
          <textarea
            className="paste-area mono merge-paste"
            rows={8}
            placeholder="WEBVTT&#10;&#10;00:00.000 --> 00:02.000&#10;Second-language line…"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(null);
            }}
          />
          {error && <div className="import-error">解析失败：{error}</div>}
          <div className="merge-actions end">
            <button className="btn" onClick={cancelAll}>取消</button>
            <button className="btn primary" disabled={!raw.trim()} onClick={() => parse(raw)}>
              解析并预览配对
            </button>
          </div>
        </>
      )}

      {plan && (
        <>
          <p className="muted small">
            候选条件：时间交集占较短片段时长 ≥ {Math.round(OVERLAP_RATIO * 100)}%。
            配对保持双方顺序、每条最多使用一次，总交集时长最大；并列时取副轨索引序列字典序更小方案。
          </p>
          <div className="merge-summary">
            候选 {plan.candidates.length} 对 · 配对 <strong>{plan.pairs.length}</strong> 对 ·
            未配对主轨 {plan.unmatchedPrimary.length} 条 · 未配对副轨 {plan.unmatchedSecondary.length} 条
            {plan.pairs.length > 0 && (
              <> · 总交集 {plan.totalOverlap.toFixed(2)}s</>
            )}
          </div>

          <div className="merge-section-label">主轨预览（{plan.primary.length} 条）</div>
          <ul className="merge-list">
            {plan.primary.map((cue, i) => {
              const pair = pairByPrimary.get(i) ?? null;
              const sub = pair ? plan.secondary[pair.secondaryIndex] : null;
              return (
                <li
                  key={cue.id}
                  className={`merge-row ${sub ? 'paired' : 'alone'}${cue.locked ? ' locked' : ''}`}
                  onClick={() => onJump(cue.id)}
                  title="点击定位到该主轨片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    <span>
                      {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                    </span>
                    {cue.locked && <span className="merge-lock">🔒</span>}
                  </div>
                  <div className="merge-text main">{cue.text}</div>
                  {sub && (
                    <div className="merge-text sub">
                      <span className="merge-tag mono">副 #{pair!.secondaryIndex + 1} · 交集 {pair!.overlap.toFixed(2)}s</span>
                      <span className="merge-sub-body">{sub.text}</span>
                    </div>
                  )}
                  {!sub && <div className="merge-unpaired">未配对（文本保持不变）</div>}
                </li>
              );
            })}
          </ul>

          <div className="merge-section-label">
            未配对副轨（{plan.unmatchedSecondary.length} 条，不会写入）
          </div>
          {plan.unmatchedSecondary.length === 0 ? (
            <div className="muted small merge-empty">无，全部副轨片段均已配对。</div>
          ) : (
            <ul className="merge-list sub-unpaired">
              {plan.unmatchedSecondary.map((j) => {
                const cue = plan.secondary[j];
                return (
                  <li key={j} className="merge-row alone">
                    <div className="merge-head mono">
                      <span className="merge-idx">#{j + 1}</span>
                      <span>
                        {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                      </span>
                    </div>
                    <div className="merge-text sub-only">{cue.text}</div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="merge-actions end">
            <button className="btn" onClick={backToInput}>重新选择副轨</button>
            <button className="btn" onClick={cancelAll}>取消</button>
            <button className="btn primary" disabled={plan.pairs.length === 0} onClick={confirm}>
              确认合并（{plan.pairs.length} 对）
            </button>
          </div>
        </>
      )}
    </section>
  );
}
