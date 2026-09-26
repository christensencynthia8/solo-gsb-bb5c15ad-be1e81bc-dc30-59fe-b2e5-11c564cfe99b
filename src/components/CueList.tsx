import type { Cue } from '../lib/types';
import { formatTimecode } from '../lib/time';

interface Props {
  cues: Cue[]; // 已按 start 排序
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleLock: (id: string) => void;
}

/** 片段列表：序号 / 时间码 / 文本预览 / 锁定开关 */
export default function CueList({ cues, selectedId, onSelect, onToggleLock }: Props) {
  return (
    <section className="panel cue-list-panel">
      <h2>
        片段列表
        <span className="muted small ml">{cues.length} 条</span>
      </h2>
      <div className="cue-list">
        {cues.length === 0 && <p className="muted small">暂无片段，请粘贴或导入 WebVTT。</p>}
        {cues.map((c, i) => (
          <div
            key={c.id}
            className={`cue-row ${c.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <span className="cue-index">{i + 1}</span>
            <div className="cue-main">
              <div className="cue-times mono">
                {formatTimecode(c.start)} → {formatTimecode(c.end)}
                <span className="muted"> · {(c.end - c.start).toFixed(2)}s</span>
              </div>
              <div className="cue-preview">{c.text.split('\n')[0] || <em className="muted">(空文本)</em>}</div>
            </div>
            <button
              className={`lock-btn ${c.locked ? 'on' : ''}`}
              title={c.locked ? '取消锁定' : '锁定此片段'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleLock(c.id);
              }}
            >
              {c.locked ? '🔒' : '🔓'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
