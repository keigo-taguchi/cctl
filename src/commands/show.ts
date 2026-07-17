import type { Command } from 'commander';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import pc from 'picocolors';
import { findSession } from '../core/transcripts.js';
import { table, relTime, fmtSize, truncate } from '../core/format.js';

export interface RunShowOptions {
  tail?: number;
}

/** エラーメッセージを赤色で stderr に出し、exit code 1 で終了する。 */
function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

interface TurnPart {
  kind: 'text' | 'tool_use';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  parts: TurnPart[];
}

// システムが注入するラッパー系タグ(<local-command-caveat> 等)で始まるものは
// ユーザー発話として扱わない。core/transcripts.ts の isRealUserText と同じ考え方。
const WRAPPER_TAG_RE = /^<[\w-]+>/;

function lineHasType(line: string, type: string): boolean {
  return line.includes(`"type":"${type}"`);
}

/**
 * jsonl をストリーミングで読み、user/assistant のターン単位で会話を抽出する。
 * ファイルは 8MB を超えることがあるため、全行 JSON.parse はせず、
 * user/assistant 行のみ前方フィルタしてから parse する。
 */
async function collectConversationTurns(filePath: string): Promise<ConversationTurn[]> {
  const turns: ConversationTurn[] = [];

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    if (lineHasType(line, 'user')) {
      try {
        const obj = JSON.parse(line) as { isMeta?: unknown; message?: { content?: unknown } };
        if (obj.isMeta === true) continue;
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
        if (parts.length > 0) turns.push({ role: 'user', parts });
      } catch {
        // 壊れた行は無視
      }
      continue;
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
              parts.push({
                kind: 'tool_use',
                toolName: typeof b.name === 'string' ? b.name : '(unknown)',
                toolInput: b.input,
              });
            }
            // thinking 等はスキップ
          }
        }
        if (parts.length > 0) turns.push({ role: 'assistant', parts });
      } catch {
        // 壊れた行は無視
      }
      continue;
    }
  }

  return turns;
}

/** string-width 基準で最大 maxLines 行に切り詰める(超過分は末尾に "…" を付ける)。 */
function truncateToLines(text: string, maxLines: number, width: number): string {
  const rawLines = text.split('\n');
  const shownLines = rawLines.slice(0, maxLines).map((l) => truncate(l, width));
  let result = shownLines.join('\n   ');
  if (rawLines.length > maxLines) result += '\n   …';
  return result;
}

export async function runShow(idPrefix: string, opts: RunShowOptions): Promise<void> {
  const meta = await findSession(idPrefix);
  if (!meta) {
    fail(`セッションが見つかりません: ${idPrefix}`);
  }

  const title = meta.title ?? meta.firstUserMessage ?? '(no title)';
  const rows: string[][] = [
    ['ID', meta.sessionId],
    ['タイトル', title],
    ['cwd', meta.cwd ?? '(不明)'],
    ['ブランチ', meta.gitBranch ?? '-'],
    ['権限モード', meta.permissionMode ?? '-'],
    ['メッセージ数', String(meta.messageCount)],
    ['サイズ', fmtSize(meta.size)],
    ['更新時刻', `${relTime(meta.mtime)} (${meta.mtime.toLocaleString('ja-JP')})`],
  ];
  console.log(table(rows.map(([label, value]) => [pc.cyan(label), value])));

  const tail = opts.tail ?? 10;
  const allTurns = await collectConversationTurns(meta.filePath);
  const shown = allTurns.slice(-tail);

  console.log();
  console.log(pc.bold(`直近の会話(最新 ${shown.length} 件):`));
  if (shown.length === 0) {
    console.log('(会話がありません)');
  }
  for (const turn of shown) {
    for (const part of turn.parts) {
      if (part.kind === 'tool_use') {
        console.log(pc.gray(`⚙ ${part.toolName}`));
      } else {
        const prefix = turn.role === 'user' ? '👤' : '🤖';
        console.log(`${prefix} ${truncateToLines(part.text ?? '', 3, 100)}`);
      }
    }
  }
}

export function register(program: Command): void {
  program
    .command('show <idPrefix>')
    .description('セッション詳細を表示します')
    .option('-t, --tail <num>', '表示する直近の会話件数', '10')
    .action(async (idPrefix: string, options: { tail?: string }) => {
      const tail = options.tail !== undefined ? Number.parseInt(options.tail, 10) : 10;
      await runShow(idPrefix, { tail: Number.isFinite(tail) ? tail : 10 });
    });
}
