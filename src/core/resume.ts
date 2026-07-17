// claude --resume の spawn

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SessionMeta } from './transcripts.js';

export interface ResumeOptions {
  skipPermissions: boolean;
  extraArgs?: string[];
}

/**
 * `claude --resume <sessionId>` をセッションの元 cwd で spawn する。
 * cwd が存在しない場合は Error を投げる(呼び出し側でメッセージ整形すること)。
 * 子プロセスの exit code をそのまま返す。
 */
export async function resumeSession(meta: SessionMeta, opts: ResumeOptions): Promise<number> {
  const cwd = meta.cwd;
  if (!cwd || !existsSync(cwd)) {
    throw new Error(`セッションの cwd が見つかりません: ${cwd ?? '(不明)'}`);
  }

  const args = ['--resume', meta.sessionId];
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.extraArgs && opts.extraArgs.length > 0) args.push(...opts.extraArgs);

  return new Promise<number>((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: 'inherit' });
    child.on('error', (err) => reject(err));
    child.on('exit', (code, signal) => {
      if (code !== null) {
        resolve(code);
      } else {
        resolve(signal ? 1 : 0);
      }
    });
  });
}
