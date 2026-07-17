// モデル別トークン使用量・コスト集計

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDir, projectDirForCwd } from './paths.js';
import { listProjects } from './transcripts.js';

export interface ModelUsage {
  model: string;
  calls: number; // 重複排除後の API 呼び出し数
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  costUSD: number | null; // 価格表にないモデルは null
}

const DAY_MS = 24 * 60 * 60 * 1000;

// --- 価格表(2026-07 時点。単位: USD / MTok) -------------------------------

interface PriceRule {
  prefix: string;
  price: (now: Date) => { input: number; output: number };
}

/** sonnet-5 導入価格の期限(この日時以前は input 2 / output 10)。 */
const SONNET5_INTRO_CUTOFF = new Date('2026-08-31T23:59:59.999Z');

const flat = (input: number, output: number) => () => ({ input, output });

// prefix は「前方一致」で判定するため、より長く具体的なものを先に判定できるよう
// 末尾で prefix.length 降順にソートする(例: "claude-opus-4-1" を "claude-opus-4-" より先に判定する)。
const PRICE_TABLE: PriceRule[] = [
  { prefix: 'claude-fable-5', price: flat(10, 50) },
  { prefix: 'claude-mythos-5', price: flat(10, 50) },
  { prefix: 'claude-opus-4-8', price: flat(5, 25) },
  { prefix: 'claude-opus-4-7', price: flat(5, 25) },
  { prefix: 'claude-opus-4-6', price: flat(5, 25) },
  { prefix: 'claude-opus-4-5', price: flat(5, 25) },
  { prefix: 'claude-opus-4-1', price: flat(15, 75) },
  { prefix: 'claude-opus-4-0', price: flat(15, 75) },
  { prefix: 'claude-opus-4-', price: flat(15, 75) }, // 旧世代の catch-all
  {
    prefix: 'claude-sonnet-5',
    price: (now: Date) =>
      now.getTime() <= SONNET5_INTRO_CUTOFF.getTime() ? { input: 2, output: 10 } : { input: 3, output: 15 },
  },
  { prefix: 'claude-sonnet-4-6', price: flat(3, 15) },
  { prefix: 'claude-sonnet-4-5', price: flat(3, 15) },
  { prefix: 'claude-sonnet-4-0', price: flat(3, 15) },
  { prefix: 'claude-haiku-4-5', price: flat(1, 5) },
].sort((a, b) => b.prefix.length - a.prefix.length);

function getPrice(model: string, now: Date): { input: number; output: number } | null {
  for (const rule of PRICE_TABLE) {
    if (model.startsWith(rule.prefix)) return rule.price(now);
  }
  return null;
}

// --- usage 行のパースと重複排除 ---------------------------------------------

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

interface Accumulator {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function newAccumulator(): Accumulator {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function addUsageToAcc(acc: Accumulator, usage: RawUsage): void {
  acc.calls++;
  acc.inputTokens += numOr0(usage.input_tokens);
  acc.outputTokens += numOr0(usage.output_tokens);
  acc.cacheRead += numOr0(usage.cache_read_input_tokens);
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    acc.cacheWrite5m += numOr0(usage.cache_creation.ephemeral_5m_input_tokens);
    acc.cacheWrite1h += numOr0(usage.cache_creation.ephemeral_1h_input_tokens);
  } else {
    // cache_creation オブジェクトがない行は cache_creation_input_tokens 全量を 5m 扱い。
    acc.cacheWrite5m += numOr0(usage.cache_creation_input_tokens);
  }
}

interface DedupEntry {
  model: string;
  usage: RawUsage;
  timestampMs: number | null;
}

/**
 * 1 ファイル分の assistant 行をストリーミングで読み、requestId(なければ message.id、
 * それも無ければ行の uuid)で重複排除しつつ、モデル別の Accumulator に加算する。
 * 重複排除用の Map はファイル単位で作成しファイル処理後に破棄する(メモリ節約)。
 */
async function processFile(filePath: string, modelAcc: Map<string, Accumulator>, cutoffMs: number | null): Promise<void> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const dedup = new Map<string, DedupEntry>();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    // file-history-snapshot 等の巨大行を parse せず素通りするための前置フィルタ。
    if (!line.includes('"type":"assistant"')) continue;

