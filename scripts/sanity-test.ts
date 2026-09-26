import assert from 'node:assert';
import { parseTimecode, formatTimecode } from '../src/lib/time';
import { parseVTT, serializeVTT } from '../src/lib/vtt';
import { applyDrag } from '../src/lib/solver';
import { planTwoPointSync } from '../src/lib/sync';
import { planMerge, joinBilingualText } from '../src/lib/merge';
import { detectIssues } from '../src/lib/issues';
import {
  parseCueSettings,
  serializeCueSettings,
  getCueSetting,
  updateCueSetting,
  validateLayoutValue,
  analyzeCueLayout,
} from '../src/lib/layout';
import type { Cue, Settings } from '../src/lib/types';

let passed = 0;
function ok(name: string) { passed++; console.log('  ✓', name); }

interface TCue { id: string; s: number; e: number; l?: boolean }
function mk(spec: TCue[]): Cue[] {
  return spec.map((c) => ({
    id: c.id, identifier: '', start: c.s, end: c.e, text: `t-${c.id}`, settings: '', locked: !!c.l,
  }));
}
const get = (cs: Cue[], id: string) => cs.find((c) => c.id === id)!;

// ---------- 时间码 ----------
assert.strictEqual(parseTimecode('00:03.200'), 3.2);
assert.strictEqual(parseTimecode('01:02:03.456'), 3723.456);
assert.strictEqual(parseTimecode('00:03,200'), 3.2);
assert.strictEqual(parseTimecode('99:99.000'), null);
assert.strictEqual(formatTimecode(3.2), '00:03.200');
assert.strictEqual(formatTimecode(3723.456), '01:02:03.456');
ok('时间码解析/格式化');

// ---------- VTT 往返 ----------
const vtt = `WEBVTT

NOTE 请保留我

1
00:00.000 --> 00:02.500 line:90% position:50% align:middle
第一行
<b>第二行</b>

2
00:02.600 --> 00:05.000
你好
`;
const parsed = parseVTT(vtt);
assert.ok(!parsed.error, parsed.error);
assert.strictEqual(parsed.cues.length, 2);
assert.strictEqual(parsed.cues[0].identifier, '1');
assert.strictEqual(parsed.cues[0].settings, 'line:90% position:50% align:middle');
assert.strictEqual(parsed.cues[0].text, '第一行\n<b>第二行</b>');
assert.ok(parsed.preamble.some((p) => p.includes('请保留我')));
const out = serializeVTT(parsed.cues, parsed.preamble);
assert.ok(out.startsWith('WEBVTT\n'));
assert.ok(out.includes('NOTE 请保留我'));
assert.ok(out.includes('line:90% position:50% align:middle'));
assert.ok(out.includes('<b>第二行</b>'));
assert.ok(out.includes('00:00.000 --> 00:02.500'));
const reparsed = parseVTT(out);
assert.strictEqual(reparsed.cues.length, 2);
ok('VTT 解析/序列化保留文本、设置、标识符、NOTE');

// ---------- 求解器 ----------
const GAP = 0.1, MIN = 1;

// 1. 向右移动：推动后续片段，保持时长与间隔
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [1, 3]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.1, 5]);
  ok('右移推动后续片段');
}

// 2. 向右移动空间充足时不影响更远的片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 6 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [5, 6]);
  ok('空间充足时不推动');
}

// 3. 撞锁定片段，中间片段可压缩吸收 => 可行
{
  // a [0,3] b [3.1,6] dur 2.9 ; locked c [6.1,8]
  // a 右缘目标 4.9：b 刚性到 [5.0,7.9] 撞 c(6.1) => 压缩 b 为 [5.0,6.0]（dur 1）恰好可行
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 6 }, { id: 'c', s: 6.1, e: 8, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1.9, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  const b = get(r.cues, 'b'), c = get(r.cues, 'c'), a = get(r.cues, 'a');
  assert.strictEqual(b.end - b.start >= 1 - 1e-6, true);
  assert.strictEqual(c.start, 6.1); // 锁定不动
  assert.strictEqual(b.end + GAP <= c.start + 1e-6, true);
  assert.strictEqual(a.end + GAP <= b.start + 1e-6, true);
  ok('撞锁定片段时中间片段压缩吸收');
}

