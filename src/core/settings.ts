// ~/.claude/settings.json の読み書き(cleanupPeriodDays の参照・更新)

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { claudeDir } from './paths.js';

/** Claude Code のトランスクリプト保持期間のデフォルト(未設定時に適用される日数) */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * cleanupPeriodDays の下限。本体は 0 を明示的に拒否する
 * (かつては「トランスクリプトを書かない」の意味だったため、
 *  「消さない」つもりで 0 を入れた利用者の履歴が丸ごと失われる事故があった)。
 */
export const MIN_RETENTION_DAYS = 1;

/** 実質無期限として案内する値(本体のエラーメッセージが例示している 10 年相当) */
export const FOREVER_RETENTION_DAYS = 3650;

export interface SettingsFile {
  path: string;
  /** ファイルが存在しない場合は null(未作成) */
  data: Record<string, unknown> | null;
}

/** ~/.claude/settings.json の絶対パス */
export function userSettingsFile(): string {
  return path.join(claudeDir(), 'settings.json');
}

/**
 * settings.json を読む。存在しない場合は data: null を返す。
 * パースに失敗した場合は投げる — 壊れた設定を推測で上書きすると
 * 本体側の cleanup がスキップされ続ける状態を気付かず悪化させるため。
 */
export async function readSettings(file = userSettingsFile()): Promise<SettingsFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, data: null };
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} が JSON として読めません: ${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${file} の中身がオブジェクトではありません`);
  }
  return { path: file, data: data as Record<string, unknown> };
}

/** 現在の cleanupPeriodDays。未設定なら null(= デフォルト 30 日が適用される) */
export async function getRetentionDays(file = userSettingsFile()): Promise<number | null> {
  const { data } = await readSettings(file);
  const value = data?.cleanupPeriodDays;
  return typeof value === 'number' ? value : null;
}

/**
 * cleanupPeriodDays を書き込む。既存のキーと並び順は保持し、
 * 一時ファイル経由の rename で差し替える(書き込み中の中断で設定を壊さないため)。
 */
export async function setRetentionDays(days: number, file = userSettingsFile()): Promise<void> {
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new Error(
      `保持日数は ${MIN_RETENTION_DAYS} 以上の整数で指定してください` +
        `(0 は本体に拒否されます。実質無期限にしたい場合は ${FOREVER_RETENTION_DAYS} のような大きい値を使います)`,
    );
  }
  const { data } = await readSettings(file);
  const next = { ...(data ?? {}), cleanupPeriodDays: days };
  const tmp = `${file}.cctl.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