    let obj: {
      requestId?: unknown;
      uuid?: unknown;
      timestamp?: unknown;
      message?: { model?: unknown; id?: unknown; usage?: unknown };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const message = obj.message;
    if (!message || typeof message !== 'object') continue;
    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;

    const model = typeof message.model === 'string' ? message.model : 'unknown';

    const key =
      typeof obj.requestId === 'string'
        ? obj.requestId
        : typeof message.id === 'string'
          ? message.id
          : typeof obj.uuid === 'string'
            ? obj.uuid
            : null;
    if (key === null) continue;

    let timestampMs: number | null = null;
    if (typeof obj.timestamp === 'string') {
      const parsed = Date.parse(obj.timestamp);
      if (Number.isFinite(parsed)) timestampMs = parsed;
    }

    // 同一 requestId は最後の行の usage で上書きする(1 回だけ計上するため)。
    dedup.set(key, { model, usage: usage as RawUsage, timestampMs });
  }

  for (const entry of dedup.values()) {
    if (cutoffMs !== null) {
      if (entry.timestampMs === null || entry.timestampMs < cutoffMs) continue;
    }
    let acc = modelAcc.get(entry.model);
    if (!acc) {
      acc = newAccumulator();
      modelAcc.set(entry.model, acc);
    }
    addUsageToAcc(acc, entry.usage);
  }
}

// --- プロジェクト解決とファイル列挙(transcripts.ts と同等のロジック) -----------

/**
 * project オプションを実ディレクトリに解決する。
 * すでに encoded ディレクトリ名が渡された場合はそのまま、
 * cwd のようなパスが渡された場合は encodeCwd 相当の変換をして解決する。
 * (transcripts.ts の resolveProjectDir は非公開のため、同等のロジックをここに複製する)
 */
async function resolveProjectDir(project: string): Promise<string | null> {
  const direct = path.join(projectsDir(), project);
  try {
    const directStat = await stat(direct);
    if (directStat.isDirectory()) return direct;
  } catch {
    // fall through
  }

  const encoded = projectDirForCwd(project);
  try {
    const encodedStat = await stat(encoded);
    if (encodedStat.isDirectory()) return encoded;
  } catch {
    // fall through
  }

  return null;
}

/** 1 プロジェクトディレクトリ直下の *.jsonl ファイルのみを列挙する(subagents 等のサブディレクトリは除外)。 */
async function collectJsonlFiles(projectDirPath: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectDirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    files.push(path.join(projectDirPath, entry.name));
  }
  return files;
}

/** 同時オープンする fd 数を抑えるための簡易な並行数制限付き map。 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
}

/**
 * 全プロジェクト(または指定 project)の jsonl をストリーミングで読み、
 * requestId による重複排除を行った上でモデル別に集計する。
 */
export async function aggregateUsage(opts?: { project?: string; days?: number }): Promise<ModelUsage[]> {
  const cutoffMs = opts?.days != null ? Date.now() - opts.days * DAY_MS : null;

  let files: string[] = [];
  if (opts?.project) {
    const dir = await resolveProjectDir(opts.project);
    files = dir ? await collectJsonlFiles(dir) : [];
  } else {
    const projects = await listProjects();
    const perProject = await Promise.all(projects.map((p) => collectJsonlFiles(path.join(projectsDir(), p))));
    files = perProject.flat();
  }

  const modelAcc = new Map<string, Accumulator>();
  await mapWithConcurrency(files, 32, (f) => processFile(f, modelAcc, cutoffMs));

  const now = new Date();
  const results: ModelUsage[] = [];
  for (const [model, acc] of modelAcc) {
    const price = getPrice(model, now);
    const costUSD = price
      ? (acc.inputTokens * price.input +
          acc.outputTokens * price.output +
          acc.cacheWrite5m * 1.25 * price.input +
          acc.cacheWrite1h * 2 * price.input +
          acc.cacheRead * 0.1 * price.input) /
        1_000_000
      : null;
    results.push({
      model,
      calls: acc.calls,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheWrite5m: acc.cacheWrite5m,
      cacheWrite1h: acc.cacheWrite1h,
      cacheRead: acc.cacheRead,
      costUSD,
    });
  }

  results.sort((a, b) => {
    if (a.costUSD === null && b.costUSD === null) return 0;
    if (a.costUSD === null) return 1;
    if (b.costUSD === null) return -1;
    return b.costUSD - a.costUSD;
  });

  return results;
}
