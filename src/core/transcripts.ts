// セッション一覧・メタ抽出・全文検索

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDir, projectDirForCwd } from './paths.js';

export interface SessionMeta {
  sessionId: string;
  projectDir: string; // ~/.claude/projects/<encoded> の絶対パス
  filePath: string; // jsonl の絶対パス
  cwd: string | null; // トランスクリプトから復元した実 cwd
  title: string | null; // 最後の ai-title
  lastPrompt: string | null;
  gitBranch: string | null;
  permissionMode: string | null; // 最後の permission-mode
  firstUserMessage: string | null; // isMeta でない最初の user テキスト(title の代替)
  messageCount: number; // user + assistant の行数(概算で可)
  mtime: Date;
  size: number; // bytes
}

interface JsonlFileStat {
  filePath: string;
  mtime: Date;
  size: number;
}

/**
 * 行を先に文字列レベルで判定してから必要な行だけ JSON.parse する。
 * 実データでは "type" フィールドがオブジェクトの先頭に来るとは限らない
 * (user/assistant 行は parentUuid 等が先行する)ため、startsWith ではなく
 * includes による前置フィルタで判定する。file-history-snapshot 等の
 * 巨大な行(数百KB超)を parse せず素通りできることが目的。
 */
function lineHasType(line: string, type: string): boolean {
  return line.includes(`"type":"${type}"`);
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

// <local-command-caveat>, <command-name>, <local-command-stdout>, <bash-input>,
// <bash-stdout>, <task-notification> 等、システムが注入するラッパー系タグ。
// 実データにはここに列挙しきれないタグも出現するため、
// "<tag-name>" 形式で始まるものは一律ユーザー発話として扱わない。
const WRAPPER_TAG_RE = /^<[\w-]+>/;

function isRealUserText(text: string | null, isMeta: unknown): boolean {
  if (!text) return false;
  if (isMeta === true) return false;
  if (WRAPPER_TAG_RE.test(text)) return false;
  return true;
}

/** jsonl をストリーミングで読み、SessionMeta を抽出する。 */
export async function parseSessionMeta(filePath: string): Promise<SessionMeta> {
  const sessionId = path.basename(filePath, '.jsonl');
  const projectDir = path.dirname(filePath);
  const st = await stat(filePath);

  let cwd: string | null = null;
  let title: string | null = null;
  let lastPrompt: string | null = null;
  let gitBranch: string | null = null;
  let permissionMode: string | null = null;
  let firstUserMessage: string | null = null;
  let messageCount = 0;

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    if (lineHasType(line, 'ai-title')) {
      try {
        const obj = JSON.parse(line) as { aiTitle?: unknown };
        if (typeof obj.aiTitle === 'string') title = obj.aiTitle; // 最後のものを採用
      } catch {
        // 壊れた行は無視
      }
      continue;
    }

    if (lineHasType(line, 'last-prompt')) {
      try {
        const obj = JSON.parse(line) as { lastPrompt?: unknown };
        if (typeof obj.lastPrompt === 'string') lastPrompt = obj.lastPrompt; // 最後のものを採用
      } catch {
        // ignore
      }
      continue;
    }

    if (lineHasType(line, 'permission-mode')) {
      try {
        const obj = JSON.parse(line) as { permissionMode?: unknown };
        if (typeof obj.permissionMode === 'string') permissionMode = obj.permissionMode; // 最後の値
      } catch {
        // ignore
      }
      continue;
    }

    if (lineHasType(line, 'user')) {
      try {
        const obj = JSON.parse(line) as {
          cwd?: unknown;
          gitBranch?: unknown;
          isMeta?: unknown;
          message?: { content?: unknown };
        };
        messageCount++;
        if (cwd === null && typeof obj.cwd === 'string') cwd = obj.cwd;
        if (gitBranch === null && typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch;
        if (firstUserMessage === null) {
          const text = extractText(obj.message?.content);
          if (isRealUserText(text, obj.isMeta)) firstUserMessage = text;
        }
      } catch {
        // ignore
      }
      continue;
    }

    if (lineHasType(line, 'assistant')) {
      try {
        const obj = JSON.parse(line) as { cwd?: unknown; gitBranch?: unknown };
        messageCount++;
        if (cwd === null && typeof obj.cwd === 'string') cwd = obj.cwd;
        if (gitBranch === null && typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch;
      } catch {
        // ignore
      }
      continue;
    }
  }

  return {
    sessionId,
    projectDir,
    filePath,
    cwd,
    title,
    lastPrompt,
    gitBranch,
    permissionMode,
    firstUserMessage,
    messageCount,
    mtime: st.mtime,
    size: st.size,
  };
}

/** ~/.claude/projects 配下の encoded ディレクトリ名一覧。 */
export async function listProjects(): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 1 プロジェクトディレクトリ配下の *.jsonl ファイルのみを列挙する(memory 等のサブディレクトリは除外)。 */
async function collectJsonlFiles(projectDirPath: string): Promise<JsonlFileStat[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectDirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: JsonlFileStat[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDirPath, entry.name);
    try {
      const st = await stat(filePath);
      files.push({ filePath, mtime: st.mtime, size: st.size });
    } catch {
      continue;
    }
  }
  return files;
}

/**
 * project オプションを実ディレクトリに解決する。
 * すでに encoded ディレクトリ名が渡された場合はそのまま、
 * cwd のようなパスが渡された場合は encodeCwd 相当の変換をして解決する。
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

/**
 * 全プロジェクト(または指定 project)の jsonl を stat し、mtime 降順で opts.limit 件だけ
 * メタ抽出(parseSessionMeta)する。
 */
export async function listSessions(opts?: { project?: string; limit?: number }): Promise<SessionMeta[]> {
  const limit = opts?.limit ?? 20;

  let allFiles: JsonlFileStat[] = [];
  if (opts?.project) {
    const dir = await resolveProjectDir(opts.project);
    if (dir) allFiles = await collectJsonlFiles(dir);
  } else {
    const projects = await listProjects();
    const perProject = await Promise.all(
      projects.map((p) => collectJsonlFiles(path.join(projectsDir(), p))),
    );
    allFiles = perProject.flat();
  }

  allFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const limited = allFiles.slice(0, limit);

  const results = await Promise.allSettled(limited.map((f) => parseSessionMeta(f.filePath)));
  const metas: SessionMeta[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') metas.push(r.value);
  }
  return metas;
}

/** sessionId 前方一致で検索する。 */
export async function findSession(idPrefix: string): Promise<SessionMeta | null> {
  const projects = await listProjects();
  for (const p of projects) {
    const dir = path.join(projectsDir(), p);
    const files = await collectJsonlFiles(dir);
    for (const f of files) {
      const sessionId = path.basename(f.filePath, '.jsonl');
      if (sessionId.startsWith(idPrefix)) {
        return parseSessionMeta(f.filePath);
      }
    }
  }
  return null;
}

/** ファイル内の user/assistant テキストから keyword を検索し、最初のヒットの前後スニペットを返す。 */
async function findSnippetInFile(filePath: string, lowerKeyword: string): Promise<string | null> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!lineHasType(line, 'user') && !lineHasType(line, 'assistant')) continue;

    let obj: { message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const text = extractText(obj.message?.content);
    if (!text) continue;

    const idx = text.toLowerCase().indexOf(lowerKeyword);
    if (idx === -1) continue;

    rl.close();

    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + lowerKeyword.length + 80);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = `…${snippet}`;
    if (end < text.length) snippet = `${snippet}…`;
    return snippet;
  }

  rl.close();
  return null;
}

/** user/assistant 行のテキストのみ対象に全セッション横断検索する(大文字小文字無視、1 セッション 1 ヒット)。 */
export async function searchSessions(
  keyword: string,
  opts?: { project?: string },
): Promise<Array<{ meta: SessionMeta; snippet: string }>> {
  const lowerKeyword = keyword.toLowerCase();

  let dirs: string[];
  if (opts?.project) {
    const dir = await resolveProjectDir(opts.project);
    dirs = dir ? [dir] : [];
  } else {
    const projects = await listProjects();
    dirs = projects.map((p) => path.join(projectsDir(), p));
  }

  const results: Array<{ meta: SessionMeta; snippet: string }> = [];

  for (const dir of dirs) {
    const files = await collectJsonlFiles(dir);
    for (const f of files) {
      const snippet = await findSnippetInFile(f.filePath, lowerKeyword);
      if (snippet === null) continue;
      try {
        const meta = await parseSessionMeta(f.filePath);
        results.push({ meta, snippet });
      } catch {
        continue;
      }
    }
  }

  return results;
}
