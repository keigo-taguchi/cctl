# cctl — Claude Code Session Manager 設計書

Claude Code をラップし、セッションの監視・一覧・再開・検索・整理を行う CLI ツール。

## 技術スタック(確定事項)

- TypeScript / Node.js >= 20、ESM(`"type": "module"`)
- ビルド: `tsc`(dist/ へ出力)。開発時は `tsx`
- 依存(これ以外を追加しないこと):
  - `commander` — サブコマンド定義
  - `@clack/prompts` — 対話 UI(select / confirm / spinner)
  - `picocolors` — 色付け
  - `string-width` — CJK(日本語)幅を考慮したテーブル整形に必須
- devDependencies: `typescript`, `tsx`, `@types/node`
- bin 名: `cctl`(package.json の `bin` フィールド。dist/index.js に shebang `#!/usr/bin/env node`)

## データソース(実機で確認済みの形式)

### 1. 実行中セッションレジストリ: `~/.claude/sessions/<pid>.json`

実行中の Claude Code プロセスごとに 1 ファイル。実例:

```json
{"pid":15651,"sessionId":"c929a837-a92e-44f0-bcfd-f1161903ecc5","cwd":"/Users/you/work/temp","startedAt":1784277209872,"procStart":"Fri Jul 17 08:33:29 2026","version":"2.1.201","peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"temp-0c","nameSource":"derived","status":"busy","updatedAt":1784277522380,"statusUpdatedAt":1784277522380}
```

- `status` は `"busy"` / `"idle"` など
- **注意: プロセス終了後もファイルが残ることがある**。必ず `process.kill(pid, 0)` で生存確認し、死んでいるものは除外(または stale 表示)する
- 追加フィールド(`bridgeSessionId` 等)が存在しうるので、パースは寛容に

### 2. トランスクリプト: `~/.claude/projects/<エンコード済cwd>/<sessionId>.jsonl`

- ディレクトリ名は cwd の `/` と `.` を `-` に置換したもの(例: `/Users/you/work/temp` → `-Users-you-work-temp`)。**逆変換は曖昧なので、cwd の復元にはトランスクリプト内の `cwd` フィールドを使うこと**(`user` / `assistant` 行に含まれる)
- 1 行 1 JSON。主な行タイプ:
  - `{"type":"ai-title","aiTitle":"sample-repo の機能拡張検討","sessionId":"..."}` — AI が付けたセッションタイトル。**複数回出現するので最後のものを採用**
  - `{"type":"last-prompt","lastPrompt":"続きをお願いします","leafUuid":"...","sessionId":"..."}` — 最後のユーザープロンプト。同じく最後のものを採用
  - `{"type":"user","message":{"role":"user","content":"..."},"isMeta":true|false,"timestamp":"2026-07-16T08:29:09.521Z","cwd":"...","sessionId":"...","version":"...","gitBranch":"..."}` — `content` は string または配列。`isMeta: true` や `<local-command-caveat>` で始まるものはユーザー発話として扱わない
  - `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},...]},"timestamp":"..."}`
  - `{"type":"permission-mode","permissionMode":"bypassPermissions",...}` — 最後の値でセッションの権限モードがわかる
  - `{"type":"summary","summary":"...","leafUuid":"..."}` — 圧縮時の要約(存在しない場合あり)
  - 他多数(`file-history-snapshot`, `bridge-session` 等)— 未知タイプは無視
- **ファイルは 8MB を超えることがある。全行 JSON.parse は禁止**。行頭の `{"type":"ai-title"` 等の文字列前方一致で対象行だけ parse する(readline ストリーミング)
- ファイルの mtime = 最終アクティビティ、size も一覧に活用

### 3. 履歴: `~/.claude/history.jsonl`(参考。今回は使わなくてよい)

### 再開コマンド

```
claude --resume <sessionId> [--dangerously-skip-permissions]
```

を **セッションの元 cwd で** `spawn`(`stdio: 'inherit'`)する。cwd が消えている場合はエラーメッセージを出す。子プロセスの exit code をそのまま返す。

## モジュール構成とファイル所有権