// 3b. 同上场景，再多压一点即无解
{
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 6 }, { id: 'c', s: 6.1, e: 8, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 2, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.strictEqual(get(r.cues, 'c').start, 6.1);
  ok('压缩到极限后再多拖 => 无解');
}

// 4. 撞锁定片段且无法压缩 => 无解，冲突区间含锁定片段
{
  const cs = mk([{ id: 'a', s: 0, e: 3 }, { id: 'b', s: 3.1, e: 4.2 }, { id: 'c', s: 4.3, e: 8, l: true }]);
  // a 右缘目标 5.5：b 最多压到 [3.2,4.2](dur1)，边界 4.1；5.5>4.1 无解
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 2.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflict);
  assert.strictEqual(get(r.cues, 'c').start, 4.3);
  ok('锁定阻挡且压缩不足 => 无解');
}

// 5. 向左移动推动前方片段（a 压缩到最小时长）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 1.1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [1.1, 3]);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 1]);
  ok('左移推动并压缩前方片段');
}

// 5b. 向左移动、间隔仍充足时不影响前方片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 3, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 2.4, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 2]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [2.4, 3.4]);
  ok('左移间隔充足时不推动');
}

// 5c. 向左移动碰到前方片段后刚性平移
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: 1.6, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  // a 刚性平移到 [-0.5,1.5] 后撞墙，压缩吸收为 [0,1.5]（仍满足 gap）；b = [1.6,3.5]
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 1.5]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [1.6, 3.5]);
  ok('左移刚性平移，越墙部分被吸收');
}

// 6. 向左越界 => 无解
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'b', op: 'move', desired: -1.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflict!.range[0] === 0);
  ok('向左超出 0s => 无解');
}

// 7. 左侧锁定片段阻挡，中间压缩可吸收 => 可行
{
  // L [0,2] locked; b [2.1,5]; c[5.1,7] 目标 c.start=3
  // b 刚性: end<=2.9 => [0,2.9]? 撞 L: end<=1.9 => 压缩 b start>=2.1(L.end+gap) dur>=1 => end>=3.1
  // c.start=3 <= 3.1+0.1=3.2? 需要 leftBound(3.2) <= 3 => 无解！改成 desired 3.2
  const cs = mk([{ id: 'L', s: 0, e: 2, l: true }, { id: 'b', s: 2.1, e: 5 }, { id: 'c', s: 5.1, e: 7 }]);
  const r = applyDrag({ cues: cs, targetId: 'c', op: 'move', desired: 3.2, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible, r.conflict?.reason);
  const b = get(r.cues, 'b');
  assert.strictEqual(b.start, 2.1);
  assert.strictEqual(Math.abs(b.end - 3.1) < 1e-6, true);
  assert.strictEqual(get(r.cues, 'L').end, 2);
  ok('左侧锁定 + 中间压缩可行');
}

// 8. resize-end 向右推动后续
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'resize-end', desired: 3.5, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'a').start, get(r.cues, 'a').end], [0, 3.5]);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.6, 5.5]);
  ok('右边界拖动推动后续');
}

// 9. resize 短于最小时长 => 无解
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'resize-end', desired: 0.5, minDuration: MIN, minGap: GAP });
  assert.strictEqual(r.feasible, false);
  ok('短于最小时长 => 无解');
}

// 10. 锁定目标不可拖（视为无变化可行）
{
  const cs = mk([{ id: 'a', s: 0, e: 2, l: true }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 5, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.strictEqual(get(r.cues, 'a').start, 0);
  ok('锁定片段自身不移动');
}

// 11. 连续三个片段链式推移，末端开放 => 全部平移，时长保持
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }, { id: 'c', s: 4.1, e: 6 }]);
  const r = applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 1, minDuration: MIN, minGap: GAP });
  assert.ok(r.feasible);
  assert.deepStrictEqual([get(r.cues, 'b').start, get(r.cues, 'b').end], [3.1, 5]);
  assert.deepStrictEqual([get(r.cues, 'c').start, get(r.cues, 'c').end], [5.1, 7]);
  ok('链式刚性推移');
}

// 12. 原始 baseline 不被修改（撤销语义依赖快照）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 2.1, e: 4 }]);
  const snapshot = JSON.parse(JSON.stringify(cs));
  applyDrag({ cues: cs, targetId: 'a', op: 'move', desired: 9, minDuration: MIN, minGap: GAP });
  assert.deepStrictEqual(cs, snapshot);
  ok('输入数组不被原地修改');
}

