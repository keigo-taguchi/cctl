// 実行中セッション取得

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sessionsDir } from './paths.js';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string; // "busy" | "idle" | その他
  startedAt: number; // epoch ms
  updatedAt: number;
  version: string;
  alive: boolean; // process.kill(pid, 0) の結果
}

/** pid が生きているかどうかを判定する。EPERM は alive 扱い、ESRCH は dead。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false; // ESRCH その他
  }
}

/**
 * ~/.claude/sessions/<pid>.json を読み、生存しているものだけ返す。
 * updatedAt 降順。
 */
export async function getLiveSessions(): Promise<LiveSession[]> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json'));

  const sessions: LiveSession[] = [];
  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    try {
      const raw = await readFile(filePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      const pid = Number(data.pid);
      if (!Number.isFinite(pid)) continue;

      const alive = isAlive(pid);
      if (!alive) continue;

      sessions.push({
        pid,
        sessionId: String(data.sessionId ?? ''),
        cwd: String(data.cwd ?? ''),
        name: String(data.name ?? ''),
        status: String(data.status ?? ''),
        startedAt: Number(data.startedAt ?? 0),
        updatedAt: Number(data.updatedAt ?? data.statusUpdatedAt ?? 0),
        version: String(data.version ?? ''),
        alive: true,
      });
    } catch {
      // 壊れたファイルは無視
      continue;
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}
