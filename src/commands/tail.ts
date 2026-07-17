import type { Command } from 'commander';
import { createReadStream, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import readline from 'node:readline';
import pc from 'picocolors';
import { select, isCancel, cancel } from '@clack/prompts';
import { findSession, type SessionMeta } from '../core/transcripts.js';
import { getLiveSessions } from '../core/live.js';
import { truncate, relTime } from '../core/format.js';

const POLL_INTERVAL_MS = 1000;
const TEXT_WIDTH = 100;
const TEXT_LINES = 3;

/** エラーメッセージを赤色で stderr に出し、exit code 1 で終了する。 */
function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

/** 標準入出力が TTY かどうか(対話プロンプトが使えるかどうか)を判定する。 */
function isInteractiveTTY(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

interface TurnPart {
  kind: 'text' | 'tool_use';
  text?: string;
  toolName?: string;
}

export interface ParsedTurn {
  kind: 'turn';
  role: 'user' | 'assistant';
  parts: TurnPart[];
}

export interface ParsedTitle {
  kind: 'title';
  title: string;
}

export type ParsedLine = ParsedTurn | ParsedTitle;

// システムが注入するラッパー系タグ(<local-command-caveat> 等)で始まるものは
// ユーザー発話として扱わない。show.ts / core/transcripts.ts と同じ考え方。
const WRAPPER_TAG_RE = /^<[\w-]+>/;

function lineHasType(line: string, type: string): boolean {
  return line.includes(`"type":"${type}"`);
}

/**
 * jsonl の 1 行を解析し、描画すべき内容を抽出する。show.ts の
 * collectConversationTurns と同じフィルタリングルール(isMeta / ラッパー
 * タグ除外、thinking スキップ)を踏襲する。描画不要な行(未知タイプ、
 * 空 parts、壊れた JSON 等)は null を返す。
 *
 * follow モードでの追記検知・初期表示の両方から呼ばれる共通ロジック。
 */
export function parseDisplayLine(rawLine: string): ParsedLine | null {
  const line = rawLine.trim();
  if (!line) return null;

  if (lineHasType(line, 'ai-title')) {
    try {
      const obj = JSON.parse(line) as { aiTitle?: unknown };
      if (typeof obj.aiTitle === 'string') return { kind: 'title', title: obj.aiTitle };
    } catch {
      // 壊れた行は無視
    }
    return null;
  }

  if (lineHasType(line, 'user')) {
    try {
      const obj = JSON.parse(line) as { isMeta?: unknown; message?: { content?: unknown } };
      if (obj.isMeta === true) return null;
      const content = obj.message?.content;
      const parts: TurnPart[] = [];
      if (typeof content === 'string') {
        if (!WRAPPER_TAG_RE.test(content)) parts.push({ kind: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string' && !WRAPPER_TAG_RE.test(b.text)) {
            parts.push({ kind: 'text', text: b.text });
          }
          // tool_result 等は無視(ユーザー発話ではない)
        }
      }
      if (parts.length === 0) return null;
      return { kind: 'turn', role: 'user', parts };
    } catch {
      return null;
    }
  }

  if (lineHasType(line, 'assistant')) {
    try {
      const obj = JSON.parse(line) as { message?: { content?: unknown } };
      const content = obj.message?.content;
      const parts: TurnPart[] = [];
      if (typeof content === 'string') {
        parts.push({ kind: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            parts.push({ kind: 'text', text: b.text });
          } else if (b.type === 'tool_use') {
            parts.push({ kind: 'tool_use', toolName: typeof b.name === 'string' ? b.name : '(unknown)' });
          }
          // thinking 等はスキップ
        }
      }
      if (parts.length === 0) return null;
      return { kind: 'turn', role: 'assistant', parts };
    } catch {
      return null;
    }
  }

  return null;
}

/** string-width 基準で最大 maxLines 行に切り詰める(show.ts と同じ挙動)。 */
function truncateToLines(text: string, maxLines: number, width: number): string {
  const rawLines = text.split('\n');
  const shownLines = rawLines.slice(0, maxLines).map((l) => truncate(l, width));
  let result = shownLines.join('\n   ');
  if (rawLines.length > maxLines) result += '\n   …';
  return result;
}

/** ParsedLine を show.ts と同じ見た目(👤/🤖/⚙、3 行 truncate)の文字列配列に整形する。 */
export function formatParsedLine(parsed: ParsedLine): string[] {
  if (parsed.kind === 'title') {
    return [pc.magenta(`✦ タイトル: ${parsed.title}`)];
  }
  const lines: string[] = [];
  for (const part of parsed.parts) {
    if (part.kind === 'tool_use') {
      lines.push(pc.gray(`⚙ ${part.toolName}`));
    } else {
      const prefix = parsed.role === 'user' ? '👤' : '🤖';
      lines.push(`${prefix} ${truncateToLines(part.text ?? '', TEXT_LINES, TEXT_WIDTH)}`);
    }
  }
  return lines;
}

function printParsedLine(parsed: ParsedLine): void {
  for (const line of formatParsedLine(parsed)) {
    console.log(line);
  }
}

/**
 * ファイル全体をストリーミングで読み、描画対象となる user/assistant の
 * ターン(1 行 = 1 ターン)だけを収集する。起動時の直近 N 件表示に使う。
 */
async function collectInitialTurns(filePath: string): Promise<ParsedTurn[]> {
  const turns: ParsedTurn[] = [];

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const parsed = parseDisplayLine(rawLine);
    if (parsed && parsed.kind === 'turn') turns.push(parsed);
  }

  return turns;
}

export interface AppendResult {
  text: string;
  newOffset: number;
}

/** filePath の offset バイト以降を読み込む(追記分のみを読むための最小単位)。 */
export async function readAppended(filePath: string, offset: number): Promise<AppendResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start: offset });
    stream.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve({ text: buf.toString('utf8'), newOffset: offset + buf.length });
    });
    stream.on('error', reject);
  });
}

