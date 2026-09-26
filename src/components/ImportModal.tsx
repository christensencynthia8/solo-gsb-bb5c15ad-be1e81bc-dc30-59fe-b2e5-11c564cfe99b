import { useState } from 'react';
import { parseVTT } from '../lib/vtt';
import type { Cue } from '../lib/types';

interface Props {
  onClose: () => void;
  onLoad: (cues: Cue[], preamble: string[]) => void;
  hasCues: boolean;
}

/** 粘贴 WebVTT 或通过文件选择导入；解析错误在弹窗内显示 */
export default function ImportModal({ onClose, onLoad, hasCues }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function apply(raw: string) {
    const res = parseVTT(raw);
    if (res.error) {
      setError(res.error);
      return;
    }
    onLoad(res.cues, res.preamble);
    onClose();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => apply(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>导入 WebVTT 字幕</h2>
        <p className="muted small">
          选择 .vtt 文件，或直接把字幕内容粘贴到下方。{hasCues && '导入会替换当前全部片段（含锁定状态）。'}
        </p>
        <div className="modal-actions">
          <label className="btn primary">
            选择文件…
            <input type="file" accept=".vtt,text/vtt,text/plain" hidden onChange={onFile} />
          </label>
          <button className="btn" onClick={() => setText('')}>清空</button>
        </div>
        <textarea
          className="paste-area mono"
          rows={12}
          placeholder="WEBVTT&#10;&#10;00:00.000 --> 00:02.000&#10;第一句字幕…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {error && <div className="import-error">解析失败：{error}</div>}
        <div className="modal-actions end">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!text.trim()}
            onClick={() => {
              if (hasCues && !window.confirm('将替换当前全部片段，确定继续吗？')) return;
              apply(text);
            }}
          >
            解析并载入
          </button>
        </div>
      </div>
    </div>
  );
}
