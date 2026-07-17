import type { Command } from 'commander';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import pc from 'picocolors';
import { findSession } from '../core/transcripts.js';
import { relTime, truncate, shortId } from '../core/format.js';

export interface RunExportOptions {
  out?: string;
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
            // thinking はスキップ
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

/** tool_use の input から人間可読な 1 行要約を作る。 */
function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const preferredKeys = [
      'command',
      'file_path',
      'path',
      'pattern',
      'url',
      'query',
      'description',
      'prompt',
      'notebook_path',
    ];
    for (const key of preferredKeys) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) {
        return truncate(v.replace(/\s+/g, ' ').trim(), 100);
      }
    }
    try {
      return truncate(JSON.stringify(obj), 100);
    } catch {
      return '';
    }
  }
  if (typeof input === 'string') return truncate(input, 100);
  return '';
}

export async function runExport(idPrefix: string, opts: RunExportOptions): Promise<void> {
  const meta = await findSession(idPrefix);
  if (!meta) {
    fail(`セッションが見つかりません: ${idPrefix}`);
  }

  const title = meta.title ?? meta.firstUserMessage ?? '(no title)';

  const frontmatter: string[] = ['---', `title: ${JSON.stringify(title)}`, `sessionId: ${meta.sessionId}`];
  frontmatter.push(`cwd: ${JSON.stringify(meta.cwd ?? '(不明)')}`);
  if (meta.gitBranch) frontmatter.push(`branch: ${meta.gitBranch}`);
  if (meta.permissionMode) frontmatter.push(`permissionMode: ${meta.permissionMode}`);
  frontmatter.push(`updatedAt: ${JSON.stringify(`${meta.mtime.toISOString()} (${relTime(meta.mtime)})`)}`);
  frontmatter.push('---', '', `# ${title}`, '');

  const turns = await collectConversationTurns(meta.filePath);

  const bodyLines: string[] = [];
  for (const turn of turns) {
    bodyLines.push(turn.role === 'user' ? '## 👤 User' : '## 🤖 Assistant');
    bodyLines.push('');
    for (const part of turn.parts) {
      if (part.kind === 'tool_use') {
        bodyLines.push(`> ⚙ ${part.toolName}: ${summarizeToolInput(part.toolInput)}`);
      } else {
        bodyLines.push(part.text ?? '');
      }
      bodyLines.push('');
    }
  }

  const markdown = [...frontmatter, ...bodyLines].join('\n');
  const outPath = opts.out ?? `./${shortId(meta.sessionId)}.md`;

  try {
    await writeFile(outPath, markdown, 'utf8');
  } catch (err) {
    fail(`書き込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`${pc.green('✔')} 出力しました: ${path.resolve(outPath)}`);
}

export function register(program: Command): void {
  program
    .command('export <idPrefix>')
    .description('セッションを Markdown にエクスポートします')
    .option('-o, --out <file>', '出力ファイルパス(デフォルト: ./<セッションID先頭8文字>.md)')
    .action(async (idPrefix: string, options: { out?: string }) => {
      await runExport(idPrefix, { out: options.out });
    });
}