// ---------- 画面布局：cue 设置编辑 ----------

// 13. 编辑四个布局字段时保留未知设置的原始顺序与内容
{
  const src = 'vertical:rl line:10% foo:bar position:20%';
  // 就地替换，位置不变
  assert.strictEqual(updateCueSetting(src, 'line', '90%'), 'vertical:rl line:90% foo:bar position:20%');
  // 不存在的字段追加到末尾
  assert.strictEqual(updateCueSetting(src, 'size', '80%'), 'vertical:rl line:10% foo:bar position:20% size:80%');
  // 置空即删除，其它设置原样保留
  assert.strictEqual(updateCueSetting(src, 'position', ''), 'vertical:rl line:10% foo:bar');
  // 同名重复设置：替换第一个并移除后续重复项
  assert.strictEqual(updateCueSetting('line:10% line:20% align:left', 'line', '50%'), 'line:50% align:left');
  // 空设置串上新增 / 删除唯一字段
  assert.strictEqual(updateCueSetting('', 'align', 'center'), 'align:center');
  assert.strictEqual(updateCueSetting('align:center', 'align', ''), '');
  // 读取与往返
  assert.strictEqual(getCueSetting(src, 'line'), '10%');
  assert.strictEqual(getCueSetting(src, 'size'), '');
  assert.strictEqual(serializeCueSettings(parseCueSettings(src)), src);
  ok('布局字段编辑保留未知设置的顺序与内容');
}

// 14. 布局字段取值校验
{
  assert.strictEqual(validateLayoutValue('line', '90%'), null);
  assert.strictEqual(validateLayoutValue('line', '12'), null);
  assert.strictEqual(validateLayoutValue('line', '-1,end'), null);
  assert.ok(validateLayoutValue('line', '120%') !== null);
  assert.ok(validateLayoutValue('line', 'abc') !== null);
  assert.strictEqual(validateLayoutValue('position', '50%,line-right'), null);
  assert.ok(validateLayoutValue('position', '50') !== null);
  assert.strictEqual(validateLayoutValue('size', '80%'), null);
  assert.ok(validateLayoutValue('size', '0.5') !== null);
  assert.strictEqual(validateLayoutValue('align', 'center'), null);
  assert.ok(validateLayoutValue('align', 'middle') !== null);
  ok('布局字段取值校验');
}

// 15. 字幕框几何与安全区检测
{
  // 显式 size：按 cue 框计算；line:90%,end 表示框底对齐 90%
  const a = analyzeCueLayout({ settings: 'line:90%,end position:50% size:80% align:center', text: '测试' });
  assert.ok(Math.abs(a.left - 10) < 1e-6 && Math.abs(a.width - 80) < 1e-6);
  assert.ok(Math.abs(a.top - (90 - 5.33)) < 1e-6 && Math.abs(a.height - 5.33) < 1e-6);
  assert.strictEqual(a.errors.length, 0);
  assert.strictEqual(a.outsideSafe, false); // 底边 90%，在容差内

  // line 默认 start 对齐：line:95% => 框顶在 95%，底边越界
  const b = analyzeCueLayout({ settings: 'line:95%', text: '测试文本' });
  assert.strictEqual(b.hasGeometry, true);
  assert.strictEqual(b.outsideSafe, true);
  assert.ok(b.safeViolations.some((v) => v.startsWith('下侧')));

  // position 对齐缺省时按 align 推导：align:right => 框右缘对齐 position
  const c = analyzeCueLayout({ settings: 'position:80% size:40% align:right', text: 'x' });
  assert.ok(Math.abs(c.left - 40) < 1e-6 && Math.abs(c.width - 40) < 1e-6);

  // 无显式几何 => 不做安全区判定；非法 align 进入 errors
  const d = analyzeCueLayout({ settings: 'align:middle', text: 'x' });
  assert.strictEqual(d.hasGeometry, false);
  assert.strictEqual(d.errors.length, 1);
  ok('字幕框几何与安全区检测');
}

