import type { Command } from 'commander';
import pc from 'picocolors';
import { searchSessions } from '../core/transcripts.js';
import { table, relTime, truncate, shortId } from '../core/format.js';

const TITLE_WIDTH = 28;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * snippet 中の keyword に一致する箇所を大文字小文字無視で黄色にハイライトする。
 * snippet はすでに core 側でマッチ箇所の前後 ~80 文字に絞られているため、
 * ここではこれ以上 truncate せず全文をハイライト対象にする
 * (truncate してしまうとマッチ位置が切れてハイライトが消えることがあるため)。
 */
function highlightKeyword(text: string, keyword: string): string {
  if (!keyword) return text;
  const re = new RegExp(escapeRegExp(keyword), 'gi');
  return text.replace(re, (match) => pc.yellow(match));
}

export interface SearchOptions {
  project?: string;
}

/** cctl search <keyword> の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runSearch(keyword: string, opts: SearchOptions = {}): Promise<void> {
  // list と同様、"." は cwd に解決してから encoded 名に変換する。
  const project = opts.project === '.' ? process.cwd() : opts.project;
  const results = await searchSessions(keyword, { project });

  if (results.length === 0) {
    console.log('見つかりませんでした');
    return;
  }

  const rows = results.map(({ meta, snippet }) => [
    shortId(meta.sessionId),
    truncate(meta.title ?? meta.firstUserMessage ?? '(no title)', TITLE_WIDTH),
    highlightKeyword(snippet, keyword),
    relTime(meta.mtime),
  ]);

  console.log(table(rows, { header: ['ID', 'TITLE', 'SNIPPET', 'UPDATED'] }));
  console.log();
  console.log(pc.dim('cctl resume <id> で再開できます'));
}

export function register(program: Command): void {
  program
    .command('search <keyword>')
    .description('全セッションを横断検索します')
    .option('-p, --project <path>', '指定パスのセッションのみ検索します')
    .action(async (keyword: string, options: { project?: string }) => {
      await runSearch(keyword, { project: options.project });
    });
}
