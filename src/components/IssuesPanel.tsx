import type { Issue } from '../lib/types';

interface Props {
  issues: Issue[];
  onJump: (issue: Issue) => void;
}

/** 问题清单：错误（重叠/非法时间）与警告（间隔过小/时长不足/布局问题）分组展示 */
export default function IssuesPanel({ issues, onJump }: Props) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return (
    <section className="panel issues">
      <h2>
        问题清单
        <span className="counts ml">
          {errors.length > 0 && <span className="badge err">{errors.length} 错误</span>}
          {warnings.length > 0 && <span className="badge warn">{warnings.length} 警告</span>}
          {issues.length === 0 && <span className="badge ok">全部通过</span>}
        </span>
      </h2>
      {issues.length === 0 ? (
        <p className="muted small">当前没有时序或布局问题，可以放心导出。</p>
      ) : (
        <ul className="issue-list">
          {[...errors, ...warnings].map((i) => (
            <li key={i.key} className={`issue-item ${i.severity}`} onClick={() => onJump(i)}>
              <span className="issue-icon">{i.severity === 'error' ? '⛔' : '⚠️'}</span>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