// 16. 问题清单包含布局问题（非法值 + 超出安全区），且为警告、可定位到片段
{
  const cs: Cue[] = [
    { id: 'x', identifier: '', start: 0, end: 2, text: '你好', settings: 'align:middle line:95%', locked: false },
    { id: 'y', identifier: '', start: 3, end: 5, text: '世界', settings: '', locked: false },
  ];
  const st: Settings = { minDuration: 1, minGap: 0.1 };
  const iss = detectIssues(cs, st);
  const layout = iss.filter((i) => i.kind === 'layout');
  assert.strictEqual(layout.length, 2);
  assert.ok(layout.every((i) => i.severity === 'warning'));
  assert.ok(layout.every((i) => i.cueIds[0] === 'x'));
  assert.ok(layout.some((i) => i.message.includes('非法')));
  assert.ok(layout.some((i) => i.message.includes('安全区')));
  // 无布局问题的片段不产生 layout 条目
  assert.ok(!layout.some((i) => i.cueIds[0] === 'y'));
  ok('问题清单包含布局非法值与安全区越界');
}

// 17. 布局编辑后导出：未知 cue 设置顺序与内容保留
{
  const v = `WEBVTT

1
00:00.000 --> 00:02.000 vertical:rl line:10% foo:bar
你好
`;
  const p = parseVTT(v);
  assert.ok(!p.error, p.error);
  const c = p.cues[0];
  const updated = updateCueSetting(c.settings, 'position', '40%');
  const out = serializeVTT([{ ...c, settings: updated }], p.preamble);
  assert.ok(out.includes('vertical:rl line:10% foo:bar position:40%'));
  // 时序导出行为不变
  assert.ok(out.includes('00:00.000 --> 00:02.000'));
  ok('导出时未知 cue 设置顺序与内容保留');
}

// ---------- 两点同步 ----------

// 18. 基本线性映射：闭区间内未锁定片段全部变换，区间外不变
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 3, e: 5 }, { id: 'c', s: 6, e: 8 }, { id: 'd', s: 20, e: 22 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'c', newStartA: 10, newStartB: 14, minDuration: 1, minGap: 0.1 });
  assert.ok(r.feasible, r.conflicts.map((x) => x.reason).join('；'));
  // scale = (14-10)/(6-0) = 2/3，offset = 10
  assert.ok(Math.abs(r.scale - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.offset - 10) < 1e-9);
  assert.deepStrictEqual([...r.affectedIds].sort(), ['a', 'b', 'c']);
  const b = get(r.cues, 'b');
  assert.ok(Math.abs(b.start - 12) < 1e-6 && Math.abs(b.end - 40 / 3) < 1e-6);
  const a2 = get(r.cues, 'a');
  assert.ok(Math.abs(a2.start - 10) < 1e-6 && Math.abs(a2.end - 34 / 3) < 1e-6);
  const d = get(r.cues, 'd');
  assert.deepStrictEqual([d.start, d.end], [20, 22]);
  ok('两点同步：线性映射变换闭区间内片段，区间外不变');
}

// 19. 区间内锁定片段保持不变；与其碰撞 => 禁止应用且不部分写入
{
  const cs = mk([{ id: 'a', s: 10, e: 12 }, { id: 'L', s: 12.1, e: 14, l: true }, { id: 'b', s: 14.1, e: 16 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 10, newStartB: 13, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.length >= 1);
  assert.ok(r.conflicts.some((c) => c.cueIds.includes('L')));
  // 不部分写入：返回的 cues 与原始一致
  assert.strictEqual(get(r.cues, 'a').start, 10);
  assert.strictEqual(get(r.cues, 'b').start, 14.1);
  assert.strictEqual(get(r.cues, 'L').start, 12.1);
  ok('两点同步：锁定片段不变，冲突时禁止应用且不部分写入');
}

// 20. 新旧锚点顺序无效均被拒绝
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 7 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 10, newStartB: 9, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts[0].reason.includes('顺序'));
  // 锚点先后颠倒（锚点 1 晚于锚点 2）同样无效
  const r2 = planTwoPointSync({ cues: cs, anchorAId: 'b', anchorBId: 'a', newStartA: 5, newStartB: 6, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r2.feasible, false);
  assert.ok(r2.conflicts[0].reason.includes('顺序'));
  ok('两点同步：新旧锚点顺序无效均被拒绝');
}

// 21. 变换后时长低于当前最小时长 => 禁止并列出冲突片段
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 10, e: 12 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0, newStartB: 4, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.some((c) => c.reason.includes('时长') && c.cueIds.includes('a')));
  assert.ok(r.conflicts.some((c) => c.reason.includes('时长') && c.cueIds.includes('b')));
  ok('两点同步：变换后时长低于最小时长被拒绝');
}

