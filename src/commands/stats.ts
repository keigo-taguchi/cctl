import type { Command } from 'commander';
import pc from 'picocolors';
import { aggregateUsage, type ModelUsage } from '../core/usage.js';
import { table } from '../core/format.js';

/** トークン数を "1.2M" "345K" 形式に整形する。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** コストを "$12.34" 形式に整形する。null は "-"。 */
function fmtCost(cost: number | null): string {
  if (cost === null) return '-';
  return `$${cost.toFixed(2)}`;
}

export interface StatsOptions {
  project?: string;
  days?: number;
  json?: boolean;
}

/** cctl stats の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runStats(opts: StatsOptions = {}): Promise<void> {
  // "." は cwd に解決してから encoded 名に変換する(list と同じ扱い。実際の変換は aggregateUsage 内で行う)。
  const project = opts.project === '.' ? process.cwd() : opts.project;

  const usages = await aggregateUsage({ project, days: opts.days });

  if (opts.json) {
    console.log(JSON.stringify(usages, null, 2));
    return;
  }

  if (usages.length === 0) {
    console.log('集計対象のデータがありません');
    return;
  }

  const rows = usages.map((u: ModelUsage) => [
    u.model,
    String(u.calls),
    fmtTokens(u.inputTokens),
    fmtTokens(u.outputTokens),
    fmtTokens(u.cacheWrite5m + u.cacheWrite1h),
    fmtTokens(u.cacheRead),
    fmtCost(u.costUSD),
  ]);

  const totalCalls = usages.reduce((sum, u) => sum + u.calls, 0);
  const totalInput = usages.reduce((sum, u) => sum + u.inputTokens, 0);
  const totalOutput = usages.reduce((sum, u) => sum + u.outputTokens, 0);
  const totalCacheW = usages.reduce((sum, u) => sum + u.cacheWrite5m + u.cacheWrite1h, 0);
  const totalCacheR = usages.reduce((sum, u) => sum + u.cacheRead, 0);
  const hasKnownCost = usages.some((u) => u.costUSD !== null);
  const totalCost = hasKnownCost ? usages.reduce((sum, u) => sum + (u.costUSD ?? 0), 0) : null;

  rows.push([
    pc.bold('TOTAL'),
    String(totalCalls),
    fmtTokens(totalInput),
    fmtTokens(totalOutput),
    fmtTokens(totalCacheW),
    fmtTokens(totalCacheR),
    pc.bold(fmtCost(totalCost)),
  ]);

  console.log(table(rows, { header: ['MODEL', 'CALLS', 'INPUT', 'OUTPUT', 'CACHE W', 'CACHE R', 'COST'] }));
  console.log();
  console.log(pc.dim('※ コストは概算です(標準API価格・キャッシュ係数で計算)'));
}

export function register(program: Command): void {
  program
    .command('stats')
    .description('モデル別のトークン使用量とコストを集計します')
    .option('-p, --project <path>', '指定パスのセッションのみ集計します(. で現在のディレクトリ)')
    .option('-d, --days <n>', '直近 n 日以内の assistant 応答のみ集計します')
    .option('--json', '集計結果を JSON 出力します')
    .action(async (options: { project?: string; days?: string; json?: boolean }) => {
      const parsedDays = options.days !== undefined ? Number(options.days) : undefined;
      const days = parsedDays !== undefined && Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : undefined;
      await runStats({
        project: options.project,
        days,
        json: options.json,
      });
    });
}
