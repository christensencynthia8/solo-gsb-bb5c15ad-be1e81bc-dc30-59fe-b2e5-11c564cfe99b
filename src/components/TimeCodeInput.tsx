import { useEffect, useState } from 'react';
import { formatTimecode, parseTimecode } from '../lib/time';

interface Props {
  value: number;
  disabled?: boolean;
  onCommit: (sec: number) => void;
}

/** 可编辑时间码：失焦/回车时提交，非法输入回退 */
export default function TimeCodeInput({ value, disabled, onCommit }: Props) {
  const [text, setText] = useState(formatTimecode(value));
  const [bad, setBad] = useState(false);

  useEffect(() => {
    setText(formatTimecode(value));
    setBad(false);
  }, [value]);

  function commit() {
    const parsed = parseTimecode(text);
    if (parsed === null) {
      setBad(true);
      setText(formatTimecode(value));
      return;
    }
    setBad(false);
    onCommit(parsed);
  }

  return (
    <input
      className={`timecode-input mono ${bad ? 'bad' : ''}`}
      value={text}
      disabled={disabled}
      size={13}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(formatTimecode(value));
          setBad(false);
        }
      }}
    />
  );
}