// 22. 区间边界相邻片段间隔不足 => 禁止并列出两侧片段
{
  const cs = mk([{ id: 'x', s: 0, e: 1 }, { id: 'a', s: 2, e: 4 }, { id: 'b', s: 8, e: 10 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 1.05, newStartB: 7.05, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.some((c) => c.cueIds.includes('x') && c.cueIds.includes('a')));
  ok('两点同步：区间边界相邻片段间隔不足被拒绝');
}

// 23. 校准后不得早于时间轴起点
{
  const cs = mk([{ id: 'a', s: 1, e: 2 }, { id: 'b', s: 5, e: 6 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: -0.5, newStartB: 3.5, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts.some((c) => c.reason.includes('00:00')));
  ok('两点同步：校准后早于 00:00.000 被拒绝');
}

// 24. 锚点必须未锁定且互不相同
{
  const cs = mk([{ id: 'a', s: 0, e: 2, l: true }, { id: 'b', s: 5, e: 7 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0, newStartB: 5, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r.feasible, false);
  assert.ok(r.conflicts[0].reason.includes('锁定'));
  const r2 = planTwoPointSync({ cues: cs, anchorAId: 'b', anchorBId: 'b', newStartA: 0, newStartB: 5, minDuration: 1, minGap: 0.1 });
  assert.strictEqual(r2.feasible, false);
  ok('两点同步：锚点必须未锁定且互不相同');
}

// 25. 可行时区间内锁定片段保持不动，输入数组不被原地修改
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'L', s: 2.5, e: 3.5, l: true }, { id: 'b', s: 4, e: 6 }]);
  const snapshot = JSON.parse(JSON.stringify(cs));
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0.4, newStartB: 4.4, minDuration: 1, minGap: 0.1 });
  assert.ok(r.feasible, r.conflicts.map((x) => x.reason).join('；'));
  assert.deepStrictEqual([get(r.cues, 'L').start, get(r.cues, 'L').end], [2.5, 3.5]);
  assert.ok(Math.abs(get(r.cues, 'a').start - 0.4) < 1e-6);
  assert.ok(Math.abs(get(r.cues, 'b').start - 4.4) < 1e-6);
  assert.deepStrictEqual(cs, snapshot);
  ok('两点同步：可行时锁定片段不动，输入不被修改');
}

// 26. 恒等映射可识别（面板据此禁用应用）
{
  const cs = mk([{ id: 'a', s: 0, e: 2 }, { id: 'b', s: 5, e: 7 }]);
  const r = planTwoPointSync({ cues: cs, anchorAId: 'a', anchorBId: 'b', newStartA: 0, newStartB: 5, minDuration: 1, minGap: 0.1 });
  assert.ok(r.feasible);
  assert.strictEqual(r.identity, true);
  assert.deepStrictEqual(r.affectedIds.sort(), ['a', 'b']);
  ok('两点同步：恒等映射可识别');
}

// ---------- 合并双语轨 ----------

interface MCue { s: number; e: number; text?: string }
function mkm(spec: MCue[]): Cue[] {
  return spec.map((c, i) => ({
    id: `m${i}`, identifier: '', start: c.s, end: c.e,
    text: c.text ?? `M${i}`, settings: '', locked: false,
  }));
}
function mks(spec: MCue[]): Cue[] {
  return spec.map((c, i) => ({
    id: `s${i}`, identifier: '', start: c.s, end: c.e,
    text: c.text ?? `S${i}`, settings: '', locked: false,
  }));
}

// 27. 基本配对：完全重叠的片段一一配对，总交集为时长之和
{
  const plan = planMerge(mkm([{ s: 0, e: 4 }, { s: 5, e: 9 }]), mks([{ s: 0, e: 4 }, { s: 5, e: 9 }]));
  assert.strictEqual(plan.candidates.length, 2);
  assert.strictEqual(plan.pairs.length, 2);
  assert.deepStrictEqual(plan.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]), [[0, 0], [1, 1]]);
  assert.ok(Math.abs(plan.totalOverlap - 8) < 1e-9);
  assert.deepStrictEqual(plan.unmatchedPrimary, []);
  assert.deepStrictEqual(plan.unmatchedSecondary, []);
  ok('双语合并：完全重叠片段一一配对');
}

