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

### 2.1 サイドカー(サブエージェント / ワークフロー)

セッションのトランスクリプトは 1 ファイルで完結しない。実機で確認した構造:

```
projects/<エンコード済cwd>/
  <sessionId>.jsonl                                   ← メイン
  <sessionId>/subagents/agent-<id>.jsonl              ← サブエージェント
  <sessionId>/subagents/workflows/wf_<id>/agent-*.jsonl  ← ワークフローのエージェント
```

実データでの比率(2026-07 時点): メイン 109 セッション 105.4MB に対し、サイドカーが 312 ファイル 57.7MB。**全体の 3 割以上がサイドカー側にある。**

したがって:

- **容量を数えるときは必ずサイドカーを含める**(メインだけだと 3 割以上過小になる)
- **セッションを削除するときは必ずサイドカーディレクトリも消す**。メインだけ消すとサブエージェントの記録が孤児として残り続ける
- **アーカイブするときは必ずサイドカーごと保管する**。メインの jsonl だけではサブエージェントの履歴を復元できない

`core/pins.ts` の `sidecarDir()` / `measureSessionSize()` を使うこと。

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

---

# v0.2 追加機能設計: stats / tail / find

## ファイル所有権(並行実装の契約)

- エージェント D: `src/core/usage.ts`(新規)+ `src/commands/stats.ts`
- エージェント E: `src/commands/tail.ts`
- エージェント F: `src/commands/find.ts` + `src/commands/menu.ts`(find 項目の追加のみ)
- `index.ts` への register 追加とスタブ作成はオーケストレーター(Fable)が実施済み。**担当外のファイル(core/format.ts 等の既存 core 含む)は変更禁止。他人のファイルは読むのは自由**

## データ根拠(実機確認済み)

`assistant` 行に以下が含まれる:

```json
{"type":"assistant","requestId":"req_...","message":{"model":"claude-fable-5","usage":{
  "input_tokens":3988,"cache_creation_input_tokens":3950,"cache_read_input_tokens":18172,
  "output_tokens":301,
  "cache_creation":{"ephemeral_1h_input_tokens":3950,"ephemeral_5m_input_tokens":0}}},
 "timestamp":"2026-07-16T08:29:09.521Z"}
```

**重要: 1 回の API 応答は複数の assistant 行に分割して書かれ、同じ `requestId` と同じ usage を持つ。単純合計すると多重計上になるため、ファイル内で `requestId`(なければ `message.id`)による重複排除が必須**(同一 requestId は最後の行の usage を 1 回だけ計上)。

実データに出現するモデル: `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-opus-4-8`, `sonnet`, `<synthetic>` など。未知モデルはトークン数のみ集計しコストは null。

## 価格表(2026-07 時点、claude-api スキルで確認済み)

`src/core/usage.ts` 内に定義。単位: USD / MTok。

| モデル(前方一致) | input | output | 備考 |
|---|---|---|---|
| claude-fable-5, claude-mythos-5 | 10 | 50 | |
| claude-opus-4-8, -4-7, -4-6, -4-5 | 5 | 25 | |
| claude-opus-4-1, -4-0, claude-opus-4- | 15 | 75 | 旧世代 |
| claude-sonnet-5 | 3 | 15 | **2026-08-31 まで導入価格 input 2 / output 10**(実行日で判定) |
| claude-sonnet-4-6, -4-5, -4-0 | 3 | 15 | |
| claude-haiku-4-5 | 1 | 5 | |

キャッシュ係数(input 単価に対する倍率): 書込 5m = **1.25x**、書込 1h = **2x**、読取 = **0.1x**。
コスト = input×in + output×out + 5m書込×1.25×in + 1h書込×2×in + 読取×0.1×in(全て /1M トークン)。
`cache_creation` オブジェクトがない行は `cache_creation_input_tokens` 全量を 5m 扱い。

## core/usage.ts API

```ts
export interface ModelUsage {
  model: string;
  calls: number;          // 重複排除後の API 呼び出し数
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  costUSD: number | null; // 価格表にないモデルは null
}
export async function aggregateUsage(opts?: {
  project?: string;        // encoded プロジェクト名(listSessions と同じ意味)
  days?: number;           // assistant 行の timestamp が N 日以内のもののみ
}): Promise<ModelUsage[]>;  // costUSD 降順(null は末尾)
```

実装: 全プロジェクトの .jsonl を readline ストリーミング、`"type":"assistant"` を含む行のみ parse。requestId 重複排除はファイル単位の Map でよい(メモリ節約のためファイル毎にクリア)。

## `cctl stats` — モデル別トークン/コスト集計(D)

- テーブル: `MODEL / CALLS / INPUT / OUTPUT / CACHE W / CACHE R / COST`
  - CACHE W は 5m+1h 合算表示。トークンは `1.2M` `345K` 形式(ローカルヘルパー fmtTokens)
  - COST は `$12.34` 形式。null は `-`
  - 最下段に合計行(TOTAL)。区切り線は core/format.ts の table に任せる(header 指定)
