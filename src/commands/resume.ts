import type { Command } from 'commander';
import path from 'node:path';
import { select, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import { findSession, listSessions, type SessionMeta } from '../core/transcripts.js';
import { getLiveSessions } from '../core/live.js';
import { resumeSession } from '../core/resume.js';
import { relTime, truncate } from '../core/format.js';

export interface RunResumeOptions {
  idPrefix?: string;
  skipPermissions?: boolean;
  safe?: boolean;
  extraArgs?: string[];
}

/** 標準入出力が TTY かどうか(対話プロンプトが使えるかどうか)を判定する。 */
function isInteractiveTTY(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** エラーメッセージを赤色で stderr に出し、exit code 1 で終了する。 */
function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

/** select の選択肢ラベルと hint を組み立てる。 */
function sessionLabel(meta: SessionMeta): { label: string; hint?: string } {
  const title = meta.title ?? meta.firstUserMessage ?? '(no title)';
  const dirName = meta.cwd ? path.basename(meta.cwd) : path.basename(meta.projectDir);
  const label = `${truncate(title, 32)} ─ ${dirName} ─ ${relTime(meta.mtime)}`;
  const hint = meta.lastPrompt ? truncate(meta.lastPrompt, 40) : undefined;
  return { label, hint };
}

export async function runResume(opts: RunResumeOptions): Promise<void> {
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

    const liveSessions = await getLiveSessions();
    const liveIds = new Set(liveSessions.map((s) => s.sessionId));

    const candidates = await listSessions({ limit: 15 });
    const available = candidates.filter((c) => !liveIds.has(c.sessionId));
    const excludedCount = candidates.length - available.length;

    if (excludedCount > 0) {
      console.log(pc.dim(`※ 実行中のセッション ${excludedCount} 件は選択肢から除外しました`));
    }

    if (available.length === 0) {
      console.log('再開可能なセッションがありません');
      return;
    }

    const choice = await select({
      message: '再開するセッションを選択してください',
      options: available.map((c) => {
        const { label, hint } = sessionLabel(c);
        return { value: c, label, hint };
      }),
    });

    if (isCancel(choice)) {
      cancel('キャンセルしました');
      process.exit(0);
    }

    meta = choice;
  }

  if (!meta.cwd) {
    fail(`セッションの cwd が不明です: ${meta.sessionId}`);
  }

  let skipPermissions: boolean;
  if (opts.skipPermissions) {
    skipPermissions = true;
  } else if (opts.safe) {
    skipPermissions = false;
  } else {
    if (!isInteractiveTTY()) {
      fail('対話モードには TTY が必要です。--skip-permissions か --safe を指定してください。');
    }

    const defaultSkip = meta.permissionMode === 'bypassPermissions';
    const permChoice = await select({
      message: '権限モードを選択してください',
      options: [
        { value: false, label: '通常(権限確認あり)' },
        { value: true, label: '--dangerously-skip-permissions(確認なし)' },
      ],
      initialValue: defaultSkip,
    });

    if (isCancel(permChoice)) {
      cancel('キャンセルしました');
      process.exit(0);
    }

    skipPermissions = permChoice;
  }

  console.log(pc.dim(`cd ${meta.cwd} で再開します`));

  try {
    const exitCode = await resumeSession(meta, { skipPermissions, extraArgs: opts.extraArgs });
    process.exitCode = exitCode;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function register(program: Command): void {
  program
    .command('resume [idPrefix] [extra...]')
    .description('セッションを再開します')
    .option('--skip-permissions', '権限確認なし(--dangerously-skip-permissions)で再開します')
    .option('--safe', '権限確認ありで再開します')
    .action(
      async (
        idPrefix: string | undefined,
        extra: string[],
        options: { skipPermissions?: boolean; safe?: boolean },
      ) => {
        await runResume({
          idPrefix,
          skipPermissions: options.skipPermissions,
          safe: options.safe,
          extraArgs: extra,
        });
      },
    );
}
