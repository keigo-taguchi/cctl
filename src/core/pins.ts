// pin(永続化マーク)とアーカイブの管理
//
// pin は 2 つの役割を兼ねる:
//   1. cctl clean の削除対象から除外する論理マーク
//   2. gzip アーカイブの物理コピー(本体や他の経路で消えても復元できる保険)
// 保存先は ~/.claude を汚さないよう ~/.config/cctl 配下に置く。

import { createReadStream, createWriteStream, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import type { SessionMeta } from './transcripts.js';

const PINS_VERSION = 1;

export interface ArchiveInfo {
  /** 設定ディレクトリからの相対パス(アーカイブ 1 件につき 1 ディレクトリ) */
  dir: string;
  archivedAt: string;
  /** gzip 後の合計サイズ */
  archivedSize: number;
  /** アーカイブ元の合計サイズと mtime(内容が進んだかの判定に使う) */
  sourceSize: number;
  sourceMtime: string;
  /** メイン + サイドカーのファイル数 */
  fileCount: number;
}

export interface PinEntry {
  sessionId: string;
  pinnedAt: string;
  /** pin した時点のタイトル。元ファイルが消えても一覧に出せるよう控えておく */
  title: string | null;
  cwd: string | null;
  /** pin した時点の jsonl の絶対パス(restore の復元先になる) */
  originalPath: string;
  archive: ArchiveInfo | null;
}

interface PinsFileData {
  version: number;
  pins: PinEntry[];
}

/** ~/.config/cctl(XDG_CONFIG_HOME があればそちら) */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'cctl');
}

export function pinsFile(): string {
  return path.join(configDir(), 'pins.json');
}

export function archiveDir(): string {
  return path.join(configDir(), 'archive');
}

/** アーカイブ情報の相対パスを絶対パスに解決する */
export function archivePath(info: ArchiveInfo): string {
  return path.join(configDir(), info.dir);
}

/**
 * セッションのサイドカーディレクトリ。
 * サブエージェント / ワークフローのトランスクリプトが
 * `projects/<encoded>/<sessionId>/subagents/...` に入れ子で置かれるため、
 * メインの jsonl だけを保管しても履歴は復元しきれない。
 */
export function sidecarDir(originalPath: string, sessionId: string): string {
  return path.join(path.dirname(originalPath), sessionId);
}

