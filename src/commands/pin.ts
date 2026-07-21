import type { Command } from 'commander';
import pc from 'picocolors';
import { findSession, parseSessionMeta } from '../core/transcripts.js';
import {
  addPin,
  archivePath,
  archiveSession,
  configDir,
  findPin,
  isArchiveStale,
  loadPins,
  removePin,
  restoreArchive,
  savePins,
  sourceExists,
  type PinEntry,
  type RestoreResult,
} from '../core/pins.js';
import { table, relTime, fmtSize, truncate, shortId } from '../core/format.js';

const TITLE_WIDTH = 34;

function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

function labelOf(entry: PinEntry): string {
  return entry.title ?? '(no title)';
}

/** cctl pin の本体ロジック。 */
export async function runPin(idPrefix: string, opts: { archive?: boolean } = {}): Promise<void> {
  const meta = await findSession(idPrefix);
  if (!meta) fail(`セッションが見つかりません: ${idPrefix}`);

  const withArchive = opts.archive !== false;
  const entry = await addPin(meta, { archive: withArchive });

  console.log(pc.green(`✓ pin しました: ${shortId(meta.sessionId)} ${labelOf(entry)}`));
  if (entry.archive && withArchive) {
    const { sourceSize, archivedSize, fileCount } = entry.archive;
    const sidecar = fileCount > 1 ? `(サブエージェント含む ${fileCount}ファイル)` : '';
    console.log(
      pc.dim(`  アーカイブ: ${fmtSize(sourceSize)} → ${fmtSize(archivedSize)} ${sidecar}`),
    );
    console.log(pc.dim(`  ${archivePath(entry.archive)}`));
  } else if (!withArchive) {
    console.log(pc.dim('  --no-archive のため印のみ付けました(cctl clean からは除外されます)'));
  }
}

/** cctl unpin の本体ロジック。 */
export async function runUnpin(idPrefix: string, opts: { purge?: boolean } = {}): Promise<void> {
  const pins = await loadPins();
  const matched = pins.filter((p) => p.sessionId.startsWith(idPrefix));
  if (matched.length === 0) fail(`pin されたセッションが見つかりません: ${idPrefix}`);
  if (matched.length > 1) {
    fail(`${idPrefix} は ${matched.length}件に一致します。より長い ID を指定してください`);
  }

  const entry = await removePin(matched[0].sessionId, { purge: opts.purge === true });
  if (!entry) fail(`pin されたセッションが見つかりません: ${idPrefix}`);

  console.log(pc.green(`✓ pin を解除しました: ${shortId(entry.sessionId)} ${labelOf(entry)}`));
  if (opts.purge) {
    console.log(pc.dim('  アーカイブも削除しました'));
  } else if (entry.archive) {
    console.log(pc.dim('  アーカイブは残しています(削除するには --purge)'));
  }
}

/** pin 済みのアーカイブを最新化する。 */
async function syncPins(): Promise<void> {
  const pins = await loadPins();
  if (pins.length === 0) {
    console.log('pin されたセッションはありません');
    return;
  }

  let updated = 0;
  let missing = 0;
  const next: PinEntry[] = [];

  for (const entry of pins) {
    if (!(await sourceExists(entry))) {
      missing++;
      next.push(entry);
      continue;
    }
    if (!(await isArchiveStale(entry))) {
      next.push(entry);
      continue;
    }
    const meta = await parseSessionMeta(entry.originalPath);
    const archive = await archiveSession(meta);
    next.push({
      ...entry,
      title: meta.title ?? meta.firstUserMessage ?? entry.title,
      cwd: meta.cwd ?? entry.cwd,
      archive,
    });
    updated++;
    console.log(pc.dim(`  ↑ ${shortId(entry.sessionId)} ${labelOf(entry)}`));
  }

  await savePins(next);
  console.log(pc.green(`✓ ${updated}件のアーカイブを更新しました`));
  if (missing > 0) {
    console.log(
      pc.yellow(`  ⚠ ${missing}件は元ファイルが消えています(cctl restore <id> で復元できます)`),
    );
  }
}

