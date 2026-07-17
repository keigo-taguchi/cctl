import os from 'node:os';
import type { Command } from 'commander';
import pc from 'picocolors';
import { listSessions } from '../core/transcripts.js';
import { getLiveSessions } from '../core/live.js';
import { table, relTime, fmtSize, truncate, shortId } from '../core/format.js';

const DEFAULT_LIMIT = 20;
const TITLE_WIDTH = 32;
const PROMPT_WIDTH = 28;
const DIR_WIDTH = 24;

/** cwd を ~ 短縮する。 */
function shortenDir(dir: string | null): string {
  if (!dir) return '-';
  const home = os.homedir();
  if (dir === home) return '~';
  if (dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
  return dir;
}

export interface ListOptions {
  project?: string;
  limit?: number;
  json?: boolean;
}

/** cctl list の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runList(opts: ListOptions = {}): Promise<void> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // "." は cwd に解決してから encoded 名に変換する(listSessions/resolveProjectDir が変換を担う)。
  const project = opts.project === '.' ? process.cwd() : opts.project;

  const [sessions, live] = await Promise.all([listSessions({ project, limit }), getLiveSessions()]);

  if (opts.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('復元可能なセッションはありません');
    return;
  }

  const liveIds = new Set(live.map((s) => s.sessionId));

  const rows = sessions.map((meta) => {
    const idLabel = liveIds.has(meta.sessionId)
      ? `${pc.green('●')} ${shortId(meta.sessionId)}`
      : shortId(meta.sessionId);
    const title = meta.title ?? meta.firstUserMessage ?? '(no title)';
    return [
      idLabel,
      truncate(title, TITLE_WIDTH),
      truncate(meta.lastPrompt ?? '-', PROMPT_WIDTH),
      truncate(shortenDir(meta.cwd), DIR_WIDTH),
      String(meta.messageCount),
      fmtSize(meta.size),
      relTime(meta.mtime),
    ];
  });

  console.log(table(rows, { header: ['ID', 'TITLE', 'LAST PROMPT', 'DIR', 'MSGS', 'SIZE', 'UPDATED'] }));
}

export function register(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('復元可能なセッション一覧を表示します')
    .option('-p, --project <path>', '指定パスのセッションのみ表示します(. で現在のディレクトリ)')
    .option('-n, --limit <num>', '表示件数', String(DEFAULT_LIMIT))
    .option('--json', 'SessionMeta の配列を JSON 出力します')
    .action(async (options: { project?: string; limit?: string; json?: boolean }) => {
      const parsedLimit = Number(options.limit);
      await runList({
        project: options.project,
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT,
        json: options.json,
      });
    });
}
