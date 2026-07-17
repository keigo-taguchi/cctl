import type { Command } from 'commander';
import path from 'node:path';
import { autocomplete, select, isCancel, cancel, type Option } from '@clack/prompts';
import pc from 'picocolors';
import { listSessions, type SessionMeta } from '../core/transcripts.js';
import { relTime, truncate, shortId } from '../core/format.js';
import { runResume } from './resume.js';
import { runShow } from './show.js';
import { runExport } from './export.js';

export interface RunFindOptions {
  query?: string;
}

const CANDIDATE_LIMIT = 100;
const TITLE_WIDTH = 32;
const PROMPT_HINT_WIDTH = 40;

/** 標準入出力が TTY かどうか(対話プロンプトが使えるかどうか)を判定する。 */
function isInteractiveTTY(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** エラーメッセージを赤色で stderr に出し、exit code 1 で終了する。 */
function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

/** セッションの表示用ディレクトリ名(cwd がなければ projectDir の basename)。 */
function dirName(meta: SessionMeta): string {
  return path.basename(meta.cwd ?? meta.projectDir);
}

/** タイトルとして表示する文字列(title ?? firstUserMessage ?? "(no title)")。 */
function displayTitle(meta: SessionMeta): string {
  return meta.title ?? meta.firstUserMessage ?? '(no title)';
}

/** autocomplete の候補(label / hint)を組み立てる。 */
function toOption(meta: SessionMeta): Option<SessionMeta> {
  const label = `${shortId(meta.sessionId)}  ${truncate(displayTitle(meta), TITLE_WIDTH)} ─ ${dirName(meta)} ─ ${relTime(meta.mtime)}`;
  const hint = meta.lastPrompt ? truncate(meta.lastPrompt, PROMPT_HINT_WIDTH) : undefined;
  return { value: meta, label, hint };
}

/**
 * fzf 風の検索対象文字列(タイトル・lastPrompt・cwd・sessionId を含める)。
 * autocomplete の label だけでは cwd や sessionId で絞り込めないため、
 * カスタム filter オプションでこの文字列に対してマッチさせる。
 */
function searchText(meta: SessionMeta): string {
  return [
    meta.sessionId,
    meta.title ?? '',
    meta.lastPrompt ?? '',
    meta.firstUserMessage ?? '',
    meta.cwd ?? '',
    dirName(meta),
  ]
    .join('\n')
    .toLowerCase();
}

/** 入力をスペース区切りのトークンに分け、すべてのトークンが検索対象文字列に含まれるかを見る(緩い AND マッチ)。 */
function matchesQuery(query: string, meta: SessionMeta): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = searchText(meta);
  return q.split(/\s+/).every((token) => text.includes(token));
}

type FindAction = 'resume' | 'show' | 'export' | 'cancel';

/** cctl find の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runFind(opts: RunFindOptions = {}): Promise<void> {
  if (!isInteractiveTTY()) {
    fail('対話モードには TTY が必要です。');
  }

  const metas = await listSessions({ limit: CANDIDATE_LIMIT });
  if (metas.length === 0) {
    console.log('復元可能なセッションがありません');
    return;
  }

  const options = metas.map(toOption);

  const chosen = await autocomplete<SessionMeta>({
    message: 'セッションを検索(タイトル・プロンプト・ディレクトリ・ID で絞り込み)',
    options,
    filter: (search, option) => matchesQuery(search, option.value),
    placeholder: '入力して絞り込み...',
    initialUserInput: opts.query,
    maxItems: 10,
  });

  if (isCancel(chosen)) {
    cancel('キャンセルしました');
    return;
  }

  const meta = chosen;

  const action = await select<FindAction>({
    message: `${truncate(displayTitle(meta), PROMPT_HINT_WIDTH)} — 何をしますか?`,
    options: [
      { value: 'resume', label: '▶ 再開' },
      { value: 'show', label: '📄 詳細を表示' },
      { value: 'export', label: '📝 Markdown エクスポート' },
      { value: 'cancel', label: 'キャンセル' },
    ],
  });

  if (isCancel(action) || action === 'cancel') {
    cancel('キャンセルしました');
    return;
  }

  // meta.sessionId は完全な ID なので findSession の前方一致でも一意に解決できる。
  // 選択後アクションは既存コマンド(resume.ts / show.ts / export.ts)の run 関数を再利用する。
  switch (action) {
    case 'resume':
      await runResume({ idPrefix: meta.sessionId });
      break;
    case 'show':
      await runShow(meta.sessionId, { tail: 10 });
      break;
    case 'export':
      await runExport(meta.sessionId, {});
      break;
  }
}

export function register(program: Command): void {
  program
    .command('find [query]')
    .alias('f')
    .description('セッションをインクリメンタル検索して操作します')
    .action(async (query: string | undefined) => {
      await runFind({ query });
    });
}
