# cctl — Claude Code Session Manager

![CI](https://github.com/keigo-taguchi/cctl/actions/workflows/ci.yml/badge.svg)

Claude Code をラップし、セッションの監視・一覧・再開・検索・整理を行う CLI ツール。

## インストール

```bash
npm install -g @ketaguchi0722/cctl
```

インストール後は `cctl` コマンドとして使える(bin 名は `cctl` のまま)。

### 開発者向け(ソースからビルド)

```bash
npm install
npm run build
npm link   # cctl コマンドをグローバルに使えるようにする
```

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `cctl` / `cctl menu` | 対話式トップメニュー |
| `cctl ps` (`monitor`) | 実行中の Claude Code セッションを一覧(`-w` でライブ監視) |
| `cctl kill <pid>` | 実行中セッションを停止(確認あり。`-f` で即時) |
| `cctl list` (`ls`) | 復元可能なセッションを一覧(`-p <path>` でプロジェクト絞込、`--json` 対応) |
| `cctl resume [id]` | セッションを対話的に選んで再開。権限スキップの有無も選択 |
| `cctl search <keyword>` | 全セッションのトランスクリプトを横断検索 |
| `cctl show <id>` | セッションの詳細と直近の会話を表示 |
| `cctl export <id>` | トランスクリプトを Markdown にエクスポート |
| `cctl clean` | 古い・空のセッションを整理(`--dry-run` あり。pin 済みは除外) |
| `cctl retention [days]` | 履歴の保持期間を表示・設定(`--forever` で実質無期限、`--unset` で既定に戻す) |
| `cctl pin <id>` | セッションを永続化(clean の対象外にし、アーカイブを保管) |
| `cctl unpin <id>` | 永続化を解除(`--purge` でアーカイブも削除) |
| `cctl pins` | 永続化したセッションの一覧(`--sync` でアーカイブ更新) |
| `cctl restore <id>` | アーカイブからセッションを復元 |
| `cctl stats` | モデル別のトークン使用量とコストを集計(`--days` / `--json` 対応) |
| `cctl tail [id]` | セッションの会話を tail -f 風にライブ表示 |
| `cctl find [query]` (`f`) | fzf 風インクリメンタル検索 → 再開/詳細/エクスポート |

## 使用例

```bash
# 実行中セッションをライブ監視(2秒ごと更新)
cctl ps --watch

# 直近のセッションから選んで再開(権限モードも対話選択)
cctl resume

# ID を指定して権限確認なしで即再開
cctl resume 4e1ac4fe --skip-permissions

# 「認証」について話したセッションを探す
cctl search 認証

# 30日以上前のセッションを確認してから削除
cctl clean --dry-run
cctl clean

# 直近7日のモデル別トークン/コスト概算
cctl stats --days 7

# 実行中セッションの会話をライブで眺める
cctl tail

# インクリメンタル検索で見つけて、そのまま再開
cctl f 認証

# 履歴が消える設定になっていないか確認する
cctl retention

# 本体の自動削除を止めて、残すものを自分で選ぶ運用に切り替える
cctl retention --forever
cctl pin 4e1ac4fe          # 残したいセッションに印を付ける(アーカイブも保管)
cctl clean --dry-run       # pin 済みを除いて整理対象を確認
```

### 履歴の保持について

Claude Code はトランスクリプトを **デフォルト 30 日で自動削除** します(設定キー `cleanupPeriodDays`)。
`cctl retention` で現状を確認でき、`--forever` で実質無期限(3650 日)にできます。
元に戻すときは `cctl retention --unset`(設定キーごと削除して未設定に戻す)です。

> `cleanupPeriodDays` に `0` を設定してはいけません。本体に拒否されます
> (かつては「トランスクリプトを書かない」の意味で、履歴が失われる事故がありました)。

保持期間を延ばしたうえで、`cctl pin` で残すものを選び、`cctl clean` で整理する運用を想定しています。
pin したセッションは gzip アーカイブとして `~/.config/cctl/archive/` に保管され、
本体に削除された後でも `cctl restore` で復元できます(サブエージェントの記録も含みます)。

## 仕組み

- 実行中セッション: `~/.claude/sessions/<pid>.json`(Claude Code が管理するレジストリ)を読み、PID の生存確認をして表示
- 復元可能セッション: `~/.claude/projects/*/<sessionId>.jsonl` をストリーミング解析し、AI タイトル・最終プロンプト・権限モードなどを抽出
- 再開: セッションの元ディレクトリで `claude --resume <sessionId>` を起動(選択に応じて `--dangerously-skip-permissions` を付与)

詳細な設計は [DESIGN.md](./DESIGN.md) を参照。

## 開発

```bash
npm run dev -- ps      # tsx で直接実行
npm run build          # dist/ へビルド
```
