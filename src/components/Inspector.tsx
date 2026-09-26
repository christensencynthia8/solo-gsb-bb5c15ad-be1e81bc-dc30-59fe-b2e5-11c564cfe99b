import type { Cue } from '../lib/types';
import { analyzeCueLayout, updateCueSetting, validateLayoutValue, ALIGN_VALUES, type LayoutKey } from '../lib/layout';
import TimeCodeInput from './TimeCodeInput';

interface Props {
  cue: Cue | null;
  index: number; // 按 start 排序后的序号（1 起），仅显示用
  onPatch: (id: string, patch: Partial<Cue>) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}

/** 选中片段的详细检查器：手动编辑时间码、布局、文本、设置、锁定 */
export default function Inspector({ cue, index, onPatch, onDelete, onDuplicate }: Props) {
  if (!cue) {
    return (
      <section className="panel">
        <h2>片段检查器</h2>
        <p className="muted small">在时间轴或下方列表中选择一个片段后，可在此精确编辑。</p>
      </section>
    );
  }

  const layout = analyzeCueLayout(cue);

  /** 只改四个布局字段之一，其它（未知）cue 设置保持原顺序与内容 */
  function setLayout(key: LayoutKey, value: string) {
    onPatch(cue!.id, { settings: updateCueSetting(cue!.settings, key, value) });
  }

  const fieldBad = (key: LayoutKey) =>
    layout.raw[key] !== '' && validateLayoutValue(key, layout.raw[key]) !== null;

  const alignKnown = (ALIGN_VALUES as readonly string[]).includes(layout.raw.align);

  return (
    <section className="panel inspector">
      <h2>
        片段 #{index}
        <span className="ml">
          <button className="mini" onClick={() => onDuplicate(cue.id)} title="复制一个相同片段">复制</button>
          <button className="mini danger" onClick={() => onDelete(cue.id)}>删除</button>
        </span>
      </h2>

      <div className="row">
        <label className="chk">
          <input
            type="checkbox"
            checked={cue.locked}
            onChange={(e) => onPatch(cue.id, { locked: e.target.checked })}
          />
          🔒 锁定（拖动其它片段时不得推动此片段）
        </label>
      </div>

      <div className="row time-row">
        <span>开始</span>
        <TimeCodeInput value={cue.start} disabled={cue.locked} onCommit={(v) => onPatch(cue.id, { start: v })} />
        <span className="muted">结束</span>
        <TimeCodeInput value={cue.end} disabled={cue.locked} onCommit={(v) => onPatch(cue.id, { end: v })} />
      </div>
      <div className="row muted small mono">时长 {(cue.end - cue.start).toFixed(3)}s</div>

      <div className="row">
        <label className="field-label">画面布局（留空即移除该设置；未知 cue 设置不受影响）</label>
        <div className="layout-grid">
          <span className="mono">line</span>
          <input
            className={`layout-input mono ${fieldBad('line') ? 'bad' : ''}`}
            value={layout.raw.line}
            placeholder="如 90% 或 12"
            spellCheck={false}
            onChange={(e) => setLayout('line', e.target.value)}
          />
          <span className="mono">position</span>
          <input
            className={`layout-input mono ${fieldBad('position') ? 'bad' : ''}`}
            value={layout.raw.position}
            placeholder="如 50%"
            spellCheck={false}
            onChange={(e) => setLayout('position', e.target.value)}
          />
          <span className="mono">size</span>
          <input
            className={`layout-input mono ${fieldBad('size') ? 'bad' : ''}`}
            value={layout.raw.size}
            placeholder="如 80%"
            spellCheck={false}
            onChange={(e) => setLayout('size', e.target.value)}
          />
          <span className="mono">align</span>
          <select
            className={`layout-select mono ${fieldBad('align') ? 'bad' : ''}`}
            value={layout.raw.align}
            onChange={(e) => setLayout('align', e.target.value)}
          >
            <option value="">（未设置）</option>
            {ALIGN_VALUES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
            {layout.raw.align !== '' && !alignKnown && (
              <option value={layout.raw.align}>{layout.raw.align}（非法）</option>
            )}
          </select>
        </div>
        {layout.errors.length > 0 && (
          <div className="layout-errors">
            {layout.errors.map((e) => (
              <span key={e}>⛔ {e}</span>
            ))}
          </div>
        )}
      </div>

      <div className="row">
        <label className="field-label">字幕文本（多行与内联标签都会保留）</label>
        <textarea
          className="cue-text-edit"
          rows={4}
          value={cue.text}
          onChange={(e) => onPatch(cue.id, { text: e.target.value })}
        />
      </div>

      <div className="row">
        <label className="field-label">cue 设置完整字符串（上方布局控件只改 line/position/size/align，其余原样保留）</label>
        <input
          className="settings-input mono"
          value={cue.settings}
          placeholder="如：line:90% position:50% align:middle"
          onChange={(e) => onPatch(cue.id, { settings: e.target.value })}
        />
      </div>

      <div className="row">
        <label className="field-label">cue 标识符（可选）</label>
        <input
          className="settings-input mono"
          value={cue.identifier}
          onChange={(e) => onPatch(cue.id, { identifier: e.target.value })}
        />
      </div>
    </section>
  );
}
