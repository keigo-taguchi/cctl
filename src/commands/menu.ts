import type { Command } from 'commander';
import { select, text, isCancel, intro, outro } from '@clack/prompts';
import pc from 'picocolors';
import { runPs } from './ps.js';
import { runSearch } from './search.js';
import { runClean } from './clean.js';
import { runResume } from './resume.js';
import { runFind } from './find.js';

/** 標準入出力が TTY かどうか(対話プロンプトが使えるかどうか)を判定する。 */
function isInteractiveTTY(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** エラーメッセージを赤色で stderr に出し、exit code 1 で終了する。 */
function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

type MenuAction = 'ps' | 'resume' | 'search' | 'find' | 'clean' | 'exit';

export async function runMenu(): Promise<void> {
  if (!isInteractiveTTY()) {
    fail('対話モードには TTY が必要です。');
  }

  intro('cctl — Claude Code Session Manager');

  for (;;) {
    const action = await select<MenuAction>({
      message: '何をしますか?',
      options: [
        { value: 'ps', label: '📡 実行中セッションを見る' },
        { value: 'resume', label: '▶ セッションを再開' },
        { value: 'search', label: '🔍 検索' },
        { value: 'find', label: '🔎 セッションを探す(インクリメンタル検索)' },
        { value: 'clean', label: '🧹 クリーンアップ' },
        { value: 'exit', label: '終了' },
      ],
    });

    if (isCancel(action) || action === 'exit') {
      outro('また使ってください');
      return;
    }

    try {
      switch (action) {
        case 'ps':
          await runPs({});
          break;
        case 'resume':
          await runResume({});
          break;
        case 'search': {
          const keyword = await text({
            message: '検索キーワードを入力してください',
            validate: (value) => ((value ?? '').trim().length === 0 ? 'キーワードを入力してください' : undefined),
          });
          if (isCancel(keyword)) {
            break;
          }
          await runSearch(keyword, {});
          break;
        }
        case 'find':
          await runFind({});
          break;
        case 'clean':
          await runClean({});
          break;
      }
    } catch (err) {
      console.error(pc.red(`✖ ${err instanceof Error ? err.message : String(err)}`));
    }

    console.log();
  }
}

export function register(program: Command): void {
  program
    .command('menu')
    .description('トップメニューを表示します')
    .action(async () => {
      await runMenu();
    });
}
