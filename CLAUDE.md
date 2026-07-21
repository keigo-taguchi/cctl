# CLAUDE.md

cctl — Claude Code のセッション管理 CLI(TypeScript ESM / commander / @clack/prompts)。
コマンド仕様・データ形式・価格表の詳細は [DESIGN.md](./DESIGN.md) が正。

## コマンド

- ビルド: `npm run build`(tsc → dist/、postbuild で chmod +x)
- 開発実行: `npm run dev -- <command>`(tsx)
- 型チェック: `npx tsc --noEmit`
- テストスイートはない。検証は実データ(`~/.claude`)でのスモークテストで行う(末尾「検証の作法」参照)

## 絶対に守ること

### データの扱い

- **`~/.claude` 配下を書き換えるテストは禁止**。テスト用の jsonl は一時ディレクトリに作る。削除系(clean)の動作確認は必ず `--dry-run`
- トランスクリプト(.jsonl)は 8MB 超がありうる。**全行 JSON.parse は禁止** — readline ストリーミング + `line.includes('"type":"…"')` の前置フィルタで対象行だけ parse する
- `user` / `assistant` 行は `type` フィールドが行頭に来ない(`parentUuid` 等が先行)ため、`startsWith` 判定は使えない
- **usage 集計は requestId による重複排除が必須**。1 回の API 応答は複数の assistant 行に分割記録され、同じ `requestId`・同じ `usage` を持つ(単純合計すると実測で約 2.1 倍の過大計上)
- **セッションは 1 ファイルで完結しない**。`<sessionId>/subagents/…` にサブエージェント・ワークフローのトランスクリプトが入れ子で置かれ、実データでは全体の 3 割以上を占める。容量集計・削除・アーカイブでは必ずサイドカーを含める(`core/pins.ts` の `sidecarDir()` / `measureSessionSize()`)
- 実行中セッションのレジストリ(`~/.claude/sessions/<pid>.json`)には stale ファイルが残ることがある。必ず `process.kill(pid, 0)` で生存確認(EPERM は alive、ESRCH は dead)
- `cleanupPeriodDays` に **`0` を設定してはいけない**(本体が拒否する。かつては「トランスクリプトを書かない」の意味で、履歴喪失の事故があった)。実質無期限は `3650` のような大きい値で表現する
- resume はセッションの元 cwd で `claude` を spawn する。cwd が消えている場合はエラーにする

### コード規約

- ESM。相対 import には `.js` 拡張子が必須
- テーブル整形は `core/format.ts` の `table()` を使う(string-width による CJK 幅対応)。手書きの `padEnd` は日本語で桁が崩れるため禁止
- コマンドは `export function register(program: Command)` を持ち、本体ロジックは `runXxx()` として export する(menu / find がファイルを跨いで再利用するための規約)
- 依存は追加しない(commander / @clack/prompts / picocolors / string-width で足りる)。必要になったら理由を添えてユーザーに確認

### UX

- 出力は日本語。エラーは `pc.red('✖ …')` を stderr に出し exit 1
- clack の `isCancel` は必ずハンドリングし、静かに exit 0
- 対話 UI は非 TTY のとき「対話モードには TTY が必要です」エラーで exit 1。表示系コマンド(ps/list/stats 等)は非 TTY・パイプでも動くこと

### リリース・公開

- **`npm publish` はユーザーの明示的な指示なしに実行しない**(dry-run は可)
- public リポジトリなので、ドキュメントやコード例に実ユーザー名入りパス・実セッションのタイトルや発言を含めない(架空の例に置き換える)
- 価格表(`src/core/usage.ts`)は変動する。更新時は必ず最新の公式価格を確認してから変更し、コミットメッセージに確認日を書く

## 検証の作法

変更後は最低限:

1. `npm run build` が通ること
2. `node dist/index.js <対象コマンド>` を実データで実行して出力を目視確認(ps / list / stats / search / clean --dry-run は非対話で確認できる)
3. 対話コマンド(resume / menu / find / tail)は非 TTY のエラーパスと `--help` を確認
4. resume の spawn 経路を通す必要があるときは、無害なパススルー(`cctl resume <id> --safe -- --help`)を使う。本物の対話セッションを起動しない
5. `~/.claude` や設定を**書き換える経路(retention / pin / restore / clean)は一時 HOME で検証する**。`os.homedir()` は POSIX で `$HOME` を尊重するため、実環境に一切触れずに全経路を通せる:

   ```
   HOME=<tmp> XDG_CONFIG_HOME=<tmp>/.config node dist/index.js retention --forever
   ```