- フラグ: `--project, -p <path>`(list と同じ `.` 解決)、`--days, -d <n>`、`--json`
- 末尾に注記: `※ コストは概算です(標準API価格・キャッシュ係数で計算)`
- 非 TTY でも動作(対話なし)

## `cctl tail <idPrefix>` — 会話のライブ表示(E)

- `idPrefix` 指定時は findSession で解決。省略時は getLiveSessions() から clack select で選択(TTY 必須。live 0 件ならエラー)
- 起動時: セッションのタイトルを 1 行表示 → 直近 `--lines, -n <num>`(デフォルト 5)件の user/assistant メッセージを show と同じ描画(👤/🤖 プレフィックス、⚙ ToolName、thinking スキップ、3 行 truncate)
- その後 follow モード: `── フォロー中 (Ctrl-C で終了) ──` を表示し、jsonl への追記を検知して新しい user/assistant 行を逐次描画
  - 実装: 現在のファイルサイズを offset として保持 → `fs.watch(filePath)`(rename イベントや環境差に備え 1 秒間隔の `fs.stat` ポーリングをフォールバックとして併用)→ サイズ増加時に `createReadStream({start: offset})` で追記分だけ読み、**改行で終わらない末尾の不完全行はバッファに保持**して次回に結合
  - `ai-title` 行が来たらタイトル変更を `✦ タイトル: ...` で表示
- Ctrl-C で正常終了(exit 0)

## `cctl find [query]`(エイリアス: `f`)— fzf 風インクリメンタル検索(F)

- `@clack/prompts` の **autocomplete** を使用(実装前に node_modules/@clack/prompts の型定義でシグネチャを必ず確認すること)
- 対象: listSessions({limit: 100})。候補ラベル: `shortId  タイトル ─ dir名 ─ 相対時刻`、hint に lastPrompt。検索対象文字列にはタイトル・lastPrompt・cwd・sessionId を含める(autocomplete のフィルタが label しか見ない場合は、候補生成時に検索用文字列を label に含める工夫ではなく、カスタム filter オプションがあればそれを使う。なければ label ベースで妥協してよい)
- `query` 引数は初期入力として扱えるなら使う(API が対応していなければ無視してよい)
- 選択後のアクション select: `▶ 再開` / `📄 詳細を表示` / `📝 Markdown エクスポート` / `キャンセル`
  - 既存コマンドの run 関数(resume.ts の runResume 等)が import できる形なら再利用。export されていない場合は **他人のファイルを変更せず**、core API(resumeSession / parseSessionMeta 等)で find.ts 内に最小実装
- TTY 必須(非 TTY はエラーで exit 1)
- menu.ts に `🔎 セッションを探す(インクリメンタル検索)` 項目を追加して find の本体関数を呼ぶ(menu.ts の変更はこの 1 項目の追加に留める)

## 共通 UX(v0.1 と同じ)

日本語出力、エラーは赤 `✖` で stderr / exit 1、clack キャンセルは静かに exit 0。

---

# v0.3 追加機能設計: 履歴の永続化(retention / pin)

## 背景(実機・本体バイナリで確認済み)

Claude Code はトランスクリプトを **デフォルト 30 日で自動削除する**。設定キーは `cleanupPeriodDays`(`~/.claude/settings.json`)。本体バイナリ内のエラーメッセージ:

> `cleanupPeriodDays` must be at least 1. To keep transcripts for a long time, set a large number (e.g. 3650 for ~10 years). To disable transcript writes entirely, remove this setting and use the `--no-session-persistence` CLI flag ... (0 is rejected because it previously silently disabled all transcript writes, which users setting it to mean "never clean up" did not expect.)

つまり:

- **`0` は本体に拒否される**。「消さない」の意味で 0 を入れると、かつては書き込み自体が止まって履歴が丸ごと失われた
- 永続化の公式手段は**大きい値を入れること**(本体が例示するのは `3650`)
- 設定ファイルが壊れている / バリデーションエラーがある場合、本体は cleanup を**スキップ**する(安全側)

## 設計方針

本体の「一律 N 日で消す」を実質無効化し、**cctl 側の選択的な整理に置き換える**。

1. `cctl retention --forever` で `cleanupPeriodDays: 3650` を設定 → 本体は消さなくなる
2. 残したいものは `cctl pin` で印を付ける → `cctl clean` の対象外になる
3. pin は同時に **gzip アーカイブ**も取る。本体や他の経路で消えても `cctl restore` で戻せる

pin を「論理マーク」と「物理コピー」の両方を兼ねる単一概念にすることで、`archive` という別コマンドを増やさない。

## 保存先

`~/.claude` を汚さないため、cctl 自身のデータは `$XDG_CONFIG_HOME/cctl`(既定 `~/.config/cctl`)に置く。

