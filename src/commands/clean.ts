import { rm } from 'node:fs/promises';
import type { Command } from 'commander';
import pc from 'picocolors';
import { confirm, isCancel, cancel } from '@clack/prompts';
import { listSessions } from '../core/transcripts.js';
import { getLiveSessions } from '../core/live.js';
import { getPinnedIds, measureSessionSize, sidecarDir } from '../core/pins.js';
import { table, relTime, fmtSize, truncate, shortId } from '../core/format.js';

const DEFAULT_DAYS = 30;
const EMPTY_MESSAGE_THRESHOLD = 2;
const TITLE_WIDTH = 32;

export interface CleanOptions {
  days?: number;
  emptyOnly?: boolean;
  dryRun?: boolean;
  includePinned?: boolean;
}

/** cctl clean の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runClean(opts: CleanOptions = {}): Promise<void> {
  const days = opts.days ?? DEFAULT_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // clean は「古いもの」を探す性質上、mtime 降順 limit で切られては困るため全件取得する。
  const [sessions, live, pinnedIds] = await Promise.all([
    listSessions({ limit: Number.POSITIVE_INFINITY }),
    getLiveSessions(),
    opts.includePinned ? Promise.resolve(new Set<string>()) : getPinnedIds(),
  ]);

  const liveIds = new Set(live.map((s) => s.sessionId));
  let skippedPinned = 0;

  const targets = sessions.filter((meta) => {
    if (liveIds.has(meta.sessionId)) return false; // 実行中セッションは絶対に対象外
    const isEmpty = meta.messageCount <= EMPTY_MESSAGE_THRESHOLD;
    const isOld = meta.mtime.getTime() < cutoff;
    const wouldDelete = opts.emptyOnly ? isEmpty : isOld || isEmpty;
    if (wouldDelete && pinnedIds.has(meta.sessionId)) {
      skippedPinned++; // pin 済みは永続化の意思表示なので消さない
      return false;
    }
    return wouldDelete;
  });

  if (targets.length === 0) {
    console.log('整理対象のセッションはありません');
    if (skippedPinned > 0) {
      console.log(pc.dim(`(pin 済み ${skippedPinned}件を除外しました)`));
    }
    return;
  }

  // サブエージェント / ワークフローのトランスクリプトは
  // <sessionId>/subagents/... に入れ子で置かれる。メインの jsonl だけを見ると
  // 実際に解放される容量を過小表示してしまうため、サイドカーを含めて測る。
  const sizes = new Map<string, number>();
  for (const meta of targets) {
    sizes.set(meta.sessionId, await measureSessionSize(meta.filePath, meta.sessionId));
  }
  const sizeOf = (meta: (typeof targets)[number]) => sizes.get(meta.sessionId) ?? meta.size;
  const totalSize = targets.reduce((sum, m) => sum + sizeOf(m), 0);

  const rows = targets.map((meta) => [
    shortId(meta.sessionId),
    truncate(meta.title ?? meta.firstUserMessage ?? '(no title)', TITLE_WIDTH),
    String(meta.messageCount),
    fmtSize(sizeOf(meta)),
    relTime(meta.mtime),
  ]);

  console.log(table(rows, { header: ['ID', 'TITLE', 'MSGS', 'SIZE', 'UPDATED'] }));
  console.log();
  console.log(`対象: ${targets.length}件 / 合計サイズ: ${fmtSize(totalSize)}`);
  if (skippedPinned > 0) {
    console.log(pc.dim(`pin 済み ${skippedPinned}件は除外しました(--include-pinned で対象に含めます)`));
  }

  if (opts.dryRun) {
    console.log(pc.dim('(--dry-run のため削除は行っていません)'));
    return;
  }

  const proceed = await confirm({
    message: `上記 ${targets.length} 件のセッションを削除しますか?`,
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

  let deleted = 0;
  for (const meta of targets) {
    try {
      await rm(meta.filePath, { force: true });
      // メインだけ消すとサブエージェントの記録が孤児として残り続ける
      await rm(sidecarDir(meta.filePath, meta.sessionId), { recursive: true, force: true });
      deleted++;
    } catch (err) {
      console.error(pc.red(`✖ 削除に失敗しました: ${meta.filePath} (${(err as Error).message})`));
    }
  }
  console.log(pc.green(`✓ ${deleted}件のセッションを削除しました`));
}

export function register(program: Command): void {
  program
    .command('clean')
    .description('古いセッションを整理します')
    .option('--days <n>', '対象とする経過日数', String(DEFAULT_DAYS))
    .option('--empty-only', 'メッセージ数がほぼ空のセッションのみを対象にします')
    .option('--dry-run', '削除せず対象一覧のみ表示します')
    .option('--include-pinned', 'pin 済みのセッションも削除対象に含めます')
    .action(
      async (options: {
        days?: string;
        emptyOnly?: boolean;
        dryRun?: boolean;
        includePinned?: boolean;
      }) => {
        const days = Number(options.days);
        await runClean({
          days: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS,
          emptyOnly: options.emptyOnly,
          dryRun: options.dryRun,
          includePinned: options.includePinned,
        });
      },
    );
}
