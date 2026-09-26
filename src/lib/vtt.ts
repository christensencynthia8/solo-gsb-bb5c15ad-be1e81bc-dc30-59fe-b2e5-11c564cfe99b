import type { Cue } from './types';
import { parseTimecode, formatTimecode, uid } from './time';

export interface ParseResult {
  /** 文件头部内容（WEBVTT 标题行之后、第一个 cue 之前的任意行，通常为 NOTE/STYLE 等） */
  preamble: string[];
  cues: Cue[];
  error?: string;
}

const TIMING_LINE = /^(.+?)\s*-->\s*(.+?)(?:\s+(.*))?$/;

/**
 * 解析 WebVTT 文本。
 * - 支持 BOM、CRLF
 * - 保留 cue 标识符、cue 设置与多行文本（含时间戳标签等内联标签原样保留）
 * - STYLE/REGION/NOTE 块以及文件级标题之后的杂项行收集到 preamble，导出时原样写回
 */
export function parseVTT(input: string): ParseResult {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rawBlocks = text.split(/\n\n+/).map((b) => b.trim()).filter((b) => b.length > 0);
  if (rawBlocks.length === 0) {
    return { preamble: [], cues: [], error: '文件为空，未找到任何内容。' };
  }

  const preamble: string[] = [];
  const cues: Cue[] = [];

  let first = true;
  for (const block of rawBlocks) {
    const lines = block.split('\n');
    let timingIndex = lines.findIndex((l) => TIMING_LINE.test(l));

    if (first && /^WEBVTT/.test(lines[0] ?? '')) {
      // 头部块：WEBVTT 标题行本身不保留，其余行视为 preamble
      timingIndex = lines.findIndex((l) => TIMING_LINE.test(l));
      if (timingIndex === -1) {
        const rest = lines.slice(1);
        if (rest.length) preamble.push(rest.join('\n'));
        first = false;
        continue;
      }
      const rest = lines.slice(1, timingIndex);
      if (rest.length) preamble.push(rest.join('\n'));
    }
    first = false;

    if (timingIndex === -1) {
      // STYLE / REGION / NOTE 等非 cue 块，原样保留
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0] ?? '')) {
        preamble.push(block);
      } else if (!/^WEBVTT/.test(lines[0] ?? '')) {
        preamble.push(block);
      }
      continue;
    }

    const timingLine = lines[timingIndex];
    const m = TIMING_LINE.exec(timingLine)!;
    const start = parseTimecode(m[1]);
    const end = parseTimecode(m[2]);
    if (start === null || end === null) {
      return { preamble, cues, error: `无法解析时间行：“${timingLine.trim()}”` };
    }
    if (end <= start) {
      return {
        preamble,
        cues,
        error: `片段结束时间必须晚于开始时间：${formatTimecode(start)} --> ${formatTimecode(end)}`,
      };
    }

    const identifier = timingIndex > 0 ? lines.slice(0, timingIndex).join('\n') : '';
    const body = lines.slice(timingIndex + 1).join('\n');
    if (body.trim().length === 0) {
      return { preamble, cues, error: `位于 ${formatTimecode(start)} 的片段缺少字幕文本。` };
    }

    cues.push({
      id: uid(),
      identifier,
      start,
      end,
      text: body,
      settings: (m[3] ?? '').trim(),
      locked: false,
    });
  }

  if (cues.length === 0) {
    return { preamble, cues, error: '未找到任何有效的字幕片段（cue）。' };
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { preamble, cues };
}

/** 序列化为有效 WebVTT。锁定状态属于编辑器状态，不写入文件。 */
export function serializeVTT(cues: Cue[], preamble: string[]): string {
  const out: string[] = ['WEBVTT'];
  for (const block of preamble) {
    if (block.trim()) out.push('', block.trim());
  }
  const ordered = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const cue of ordered) {
    out.push('');
    if (cue.identifier.trim()) out.push(cue.identifier.trim());
    const timing = `${formatTimecode(cue.start)} --> ${formatTimecode(cue.end)}${cue.settings ? ` ${cue.settings.trim()}` : ''}`;
    out.push(timing);
    out.push(cue.text.replace(/\s+$/g, ''));
  }
  return out.join('\n') + '\n';
}