```
~/.config/cctl/
  pins.json
  archive/<sessionId>/session.jsonl.gz
  archive/<sessionId>/sidecar/<元の相対パス>.gz
```

アーカイブは 8MB 超の jsonl があるため、**全読み込みせず zlib のストリームで流す**。tar は使わない(依存を増やさないため、1 ファイル 1 gz でディレクトリ構造を保つ)。

## core/settings.ts API

```ts
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const FOREVER_RETENTION_DAYS = 3650;
export function userSettingsFile(): string;
export async function readSettings(file?: string): Promise<SettingsFile>;
export async function getRetentionDays(file?: string): Promise<number | null>;  // 未設定は null
export async function setRetentionDays(days: number, file?: string): Promise<void>;
```

- 既存キーと並び順を保持し、**一時ファイル + rename** で差し替える(書き込み中の中断で設定を壊さない)
- JSON として読めない場合は**推測で上書きせずエラーにする**。壊れた設定は本体の cleanup を止め続けるため、黙って直すと状況を悪化させる

## core/pins.ts API

```ts
export function configDir(): string;
export function sidecarDir(originalPath: string, sessionId: string): string;
export async function loadPins(): Promise<PinEntry[]>;
export async function getPinnedIds(): Promise<Set<string>>;          // clean が使う軽量 API
export async function addPin(meta: SessionMeta, opts?: { archive: boolean }): Promise<PinEntry>;
export async function removePin(sessionId: string, opts?: { purge: boolean }): Promise<PinEntry | null>;
export async function archiveSession(meta: ArchiveSource): Promise<ArchiveInfo>;
export async function restoreArchive(entry: PinEntry, opts?: { force: boolean }): Promise<RestoreResult>;
export async function measureSessionSize(originalPath: string, sessionId: string): Promise<number>;
export async function isArchiveStale(entry: PinEntry): Promise<boolean>;
export async function sourceExists(entry: PinEntry): Promise<boolean>;
```

- `PinEntry` は pin 時点の `title` / `cwd` / `originalPath` を控える。**元ファイルが消えても一覧に出せる**ようにするため
- 再アーカイブ時は既存アーカイブディレクトリを消してから書く(消えたサイドカーが復活しないように)
- stale 判定は**サイドカー込みの合計サイズ**の一致で行う。元ファイルが無い場合は stale ではなく「これが最後の記録」として扱う

## コマンド仕様

### `cctl retention [days]` — 保持期間の表示・設定

- 引数なし: 現在値(未設定なら「30日(未設定 — 本体のデフォルト)」)、設定ファイルパス、セッション数と容量(サイドカー内訳付き)、pin 済み件数を表示。保持期間を超えているセッションがあれば警告
- `days` 指定 or `--forever`(= 3650)で設定
- `--unset` で **`cleanupPeriodDays` のキーごと削除**して未設定に戻す。`30` を明示設定するのとは別物で、本体のデフォルトに追随する状態になる。日数 / `--forever` との併用はエラー。既に未設定なら何もしない(冪等)
- **`0` は自前で弾き、理由(本体が拒否すること・かつて履歴喪失の事故があったこと)を説明する**
- 保持期間を**短縮する場合のみ**確認を挟む(削除範囲が広がるため)。非 TTY では `--yes` を要求してエラー終了。`--unset` も「実効値がデフォルトまで下がる」ため同じ確認を通す
- 表示のみの経路は非 TTY・パイプでも動く

### `cctl pin <idPrefix>` — 永続化

- `clean` の対象外にし、同時に gzip アーカイブを作る
- `--no-archive` で印だけ付ける。再 pin しても既存アーカイブは消さない

### `cctl unpin <idPrefix>` — 解除

- `--purge` でアーカイブ実体も削除。既定では残す

### `cctl pins` — 一覧

- `ID / TITLE / STATE / ARCHIVE / PINNED`。STATE は `同期済み` / `更新あり`(会話が進んだ)/ `元ファイルなし`(本体に消された)
- `--sync` で `更新あり` のアーカイブを最新化。`--json` 対応

### `cctl restore <idPrefix>` — 復元

- pin 時の `originalPath` とサイドカーを展開する。既存ファイルがあれば `--force` なしでは拒否
- 復元後はそのまま `cctl resume` できる

### `cctl clean` の変更

- **pin 済みを削除対象から除外**する(`--include-pinned` で従来どおり対象に含める)。除外件数を表示
- **サイドカーディレクトリも一緒に削除**する(従来はメインの jsonl だけ消しており、サブエージェントの記録が孤児として残っていた)
- 表示する SIZE / 合計サイズもサイドカー込みにする

## 検証の作法(この機能特有)

`~/.claude` を書き換えずに書き込み経路を通すには、**一時 HOME を使う**:

```
HOME=<tmp> XDG_CONFIG_HOME=<tmp>/.config node dist/index.js retention --forever
```

`os.homedir()` は POSIX で `$HOME` を尊重するため、これで実環境に触れずに retention / pin / restore / clean の全経路を検証できる。
