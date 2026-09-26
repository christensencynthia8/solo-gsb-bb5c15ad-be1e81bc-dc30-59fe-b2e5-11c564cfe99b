import type { Cue } from '../lib/types';
import { analyzeCueLayout, stripTags, SAFE_MARGIN_PCT, type TextAlign } from '../lib/layout';

interface Props {
  cue: Cue | null;
}

function cssTextAlign(a: TextAlign): 'left' | 'center' | 'right' {
  // 预览按 LTR 展示：start→左，end→右
  if (a === 'left' || a === 'start') return 'left';
  if (a === 'right' || a === 'end') return 'right';
  return 'center';
}

/** 16:9 画面布局预览：显示所选片段的字幕框与 10% 安全区 */
export default function LayoutPreview({ cue }: Props) {
  const layout = cue ? analyzeCueLayout(cue) : null;
  const lines = cue ? cue.text.split('\n').filter((l) => l.trim().length > 0) : [];
  const outside = !!layout && layout.hasGeometry && layout.outsideSafe;

  return (
    <section className="panel">
      <h2>
        画面布局预览
        <span className="muted small ml">16:9 · 安全区 {SAFE_MARGIN_PCT}%</span>
      </h2>

      <div className="layout-preview">
        <div className="safe-rect" />
        <span className="safe-tag">安全区</span>
        {cue && layout ? (
          <div
            className={`preview-cue${outside ? ' outside' : ''}`}
            style={{
              left: `${layout.left}%`,
              top: `${layout.top}%`,
              width: `${layout.width}%`,
              height: `${layout.height}%`,
              textAlign: cssTextAlign(layout.textAlign),
            }}
            title={`左 ${layout.left.toFixed(1)}% · 上 ${layout.top.toFixed(1)}% · 宽 ${layout.width.toFixed(1)}% · 高 ${layout.height.toFixed(1)}%`}
          >
            {lines.map((l, i) => (
              <div key={i} className="preview-cue-line">
                {stripTags(l)}
              </div>
            ))}
          </div>
        ) : (
          <div className="preview-empty muted small">选择一个片段以预览画面布局</div>
        )}
      </div>

      {cue && layout && (
        <div className="preview-readout small">
          <span className="mono muted">
            左 {layout.left.toFixed(1)}% · 上 {layout.top.toFixed(1)}% · 宽 {layout.width.toFixed(1)}% · 高{' '}
            {layout.height.toFixed(1)}%
          </span>
          {layout.errors.map((e) => (
            <span key={e} className="preview-err">
              ⛔ {e}
            </span>
          ))}
          {outside && <span className="preview-warn">⚠️ 字幕框超出 10% 安全区：{layout.safeViolations.join('；')}</span>}
          {!layout.hasGeometry && layout.errors.length === 0 && (
            <span className="muted">未设置布局参数，按播放器默认位置（底部居中）显示。</span>
          )}
        </div>
      )}
    </section>
  );
}