// 28. 候选阈值：交集 / 较短片段时长 < 50% 排除；恰为 50% 保留
{
  // 主 [0,3] 时长3，副 [2,10] 时长8，交集 1s，较短3s => 33% 排除
  const plan1 = planMerge(mkm([{ s: 0, e: 3 }]), mks([{ s: 2, e: 10 }]));
  assert.strictEqual(plan1.candidates.length, 0);
  assert.strictEqual(plan1.pairs.length, 0);
  assert.deepStrictEqual(plan1.unmatchedPrimary, [0]);
  assert.deepStrictEqual(plan1.unmatchedSecondary, [0]);

  // 主 [0,4]，副 [2,10]，交集 2s，较短4s => 恰好 50% 保留
  const plan2 = planMerge(mkm([{ s: 0, e: 4 }]), mks([{ s: 2, e: 10 }]));
  assert.strictEqual(plan2.candidates.length, 1);
  assert.strictEqual(plan2.pairs.length, 1);
  assert.ok(Math.abs(plan2.pairs[0].overlap - 2) < 1e-9);

  // 仅端点接触（交集 0）不算候选
  const plan3 = planMerge(mkm([{ s: 0, e: 4 }]), mks([{ s: 4, e: 8 }]));
  assert.strictEqual(plan3.candidates.length, 0);
  ok('双语合并：50% 阈值（边界含）与零交集排除');
}

// 29. 每条最多使用一次、保持顺序、总交集最大
{
  // 长副轨 s0[0,8] 与两条主轨各相交，但只能使用一次；取权重更大的一对
  const plan = planMerge(mkm([{ s: 0, e: 4 }, { s: 4.1, e: 8 }]), mks([{ s: 0, e: 8 }]));
  assert.strictEqual(plan.pairs.length, 1);
  assert.strictEqual(plan.pairs[0].primaryIndex, 0);
  assert.strictEqual(plan.pairs[0].secondaryIndex, 0);
  assert.ok(Math.abs(plan.pairs[0].overlap - 4) < 1e-9);
  assert.deepStrictEqual(plan.unmatchedPrimary, [1]);

  // 交叉配对比顺序配对差时，DP 取保持双方顺序的方案：
  // 主 [0,4]/[6,10]，副 s0[0,4]/s1[6,10]，另一个夹在中间的主 [3,7]
  // 与两条副轨各只相交 1s（25%），不成候选；最优仍是两端同序两对
  const plan2 = planMerge(
    mkm([{ s: 0, e: 4 }, { s: 3, e: 7 }, { s: 6, e: 10 }]),
    mks([{ s: 0, e: 4 }, { s: 6, e: 10 }]),
  );
  assert.strictEqual(plan2.pairs.length, 2);
  assert.deepStrictEqual(plan2.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]), [[0, 0], [2, 1]]);
  assert.deepStrictEqual(plan2.unmatchedPrimary, [1]);
  ok('双语合并：每条最多一次、保持顺序、总交集最大');
}

// 30. 总分并列时取副轨索引序列字典序更小方案
{
  // 两条完全相同的副轨 s1/s2 都与主 p1 完全重叠（各 4s），取副轨索引更小者
  const plan = planMerge(
    mkm([{ s: 0, e: 4 }, { s: 4.1, e: 8 }]),
    mks([{ s: 0, e: 4 }, { s: 4.1, e: 8 }, { s: 4.1, e: 8 }]),
  );
  // 最优：(p0,s0)=4 + (p1,s1)=4，序列 [0,1]；而不是 [0,2]
  assert.strictEqual(plan.pairs.length, 2);
  assert.deepStrictEqual(plan.pairs.map((p) => p.secondaryIndex), [0, 1]);
  assert.deepStrictEqual(plan.unmatchedSecondary, [2]);

  // 单条主轨同时与两条相同副轨等权：取副轨 #1
  const plan2 = planMerge(mkm([{ s: 0, e: 4 }]), mks([{ s: 0, e: 4 }, { s: 0, e: 4 }]));
  assert.strictEqual(plan2.pairs.length, 1);
  assert.strictEqual(plan2.pairs[0].secondaryIndex, 0);
  assert.deepStrictEqual(plan2.unmatchedSecondary, [1]);
  ok('双语合并：并列时副轨索引序列字典序更小');
}

