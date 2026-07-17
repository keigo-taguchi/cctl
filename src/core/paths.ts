// ~/.claude 配下のパス解決

import os from 'node:os';
import path from 'node:path';

/** ~/.claude のルートディレクトリ */
export function claudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** ~/.claude/sessions (実行中セッションレジストリ) */
export function sessionsDir(): string {
  return path.join(claudeDir(), 'sessions');
}

/** ~/.claude/projects (トランスクリプト格納先) */
export function projectsDir(): string {
  return path.join(claudeDir(), 'projects');
}

/** ~/.claude/history.jsonl */
export function historyFile(): string {
  return path.join(claudeDir(), 'history.jsonl');
}

/**
 * cwd をトランスクリプトのディレクトリ名にエンコードする。
 * `/` と `.` を `-` に置換する(逆変換は曖昧なので使用しないこと)。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** ~/.claude/projects/<encoded cwd> の絶対パス */
export function projectDirForCwd(cwd: string): string {
  return path.join(projectsDir(), encodeCwd(cwd));
}