/**
 * 直前までにバッファされていた不完全行(pending)と新規テキストを結合し、
 * 完成した行の配列と、次回に持ち越す末尾の不完全行(改行で終わらない部分)を返す。
 */
export function splitCompleteLines(pending: string, newText: string): { lines: string[]; remainder: string } {
  const combined = pending + newText;
  if (combined.length === 0) return { lines: [], remainder: '' };

  const parts = combined.split('\n');
  // combined が改行で終わっていれば split の最後の要素は空文字列になる。
  const remainder = combined.endsWith('\n') ? '' : (parts.pop() ?? '');
  if (combined.endsWith('\n')) parts.pop(); // 末尾の空文字列要素を除去
  return { lines: parts, remainder };
}

export interface FollowHandle {
  stop: () => void;
}

export interface FollowOptions {
  /** 描画対象の行が見つかるたびに呼ばれる。テストからも直接検証できるようフックにしている。 */
  onLine?: (parsed: ParsedLine) => void;
  pollIntervalMs?: number;
}

/**
 * jsonl ファイルへの追記を検知し続け、新しい描画対象行を通知する。
 *
 * 実装方針(DESIGN.md 記載の通り):
 * - 起動時のファイルサイズを offset として保持
 * - fs.watch + 1 秒間隔の fs.stat ポーリングを併用(fs.watch はプラットフォーム/
 *   エディタの rename イベント等で取りこぼすことがあるため、ポーリングをフォールバックにする)
 * - サイズ増加を検知したら createReadStream({start: offset}) で追記分だけ読む
 * - 改行で終わらない末尾の不完全行はバッファに保持して次回に結合する
 * - サイズ減少(truncate)を検知したら offset をリセットして継続する
 */