/** ディレクトリ配下のファイルを相対パスで再帰列挙する */
async function walkFiles(root: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** 1 ファイルを gzip して書き出し、書き込み後のサイズを返す */
async function gzipTo(src: string, dest: string): Promise<number> {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await pipeline(createReadStream(src), createGzip(), createWriteStream(tmp));
  await rename(tmp, dest);
  return (await stat(dest)).size;
}

export async function loadPins(): Promise<PinEntry[]> {
  let raw: string;
  try {
    raw = await readFile(pinsFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${pinsFile()} が JSON として読めません: ${(err as Error).message}`);
  }
  const pins = (data as PinsFileData | null)?.pins;
  return Array.isArray(pins) ? pins : [];
}

export async function savePins(entries: PinEntry[]): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const body: PinsFileData = { version: PINS_VERSION, pins: entries };
  const file = pinsFile();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** clean 側が除外判定に使う軽量 API */
export async function getPinnedIds(): Promise<Set<string>> {
  const pins = await loadPins();
  return new Set(pins.map((p) => p.sessionId));
}

export async function findPin(sessionId: string): Promise<PinEntry | null> {
  const pins = await loadPins();
  return pins.find((p) => p.sessionId === sessionId) ?? null;
}

/** アーカイブに必要な最小限の情報(SessionMeta をそのまま渡せる) */
export interface ArchiveSource {
  sessionId: string;
  filePath: string;
  size: number;
  mtime: Date;
}

/**
 * メインの jsonl とサイドカー(サブエージェント / ワークフロー)を
 * まとめて gzip アーカイブする。8MB 超のファイルがあるため
 * 全読み込みはせずストリームで流す。
 *
 * 配置:
 *   archive/<sessionId>/session.jsonl.gz
 *   archive/<sessionId>/sidecar/<元の相対パス>.gz
 */
export async function archiveSession(meta: ArchiveSource): Promise<ArchiveInfo> {
  const rel = path.join('archive', meta.sessionId);
  const dest = path.join(configDir(), rel);

  // 前回のアーカイブが残っていると、消えたサイドカーが復活してしまう
  await rm(dest, { recursive: true, force: true });

  let archivedSize = await gzipTo(meta.filePath, path.join(dest, 'session.jsonl.gz'));
  let sourceSize = meta.size;
  let fileCount = 1;

  const sidecar = sidecarDir(meta.filePath, meta.sessionId);
  for (const rel of await walkFiles(sidecar)) {
    const src = path.join(sidecar, rel);
    archivedSize += await gzipTo(src, path.join(dest, 'sidecar', `${rel}.gz`));
    sourceSize += (await stat(src)).size;
    fileCount++;
  }

  return {
    dir: rel,
    archivedAt: new Date().toISOString(),
    archivedSize,
    sourceSize,
    sourceMtime: meta.mtime.toISOString(),
    fileCount,
  };
}

/** メイン + サイドカーの合計サイズ(stale 判定用) */
export async function measureSessionSize(originalPath: string, sessionId: string): Promise<number> {
  let total = 0;
  try {
    total += (await stat(originalPath)).size;
  } catch {
    return 0;
  }
  const sidecar = sidecarDir(originalPath, sessionId);
  for (const rel of await walkFiles(sidecar)) {
    try {
      total += (await stat(path.join(sidecar, rel))).size;
    } catch {
      // 列挙後に消えたファイルは無視する
    }
  }
  return total;
}

/** アーカイブが元ファイルより古いか(pin 後に会話が進んだか) */
export async function isArchiveStale(entry: PinEntry): Promise<boolean> {
  if (!entry.archive) return true;
  if (!(await sourceExists(entry))) return false; // 元が無いなら「古い」ではなく「これが最後の記録」
  const size = await measureSessionSize(entry.originalPath, entry.sessionId);
  return size !== entry.archive.sourceSize;
}

export async function sourceExists(entry: PinEntry): Promise<boolean> {
  try {
    await stat(entry.originalPath);
    return true;
  } catch {
    return false;
  }
}

/** pin を追加(既存があれば更新)する */
export async function addPin(
  meta: SessionMeta,
  opts: { archive: boolean } = { archive: true },
): Promise<PinEntry> {
  const archive = opts.archive ? await archiveSession(meta) : null;
  const pins = await loadPins();
  const existing = pins.find((p) => p.sessionId === meta.sessionId);

  const entry: PinEntry = {
    sessionId: meta.sessionId,
    pinnedAt: existing?.pinnedAt ?? new Date().toISOString(),
    title: meta.title ?? meta.firstUserMessage ?? null,
    cwd: meta.cwd,
    originalPath: meta.filePath,
    // --no-archive で再 pin したときに既存アーカイブを消さない
    archive: archive ?? existing?.archive ?? null,
  };

  const next = existing
    ? pins.map((p) => (p.sessionId === meta.sessionId ? entry : p))
    : [...pins, entry];
  await savePins(next);
  return entry;
}

/** pin を解除する。purge 指定時はアーカイブ実体も削除する */
export async function removePin(
  sessionId: string,
  opts: { purge: boolean } = { purge: false },
): Promise<PinEntry | null> {
  const pins = await loadPins();
  const entry = pins.find((p) => p.sessionId === sessionId);
  if (!entry) return null;

  if (opts.purge && entry.archive) {
    await rm(archivePath(entry.archive), { recursive: true, force: true });
  }
  await savePins(pins.filter((p) => p.sessionId !== sessionId));
  return entry;
}

/** 1 ファイルを展開して書き出す */
async function gunzipTo(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.cctl.tmp`;
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(tmp));
  await rename(tmp, dest);
}

export interface RestoreResult {
  path: string;
  fileCount: number;
}

/**
 * アーカイブから ~/.claude/projects 配下へ復元する。復元先は pin 時の
 * originalPath とそのサイドカーディレクトリ。
 * 既にファイルがある場合は force 指定がなければ拒否する。
 */
export async function restoreArchive(
  entry: PinEntry,
  opts: { force: boolean } = { force: false },
): Promise<RestoreResult> {
  if (!entry.archive) {
    throw new Error('このセッションにはアーカイブがありません(--no-archive で pin されています)');
  }
  const src = archivePath(entry.archive);
  const mainGz = path.join(src, 'session.jsonl.gz');
  try {
    await stat(mainGz);
  } catch {
    throw new Error(`アーカイブ実体が見つかりません: ${mainGz}`);
  }

  const dest = entry.originalPath;
  if (!opts.force && (await sourceExists(entry))) {
    throw new Error(`復元先に既にファイルがあります: ${dest}(上書きするには --force)`);
  }

  await gunzipTo(mainGz, dest);
  let fileCount = 1;

  const sidecarSrc = path.join(src, 'sidecar');
  const sidecarDest = sidecarDir(dest, entry.sessionId);
  for (const rel of await walkFiles(sidecarSrc)) {
    if (!rel.endsWith('.gz')) continue;
    await gunzipTo(path.join(sidecarSrc, rel), path.join(sidecarDest, rel.slice(0, -'.gz'.length)));
    fileCount++;
  }

  return { path: dest, fileCount };
}