// 30b. 决胜回归：首个副轨相同、所选主轨不同会产生不同后续副轨序列
{
  // 候选：(P0,S0)=1、(P1,S0)=4、(P1,S1)=2、(P1,S2)=5、(P2,S1)=2，最优总分 6。
  // 两个最优方案的首对副轨都是 S0：
  //   选最小主轨 P0 => 后缀只能配 S2，副轨序列 [0,2]（旧实现的错误输出）；
  //   选主轨 P1     => 后缀可配 S1，副轨序列 [0,1]（全局字典序最小）。
  // 决胜必须比较各可行后缀，不能因 P0 主轨索引更小就直接固定它。
  const plan = planMerge(
    mkm([{ s: 0, e: 1 }, { s: 0, e: 13 }, { s: 5, e: 7 }]),
    mks([{ s: 0, e: 4 }, { s: 5, e: 7 }, { s: 8, e: 14 }]),
  );
  assert.strictEqual(plan.candidates.length, 5);
  assert.ok(Math.abs(plan.totalOverlap - 6) < 1e-9);
  assert.deepStrictEqual(
    plan.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]),
    [[1, 0], [2, 1]],
  );
  assert.deepStrictEqual(plan.pairs.map((p) => p.secondaryIndex), [0, 1]);
  assert.deepStrictEqual(plan.unmatchedPrimary, [0]);
  assert.deepStrictEqual(plan.unmatchedSecondary, [2]);
  // 确定性：相同输入重复求解，配对结果完全一致
  const again = planMerge(
    mkm([{ s: 0, e: 1 }, { s: 0, e: 13 }, { s: 5, e: 7 }]),
    mks([{ s: 0, e: 4 }, { s: 5, e: 7 }, { s: 8, e: 14 }]),
  );
  assert.deepStrictEqual(
    again.pairs.map((p) => [p.primaryIndex, p.secondaryIndex]),
    [[1, 0], [2, 1]],
  );
  ok('双语合并：首个副轨相同、主轨选择影响后续副轨序列时取全局字典序最小（确定性）');
}

// 31. 输入不被修改；确认语义：副轨文本作为新一行追加，主轨字段原样保留
{
  const main = mkm([{ s: 0, e: 4, text: '你好' }]);
  main[0].identifier = 'cid-1';
  main[0].settings = 'line:90% align:middle';
  main[0].locked = true;
  const sub = mks([{ s: 0, e: 4, text: 'Hello' }]);
  const snapshot = JSON.parse(JSON.stringify([main, sub]));
  const plan = planMerge(main, sub);
  assert.deepStrictEqual([main, sub], snapshot);
  assert.strictEqual(joinBilingualText(main[0].text, sub[0].text), '你好\nHello');
  // 多行文本各自去尾空白后拼接
  assert.strictEqual(joinBilingualText('A\n', 'B\n\n'), 'A\nB');

  // 模拟确认写入：只改 text，start/end/identifier/settings/locked 原样保留
  const pair = plan.pairs[0];
  const applied = main.map((c) =>
    c.id === plan.primary[pair.primaryIndex].id
      ? { ...c, text: joinBilingualText(c.text, plan.secondary[pair.secondaryIndex].text) }
      : c,
  );
  assert.strictEqual(applied[0].text, '你好\nHello');
  assert.strictEqual(applied[0].start, 0);
  assert.strictEqual(applied[0].end, 4);
  assert.strictEqual(applied[0].identifier, 'cid-1');
  assert.strictEqual(applied[0].settings, 'line:90% align:middle');
  assert.strictEqual(applied[0].locked, true);
  // 未配对副轨不出现在写入结果中（无任何主轨文本包含它）
  assert.ok(!applied.some((c) => c.text.includes('未写入')));
  ok('双语合并：输入不变；确认仅追加文本行，时间/标识符/设置/锁定保留');
}

console.log(`\n全部 ${passed} 组测试通过 ✅`);