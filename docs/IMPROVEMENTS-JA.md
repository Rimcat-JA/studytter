# Studytter 1.1 改善内容と使い方

## PCのローカルLLMで教材を用意する

Windows／Linux向けの **Studytter Companion** を追加しました。Ollama・LM StudioなどのOpenAI互換ローカルサーバーに接続し、PDF・TXT・Markdownを知識・解説・クイズへ変換します。

1. OllamaまたはLM Studioで、使用するモデルとローカルAPIサーバーを起動します。
2. Companionでサービスを選び、「モデル一覧」で利用可能なモデルを選びます。ローカル接続では通常APIキーは空欄です。
3. 科目名・教材・言語を指定し、「教材を生成」を押します。
4. 「内容を確認」で出典の引用・解説・解答を確認し、「Android用JSONを書き出す」を押します。
5. JSONをUSBなどでAndroidへコピーします。Android版の **設定 → PCから取り込む** でファイルを選び、内容を確認して科目を追加します。

この連携はファイル受け渡しです。アカウントや同期サーバーは不要です。同じパッケージを再度選んでも重複しません。既存の学習履歴・科目・API設定は保持されます。

元のPDFはAndroidへの転送ファイルに含めません。原文の抜粋・ページ位置・教材名を含め、カードの出典から確認できます。スキャンPDFはPCで事前にOCRしてください。PCアプリの操作・CLI・再開条件は [Companionの説明](../companion/README.md) にまとめています。

## APIの対応

| 環境 | 接続先 |
|---|---|
| Android | NanoGPT、OpenAI、Anthropic、Gemini、OpenRouter、カスタムOpenAI互換API、Ollama（テキスト生成・AI返信） |
| Windows／Linux Companion | Ollama、LM Studio、NanoGPT、OpenAI、OpenRouter、カスタムOpenAI互換Chat Completions API |

Androidは教材抽出・投稿生成・AI返信ごとにプロバイダーとモデルを選択できます。APIキーは発行元に対応する欄へ入力してください。PDF・画像入力に対応するかはモデルによって異なります。

AndroidのキーはSecureStoreに保存し、承認した接続先と関連付けます。PCのキーは実行中のメモリにのみ保持します。PCでクラウドAPIを選ぶと、教材から抽出したテキストを画面に表示された送信先へ送ります。

## 安定性の改善

- フィードのカード再利用時に、別の問題の回答・保存・解答表示を引き継がないようにしました。
- 回答は復習セッション単位で保存し、連打・同時送信・再送で学習回数が増えないようにしました。正当な次回の復習は別の回答として受け付けます。
- 回答記録・SRS・IRT・XPを一つのトランザクションで更新します。保存途中で失敗した場合は全体を元に戻します。
- クイズの正解番号・選択肢・自己採点用の解答を検証し、不正な問題を保存しません。
- バックアップは値の型・参照先・クイズJSONまで検証してから復元します。復元と並行していた古い生成・抽出・AI返信は復元後のデータへ書き込みません。
- バックアップ復元時に、端末のAPIキー・接続先・設定を維持します。元ファイルを含まないバックアップを別端末へ移した場合は、教材の再添付が必要です。
- 非表示の科目・無効な知識を未読数から除外し、選択した科目の補充にも対応しました。
- 古い復習対象を新着投稿とは別枠で取得し、ランキング状態を一括で読み込みます。
- 保存／保存解除を永続化し、保存済み一覧・読込失敗時の再試行・出典画面を追加しました。
- 進捗画面で、回答数・正答数・復習時の正答率を確認できます。

## 検証と実行

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
python -m pip install -r companion/requirements.txt
pnpm test:companion
pnpm exec expo export --platform android
```

テストでは実SQLiteとHTTPテストサーバーを使い、データの重複防止・ロールバック・接続先保護・PCとAndroidの交換形式を確認します。実機固有の通知・バックグラウンド動作や、使用するLLMの品質・速度は利用環境で確認してください。