export function followFile(filePath: string, initialOffset: number, opts: FollowOptions = {}): FollowHandle {
  let offset = initialOffset;
  let pending = '';
  let checking = false;
  const onLine = opts.onLine ?? ((parsed) => printParsedLine(parsed));

  async function checkForUpdates(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      let st;
      try {
        st = await stat(filePath);
      } catch {
        return; // ファイルが一時的に消えている等は無視し、次回のチェックに委ねる
      }

      if (st.size < offset) {
        // truncate されたとみなし、offset をリセットして継続する
        offset = 0;
        pending = '';
      }

      if (st.size > offset) {
        const { text, newOffset } = await readAppended(filePath, offset);
        offset = newOffset;
        const { lines, remainder } = splitCompleteLines(pending, text);
        pending = remainder;
        for (const line of lines) {
          const parsed = parseDisplayLine(line);
          if (parsed) onLine(parsed);
        }
      }
    } finally {
      checking = false;
    }
  }

  const watcher: FSWatcher = fsWatch(filePath, { persistent: true }, () => {
    void checkForUpdates();
  });
  watcher.on('error', () => {
    // fs.watch が失敗しても 1 秒ポーリングが引き続き追記を検知するので無視する
  });

  const interval = setInterval(() => {
    void checkForUpdates();
  }, opts.pollIntervalMs ?? POLL_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(interval);
      watcher.close();
    },
  };
}

export interface RunTailOptions {
  idPrefix?: string;
  lines?: number;
}

/** getLiveSessions() の中から clack select で 1 件選ばせる。 */
async function selectLiveSession(): Promise<SessionMeta> {
  const liveSessions = await getLiveSessions();
  if (liveSessions.length === 0) {
    fail('実行中のセッションがありません');
  }

  const choice = await select({
    message: 'フォローするセッションを選択してください',
    options: liveSessions.map((s) => ({
      value: s.sessionId,
      label: `${s.name || s.sessionId.slice(0, 8)} ─ ${s.cwd} ─ ${relTime(s.updatedAt)}`,
      hint: s.status,
    })),
  });

  if (isCancel(choice)) {
    cancel('キャンセルしました');
    process.exit(0);
  }

  const meta = await findSession(choice);
  if (!meta) {
    fail(`セッションのトランスクリプトが見つかりません: ${choice}`);
  }
  return meta;
}

export async function runTail(opts: RunTailOptions): Promise<void> {
  let meta: SessionMeta;

  if (opts.idPrefix) {
    const found = await findSession(opts.idPrefix);
    if (!found) {
      fail(`セッションが見つかりません: ${opts.idPrefix}`);
    }
    meta = found;
  } else {
    if (!isInteractiveTTY()) {
      fail('対話モードには TTY が必要です。idPrefix を指定して実行してください。');
    }
    meta = await selectLiveSession();
  }

  const title = meta.title ?? meta.firstUserMessage ?? '(no title)';
  console.log(pc.bold(title));
  console.log();

  const lineCount = opts.lines ?? 5;
  const allTurns = await collectInitialTurns(meta.filePath);
  const shown = allTurns.slice(-lineCount);
  if (shown.length === 0) {
    console.log('(会話がありません)');
  }
  for (const turn of shown) {
    printParsedLine(turn);
  }

  // フォロー開始直前の実サイズを offset にする(初期表示読み取り後の追記を取りこぼさないため)。
  const st = await stat(meta.filePath);

  console.log();
  console.log(pc.dim('── フォロー中 (Ctrl-C で終了) ──'));

  const handle = followFile(meta.filePath, st.size);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      handle.stop();
      resolve();
    });
  });

  process.exit(0);
}

export function register(program: Command): void {
  program
    .command('tail [idPrefix]')
    .description('セッションの会話を tail -f 風に表示します')
    .option('-n, --lines <num>', '起動時に表示する直近の会話件数', '5')
    .action(async (idPrefix: string | undefined, options: { lines?: string }) => {
      const lines = options.lines !== undefined ? Number.parseInt(options.lines, 10) : 5;
      await runTail({ idPrefix, lines: Number.isFinite(lines) ? lines : 5 });
    });
}
