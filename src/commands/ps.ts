import os from 'node:os';
import type { Command } from 'commander';
import pc from 'picocolors';
import { confirm, isCancel, cancel } from '@clack/prompts';
import { getLiveSessions, type LiveSession } from '../core/live.js';
import { findSession } from '../core/transcripts.js';
import { table, relTime, truncate } from '../core/format.js';

const WATCH_INTERVAL_MS = 2000;
const DIR_WIDTH = 28;
const TITLE_WIDTH = 32;

/** cwd を ~ 短縮する。 */
function shortenDir(dir: string): string {
  const home = os.homedir();
  if (dir === home) return '~';
  if (dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
  return dir;
}

/** STATUS を busy=黄色 / idle=緑 で色付けする。 */
function formatStatus(status: string): string {
  if (status === 'busy') return pc.yellow(status);
  if (status === 'idle') return pc.green(status);
  return status;
}

/** ライブセッションの sessionId からトランスクリプトを引き ai-title を返す(なければ "-")。 */
async function lookupTitle(session: LiveSession): Promise<string> {
  if (!session.sessionId) return '-';
  try {
    const meta = await findSession(session.sessionId);
    return meta?.title ?? '-';
  } catch {
    return '-';
  }
}

async function renderPsTable(): Promise<string> {
  const sessions = await getLiveSessions();
  if (sessions.length === 0) {
    return '実行中のセッションはありません';
  }

  const rows = await Promise.all(
    sessions.map(async (s) => [
      String(s.pid),
      s.name || '-',
      formatStatus(s.status),
      truncate(shortenDir(s.cwd), DIR_WIDTH),
      truncate(await lookupTitle(s), TITLE_WIDTH),
      relTime(s.updatedAt),
    ]),
  );

  return table(rows, { header: ['PID', 'NAME', 'STATUS', 'DIR', 'TITLE', 'UPDATED'] });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PsOptions {
  watch?: boolean;
}

/** cctl ps の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runPs(opts: PsOptions = {}): Promise<void> {
  if (!opts.watch) {
    console.log(await renderPsTable());
    return;
  }

  // --watch: 2秒間隔で画面クリアして再描画。Ctrl-C(SIGINT)でプロセスごと終了する
  // (ハンドラを登録しないことで Node のデフォルト動作 = 即終了に委ねる)。
  for (;;) {
    const rendered = await renderPsTable();
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(rendered);
    await sleep(WATCH_INTERVAL_MS);
  }
}

export interface KillOptions {
  force?: boolean;
}

/** cctl kill <pid> の本体ロジック。 */
export async function runKill(pidArg: string, opts: KillOptions = {}): Promise<void> {
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(pc.red(`✖ pid は正の整数で指定してください: ${pidArg}`));
    process.exitCode = 1;
    return;
  }

  const sessions = await getLiveSessions();
  const target = sessions.find((s) => s.pid === pid);
  if (!target) {
    console.error(pc.red(`✖ 実行中セッションが見つかりません(pid: ${pid})`));
    process.exitCode = 1;
    return;
  }

  if (!opts.force) {
    const proceed = await confirm({
      message: `"${target.name || target.sessionId || pid}" (pid ${pid}) を停止しますか?`,
      initialValue: false,
    });
    if (isCancel(proceed)) {
      cancel('キャンセルしました');
      process.exit(0);
    }
    if (!proceed) {
      console.log('中止しました');
      return;
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(pc.green(`✓ pid ${pid} に SIGTERM を送信しました`));
  } catch (err) {
    console.error(pc.red(`✖ 停止に失敗しました: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

export function register(program: Command): void {
  program
    .command('ps')
    .alias('monitor')
    .description('実行中セッション一覧を表示します')
    .option('-w, --watch', '2秒間隔で再描画します')
    .action(async (options: { watch?: boolean }) => {
      await runPs({ watch: options.watch });
    });

  program
    .command('kill <pid>')
    .description('実行中セッションを停止します')
    .option('-f, --force', '確認なしで停止します')
    .action(async (pid: string, options: { force?: boolean }) => {
      await runKill(pid, { force: options.force });
    });
}
