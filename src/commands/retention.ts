import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { confirm, isCancel, cancel } from '@clack/prompts';
import { projectsDir } from '../core/paths.js';
import {
  DEFAULT_RETENTION_DAYS,
  FOREVER_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  getRetentionDays,
  setRetentionDays,
  userSettingsFile,
} from '../core/settings.js';
import { getPinnedIds, measureSessionSize } from '../core/pins.js';
import { fmtSize } from '../core/format.js';

export interface RetentionOptions {
  days?: number;
  forever?: boolean;
  yes?: boolean;
}

interface TranscriptStat {
  sessionId: string;
  /** メイン jsonl + サイドカー(サブエージェント / ワークフロー)の合計 */
  size: number;
  sidecarSize: number;
  mtime: Date;
}

/**
 * projects 配下のセッションを stat だけで集計する。
 * 容量表示のために全件のメタ抽出(parse)まで走らせるのは無駄なので使わない。
 * サイズはサイドカーを含めた実消費量にする(メインの jsonl だけ数えると
 * 実データで 105MB / 154MB と 3 割以上ずれる)。
 */
async function statTranscripts(): Promise<TranscriptStat[]> {
  const root = projectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }

  const out: TranscriptStat[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(path.join(root, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      const fullPath = path.join(root, dir, file);
      try {
        const s = await stat(fullPath);
        const total = await measureSessionSize(fullPath, sessionId);
        out.push({ sessionId, size: total, sidecarSize: total - s.size, mtime: s.mtime });
      } catch {
        // 集計中に消えたファイルは無視する
      }
    }
  }
  return out;
}

async function showStatus(): Promise<void> {
  const [configured, transcripts, pinned] = await Promise.all([
    getRetentionDays(),
    statTranscripts(),
    getPinnedIds(),
  ]);

  const effective = configured ?? DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - effective * 24 * 60 * 60 * 1000;
  const totalSize = transcripts.reduce((sum, t) => sum + t.size, 0);
  const expiring = transcripts.filter((t) => t.mtime.getTime() < cutoff);
  const expiringPinned = expiring.filter((t) => pinned.has(t.sessionId));

  console.log();
  console.log(
    `  保持期間: ${pc.bold(String(effective))}日` +
      (configured === null ? pc.dim('(未設定 — 本体のデフォルト)') : ''),
  );
  console.log(`  設定ファイル: ${pc.dim(userSettingsFile())}`);
  const sidecarSize = transcripts.reduce((sum, t) => sum + t.sidecarSize, 0);
  console.log(
    `  トランスクリプト: ${transcripts.length}セッション / ${fmtSize(totalSize)}` +
      (sidecarSize > 0 ? pc.dim(`(うちサブエージェント ${fmtSize(sidecarSize)})`) : ''),
  );
  console.log(`  保存先: ${pc.dim(projectsDir())}`);
  console.log(`  pin 済み: ${pinned.size}件`);
  console.log();

  if (expiring.length > 0) {
    console.log(
      pc.yellow(
        `  ⚠ ${expiring.length}件 (${fmtSize(expiring.reduce((s, t) => s + t.size, 0))}) が` +
          '保持期間を超えており、次回の Claude Code 起動時に削除されます',
      ),
    );
    if (expiringPinned.length > 0) {
      console.log(
        pc.dim(`    うち ${expiringPinned.length}件は pin 済みですが、`) +
          pc.dim('本体の削除は pin を認識しません。アーカイブからの復元になります'),
      );
    }
    console.log();
  }

  if (configured === null || effective <= DEFAULT_RETENTION_DAYS) {
    console.log(
      pc.dim(`  永続化するには: cctl retention --forever  (cleanupPeriodDays: ${FOREVER_RETENTION_DAYS})`),
    );
    console.log(pc.dim('  以降は cctl clean で選択的に整理してください(pin 済みは除外されます)'));
    console.log();
  }
}

/** cctl retention の本体ロジック。 */
export async function runRetention(opts: RetentionOptions = {}): Promise<void> {
  const target = opts.forever ? FOREVER_RETENTION_DAYS : opts.days;

  if (target === undefined) {
    await showStatus();
    return;
  }

  const current = await getRetentionDays();
  const effective = current ?? DEFAULT_RETENTION_DAYS;

  if (target === current) {
    console.log(`保持期間は既に ${target}日 です`);
    return;
  }

  // 短縮は削除範囲が広がる方向なので確認を挟む
  if (target < effective && !opts.yes) {
    if (!process.stdin.isTTY) {
      console.error(
        pc.red(`✖ 保持期間を ${effective}日 → ${target}日 に短縮すると削除対象が増えます。`) +
          ' 非対話で実行するには --yes を付けてください',
      );
      process.exit(1);
    }
    const proceed = await confirm({
      message: `保持期間を ${effective}日 → ${target}日 に短縮します。対象外になった履歴は削除されます。続けますか?`,
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

  await setRetentionDays(target);
  console.log(pc.green(`✓ cleanupPeriodDays: ${target} を ${userSettingsFile()} に設定しました`));
  if (target >= FOREVER_RETENTION_DAYS) {
    console.log(pc.dim('  本体の自動削除は実質無効です。cctl clean で整理してください'));
  }
}

export function register(program: Command): void {
  program
    .command('retention [days]')
    .description('トランスクリプトの保持期間(cleanupPeriodDays)を表示・設定します')
    .option('--forever', `実質無期限にします(${FOREVER_RETENTION_DAYS}日)`)
    .option('-y, --yes', '短縮時の確認を省略します')
    .action(async (days: string | undefined, options: { forever?: boolean; yes?: boolean }) => {
      let parsed: number | undefined;
      if (days !== undefined) {
        parsed = Number(days);
        if (!Number.isInteger(parsed) || parsed < MIN_RETENTION_DAYS) {
          console.error(
            pc.red(`✖ 保持日数は ${MIN_RETENTION_DAYS} 以上の整数で指定してください。`) +
              `\n  0 は Claude Code 本体に拒否されます(かつて「トランスクリプトを書かない」の意味だったため)。` +
              `\n  実質無期限にするには --forever(${FOREVER_RETENTION_DAYS}日)を使ってください。`,
          );
          process.exit(1);
        }
      }
      await runRetention({ days: parsed, forever: options.forever, yes: options.yes });
    });
}
