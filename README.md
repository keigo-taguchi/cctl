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
| `cctl clean` | 古い・空のセッションを整理(`--dry-run` あり) |
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
```

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