/** cctl pins の本体ロジック。menu.ts からも呼び出し可能。 */
export async function runPins(opts: { sync?: boolean; json?: boolean } = {}): Promise<void> {
  if (opts.sync) {
    await syncPins();
    return;
  }

  const pins = await loadPins();
  if (pins.length === 0) {
    console.log('pin されたセッションはありません');
    console.log(pc.dim('  cctl pin <id> で永続化できます'));
    return;
  }

  const states = await Promise.all(
    pins.map(async (entry) => ({
      entry,
      exists: await sourceExists(entry),
      stale: await isArchiveStale(entry),
    })),
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        states.map((s) => ({ ...s.entry, sourceExists: s.exists, archiveStale: s.stale })),
        null,
        2,
      ),
    );
    return;
  }

  const rows = states.map(({ entry, exists, stale }) => {
    let state: string;
    if (!exists) state = pc.yellow('元ファイルなし');
    else if (stale) state = pc.cyan('更新あり');
    else state = pc.green('同期済み');

    return [
      shortId(entry.sessionId),
      truncate(labelOf(entry), TITLE_WIDTH),
      state,
      entry.archive ? fmtSize(entry.archive.archivedSize) : '-',
      relTime(new Date(entry.pinnedAt)),
    ];
  });

  console.log(table(rows, { header: ['ID', 'TITLE', 'STATE', 'ARCHIVE', 'PINNED'] }));
  console.log();
  console.log(pc.dim(`  保管先: ${configDir()}`));

  if (states.some((s) => !s.exists)) {
    console.log(pc.dim('  「元ファイルなし」は cctl restore <id> で復元できます'));
  }
  if (states.some((s) => s.exists && s.stale)) {
    console.log(pc.dim('  「更新あり」は cctl pins --sync でアーカイブを最新化できます'));
  }
}

/** cctl restore の本体ロジック。 */
export async function runRestore(idPrefix: string, opts: { force?: boolean } = {}): Promise<void> {
  const pins = await loadPins();
  const matched = pins.filter((p) => p.sessionId.startsWith(idPrefix));
  if (matched.length === 0) fail(`pin されたセッションが見つかりません: ${idPrefix}`);
  if (matched.length > 1) {
    fail(`${idPrefix} は ${matched.length}件に一致します。より長い ID を指定してください`);
  }

  const entry = matched[0];
  let result: RestoreResult;
  try {
    result = await restoreArchive(entry, { force: opts.force === true });
  } catch (err) {
    fail((err as Error).message);
  }

  console.log(pc.green(`✓ 復元しました: ${result.path}`));
  if (result.fileCount > 1) {
    console.log(pc.dim(`  サブエージェント含む ${result.fileCount}ファイルを展開しました`));
  }
  console.log(pc.dim(`  cctl resume ${shortId(entry.sessionId)} で再開できます`));
}

export function register(program: Command): void {
  program
    .command('pin <idPrefix>')
    .description('セッションを永続化します(clean の対象外にし、アーカイブを保管します)')
    .option('--no-archive', 'アーカイブを作らず印だけ付けます')
    .action(async (idPrefix: string, options: { archive?: boolean }) => {
      await runPin(idPrefix, { archive: options.archive });
    });

  program
    .command('unpin <idPrefix>')
    .description('永続化を解除します')
    .option('--purge', 'アーカイブ実体も削除します')
    .action(async (idPrefix: string, options: { purge?: boolean }) => {
      await runUnpin(idPrefix, { purge: options.purge });
    });

  program
    .command('pins')
    .description('永続化したセッションの一覧を表示します')
    .option('--sync', 'アーカイブを最新の内容に更新します')
    .option('--json', 'JSON で出力します')
    .action(async (options: { sync?: boolean; json?: boolean }) => {
      await runPins({ sync: options.sync, json: options.json });
    });

  program
    .command('restore <idPrefix>')
    .description('アーカイブからセッションを復元します')
    .option('--force', '復元先に既にファイルがある場合も上書きします')
    .action(async (idPrefix: string, options: { force?: boolean }) => {
      await runRestore(idPrefix, { force: options.force });
    });
}
