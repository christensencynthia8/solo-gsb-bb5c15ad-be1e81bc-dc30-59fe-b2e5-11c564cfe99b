import type { Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

function NumberField({
  label, value, step, onChange,
}: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onChange(Number.isFinite(v) && v >= 0 ? v : 0);
        }}
      />
      <span className="muted">秒</span>
    </label>
  );
}

/** 全局约束设置：最小时长与最小间隔 */
export default function SettingsPanel({ settings, onChange }: Props) {
  return (
    <section className="panel">
      <h2>约束设置</h2>
      <NumberField
        label="最小片段时长"
        value={settings.minDuration}
        step={0.1}
        onChange={(v) => onChange({ ...settings, minDuration: v })}
      />
      <NumberField
        label="相邻片段间隔"
        value={settings.minGap}
        step={0.05}
        onChange={(v) => onChange({ ...settings, minGap: v })}
      />
      <p className="muted small">
        拖动时会按操作方向传播调整；锁定片段保持不动，无法满足约束时自动撤销并标出冲突区间。
      </p>
    </section>
  );
}