```
cctl/
  package.json  tsconfig.json  README.md  DESIGN.md
  src/
    index.ts            — commander セットアップ。各コマンドの register() を呼ぶ
    core/
      paths.ts          — ~/.claude 配下のパス解決
      live.ts           — 実行中セッション取得
      transcripts.ts    — セッション一覧・メタ抽出・全文検索
      resume.ts         — claude --resume の spawn
      format.ts         — テーブル整形(string-width 使用)、相対時刻、サイズ、truncate
    commands/
      ps.ts  list.ts  search.ts  clean.ts        — エージェント B 担当
      resume.ts  menu.ts  show.ts  export.ts     — エージェント C 担当
```

**契約**: エージェント B / C は並行作業するため、**自分の担当ファイル以外(package.json, index.ts, core/*, 相手のコマンドファイル)を絶対に変更しないこと**。npm install も再実行しない。

## コアの型と API(この通りに実装)

```ts
// core/live.ts
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string;          // "busy" | "idle" | その他
  startedAt: number;       // epoch ms
  updatedAt: number;
  version: string;
  alive: boolean;          // process.kill(pid, 0) の結果
}
export async function getLiveSessions(): Promise<LiveSession[]>;  // alive のみ返す。updatedAt 降順

// core/transcripts.ts
export interface SessionMeta {
  sessionId: string;
  projectDir: string;      // ~/.claude/projects/<encoded> の絶対パス
  filePath: string;        // jsonl の絶対パス
  cwd: string | null;      // トランスクリプトから復元した実 cwd
  title: string | null;    // 最後の ai-title
  lastPrompt: string | null;
  gitBranch: string | null;
  permissionMode: string | null;   // 最後の permission-mode
  firstUserMessage: string | null; // isMeta でない最初の user テキスト(title の代替)
  messageCount: number;    // user + assistant の行数(概算で可)
  mtime: Date;
  size: number;            // bytes
}
export async function listProjects(): Promise<string[]>;  // encoded ディレクトリ名一覧
export async function listSessions(opts?: { project?: string; limit?: number }): Promise<SessionMeta[]>;
  // 全プロジェクト(または指定 project)の jsonl を stat し、mtime 降順で opts.limit 件だけ
  // メタ抽出(parseSessionMeta)する。limit 外は stat 情報のみでもよいが、返すのは抽出済みのもの。
export async function parseSessionMeta(filePath: string): Promise<SessionMeta>;  // ストリーミング抽出
export async function findSession(idPrefix: string): Promise<SessionMeta | null>; // sessionId 前方一致で検索
export async function searchSessions(keyword: string, opts?: { project?: string }): Promise<Array<{ meta: SessionMeta; snippet: string }>>;
  // user/assistant 行のテキストのみ対象。大文字小文字無視。1 セッション 1 ヒット(最初のヒットの前後 ~80 文字を snippet に)

// core/resume.ts
export interface ResumeOptions { skipPermissions: boolean; extraArgs?: string[] }
export async function resumeSession(meta: SessionMeta, opts: ResumeOptions): Promise<number>; // exit code

// core/format.ts
export function table(rows: string[][], opts?: { header?: string[] }): string; // string-width で CJK 幅対応の左詰めパディング
export function relTime(date: Date | number): string;   // "3分前" "2時間前" "5日前" 形式(日本語)
export function fmtSize(bytes: number): string;         // "1.2MB"
export function truncate(s: string, width: number): string; // string-width 基準で切って "…"
export function shortId(sessionId: string): string;     // 先頭 8 文字
```

各コマンドファイルは以下をエクスポートする:

```ts
import type { Command } from 'commander';
export function register(program: Command): void;
```

## コマンド仕様

### `cctl ps`(エイリアス: `monitor`)— 実行中セッション一覧

- getLiveSessions() をテーブル表示: `PID / NAME / STATUS / DIR / TITLE / UPDATED`
  - STATUS は busy=黄色、idle=緑で色付け
  - DIR は cwd を `~` 短縮 + truncate。TITLE はライブセッションの sessionId からトランスクリプトを引いて ai-title を表示(見つからなければ `-`)
  - UPDATED は relTime
- `--watch, -w`: 2 秒間隔で画面クリア(`\x1b[2J\x1b[H`)して再描画。Ctrl-C で終了
- 実行中セッションが 0 件なら「実行中のセッションはありません」

### `cctl kill <pid>` — 実行中セッションの停止(ps.ts に同居)

- 該当 pid がレジストリに存在することを確認 → セッション名を表示して `@clack/prompts` の confirm → SIGTERM
- 確認なしフラグ `--force, -f`

### `cctl list`(エイリアス: `ls`)— 復元可能なセッション一覧

- listSessions() をテーブル表示: `ID(short) / TITLE / LAST PROMPT / DIR / MSGS / SIZE / UPDATED`
  - TITLE は `title ?? firstUserMessage ?? "(no title)"` を truncate(幅 ~32)
  - 実行中(live)のセッションには ID の前に緑の `●` を付ける
- `--project, -p <path>`: 指定パス(デフォルトなし=全プロジェクト)のセッションのみ。`.` は cwd に解決してから encoded 名に変換
- `--limit, -n <num>`: デフォルト 20
- `--json`: SessionMeta の配列を JSON 出力(パイプ用)

### `cctl resume [idPrefix]` — セッション再開(目玉機能)

1. `idPrefix` があれば findSession で解決。なければ listSessions(limit 15)から `@clack/prompts` の select で選択
   - 選択肢ラベル: `タイトル ─ dir名 ─ 3時間前`、hint に lastPrompt
   - 実行中のセッションは選択肢から除外(二重 resume 防止)し、除外した旨を表示
2. 権限モードの選択(select):
   - `通常(権限確認あり)`
   - `--dangerously-skip-permissions(確認なし)`
   - デフォルトカーソル位置はそのセッションの前回 permissionMode(bypassPermissions だったら skip 側)
   - `--skip-permissions` / `--safe` フラグ指定時はこの質問を省略
3. `claude --resume <id>` をセッションの cwd で spawn(stdio inherit)。起動前に `cd <cwd> で再開します` を 1 行表示
- cwd が存在しない場合はエラー。`--` 以降の引数は claude にパススルー

### `cctl menu`(引数なしの `cctl` もこれ)— トップメニュー

- clack の select: `📡 実行中セッションを見る` / `▶ セッションを再開` / `🔍 検索` / `🧹 クリーンアップ` / `終了`
- 各項目は対応コマンドの実装関数を呼ぶ(コマンドファイルから run 関数を import してよい。B の run 関数は export しておくこと)

### `cctl search <keyword>` — 全セッション横断検索

- searchSessions() の結果を `ID / TITLE / SNIPPET / UPDATED` で表示。snippet 中のキーワードを黄色ハイライト
- `--project, -p` フィルタ。0 件なら「見つかりませんでした」
- 末尾に `cctl resume <id> で再開できます` のヒントを表示

### `cctl show <idPrefix>` — セッション詳細

- メタ情報(ID, タイトル, cwd, branch, 権限モード, メッセージ数, サイズ, 更新時刻)をラベル付きで表示
- 続けて直近の会話を表示: `--tail, -t <num>`(デフォルト 10)件の user/assistant テキストを `👤` / `🤖` プレフィックスで。tool_use は `⚙ ToolName` の 1 行に要約。長文は 3 行で truncate

### `cctl export <idPrefix>` — Markdown エクスポート

- `--out, -o <file>`(デフォルト: `./<sessionId先頭8>.md`)
- 形式: 冒頭にタイトル・日時・cwd の frontmatter 風ヘッダ → `## 👤 User` / `## 🤖 Assistant` セクションで全会話。tool_use は `> ⚙ ToolName: 入力の1行要約`、thinking はスキップ
- 完了時に出力パスを表示

### `cctl clean` — 古いセッションの整理

- 対象: mtime が `--days <n>`(デフォルト 30)日より古い、または messageCount が 2 以下(`--empty-only` でこちらだけ)
- 対象一覧と合計サイズを表示 → clack confirm → 削除(`fs.rm`)。**実行中セッションの sessionId は絶対に対象外**
- `--dry-run` で削除せず一覧のみ

## UX 原則

- 出力は日本語。エラーは `pc.red('✖ ...')` 形式で stderr へ、exit code 1
- 非 TTY(パイプ)では ps/list は色なし・対話なしで動くこと(`process.stdout.isTTY` 判定。picocolors は自動対応)
- clack のキャンセル(`isCancel`)は必ずハンドリングして静かに exit 0
