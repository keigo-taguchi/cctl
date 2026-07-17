// テーブル整形(string-width 使用)、相対時刻、サイズ、truncate

import stringWidth from 'string-width';

/**
 * 行の配列をテーブル状に整形する。string-width で CJK 幅を考慮した左詰めパディングを行う。
 */
export function table(rows: string[][], opts?: { header?: string[] }): string {
  const allRows = opts?.header ? [opts.header, ...rows] : rows;
  if (allRows.length === 0) return '';

  const colCount = Math.max(...allRows.map((r) => r.length));
  const widths: number[] = new Array(colCount).fill(0);
  for (const row of allRows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? '';
      widths[i] = Math.max(widths[i], stringWidth(cell));
    }
  }

  const padRow = (row: string[]): string =>
    row
      .map((cell, i) => {
        const w = stringWidth(cell);
        const pad = Math.max(0, widths[i] - w);
        return cell + ' '.repeat(pad);
      })
      .join('  ')
      .trimEnd();

  const lines: string[] = [];
  if (opts?.header) {
    lines.push(padRow(opts.header));
    lines.push(widths.map((w) => '─'.repeat(w)).join('  '));
  }
  for (const row of rows) {
    lines.push(padRow(row));
  }
  return lines.join('\n');
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** 相対時刻を日本語で表現する("3分前" "2時間前" "5日前" 等)。 */
export function relTime(date: Date | number): string {
  const t = typeof date === 'number' ? date : date.getTime();
  const diff = Date.now() - t;

  if (diff < MINUTE) return 'たった今';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
  if (diff < MONTH) return `${Math.floor(diff / DAY)}日前`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}ヶ月前`;
  return `${Math.floor(diff / YEAR)}年前`;
}

/** バイト数を人間可読な文字列に変換する("1.2MB" 等)。 */
export function fmtSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted}${units[unitIndex]}`;
}

/** string-width 基準で文字列を切り、収まらない場合は末尾に "…" を付ける。 */
export function truncate(s: string, width: number): string {
  if (stringWidth(s) <= width) return s;

  const ellipsis = '…';
  const targetWidth = Math.max(0, width - stringWidth(ellipsis));

  let result = '';
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > targetWidth) break;
    result += ch;
    w += cw;
  }
  return result + ellipsis;
}

/** sessionId の先頭 8 文字を返す。 */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
