# Studytter Companion

Windows / Linuxで動くネイティブの教材取込アプリです。PCのローカルLLMでPDF・TXT・Markdownから知識と学習投稿を作り、Android版StudytterへJSONファイルで転送します。Android側の既存データを置き換えるバックアップとは別の形式です。

## 起動

配布アーカイブがある場合、WindowsはZIPを展開して`StudytterCompanion.exe`を起動します。Pythonの導入は不要です。Linuxはtar.gzを展開し、実行権限を付けてバイナリを起動します。

```sh
tar -xzf StudytterCompanion-Linux-x86_64.tar.gz
cd StudytterCompanion-Linux-x86_64
chmod +x StudytterCompanion-Linux-x86_64
./StudytterCompanion-Linux-x86_64
```

配布Linuxバイナリは**Ubuntu 24.04 / x86_64 / glibc 2.39**上で作成しています。同等以上のglibcとGUI環境が必要です。古いLinux・別CPUでは、以下のPythonソース起動またはその環境での再ビルドを使用してください。日本語が四角く表示されるLinuxでは`fonts-noto-cjk`などの日本語フォントを追加してください。

Python 3.11以上が必要です。WindowsはPythonインストーラーのTcl/Tkサポートを有効にします。

```powershell
# Windows / PowerShell（companionフォルダで）
.\start-windows.ps1
```

```sh
# Ubuntu / Debian
sudo apt install python3 python3-venv python3-tk
sh start-linux.sh
```

起動スクリプトはこのフォルダの`.venv`にPDF読取用のpypdfを入れます。一度導入すれば、オフラインでも次のコマンドで直接起動できます。

```powershell
# Windows
.\.venv\Scripts\python.exe app.py
```

```sh
# Linux
.venv/bin/python app.py
```

## ローカルLLMからAndroidへの流れ

1. **Ollama**を起動してモデルを用意するか、**LM Studio**でモデルを読み込み、ローカルサーバーを開始します。モデルのサイズはPCのメモリに合わせてください。
2. Companionでサービスを選択します。Ollamaは`http://127.0.0.1:11434/v1`、LM Studioは`http://127.0.0.1:1234/v1`が初期値です。「モデル一覧」で実際に利用可能なモデルを選びます。ローカルサーバーのAPIキーは通常空欄です。
3. 科目名・言語・教材を指定して「教材を生成」を押します。JSON形式の指示に従えるモデルが必要です。PDFは文字を選択できるものを使用し、スキャンPDFは先にOCRします。
4. 「内容を確認」で知識・出典の引用・クイズと解答を確認します。「Android用JSONを書き出す」で保存します。
5. USBや共有フォルダなどでJSONをAndroidへ転送し、Studytterの学習パッケージ取込から読み込みます。新しい科目として追加されます。同じ完成済みファイルの再取込は重複しません。

OpenAI・NanoGPT・OpenRouter・OpenAI互換APIも選べます。キーは発行元ごとに入力してください。画面にはテキストの送信先を表示します。外部APIを選ぶと教材の抽出テキストがそのAPIへ送られます。GeminiやAnthropicのネイティブAPIはAndroid版の接続設定で利用できますが、このPCアプリはOpenAI互換のChat Completions APIを使用します。

APIキーはメモリ内だけに保持し、設定ファイルや書き出すJSONへ含めません。元のPDF自体はAPIへ送らず、Android用JSONには知識・投稿・引用を含めます。

## 中断・再開と制限

- 教材は4,000文字以下の部分に分け、応答全体を検証してから結果へ追加します。無効なJSON・解答範囲外のクイズ・教材にない引用を含む応答は受け付けません。一度だけ修正を要求します。ローカルサーバーのコンテキストは16K以上を目安に設定してください。
- 通信エラーや停止後は、このウィンドウ内に完了した部分を保持します。接続先やモデルを修正し「残りを再開」を押すと未完了部分から再開します。同じ元ファイル・科目名・言語を維持してください。
- 停止は通信中の応答が返った後に反映されます。通信タイムアウトは90秒です。ウィンドウを閉じると未保存の途中結果は失われます。書き出しは全教材の生成完了後に行います。
- 1ファイル100MB以下、全ファイル合計500MB以下、PDFは2,000ページ以下です。空白ページや画像だけのページでテキストを抽出できない場合、欠落を黙って無視せずエラーにします。必要に応じてそのページを除くかOCRしてください。
- 引用が原文に存在することとJSONの整合性を機械検証します。生成された説明や正解の意味的な正しさは、書き出し前に内容プレビューで確認してください。
- 学習パッケージは25MB・10,000知識・20,000投稿以下です。大きい教材は科目や章で分割してください。

## CLIと検証

```sh
python app.py --headless --input textbook.pdf --input notes.md --subject "物理" --language ja --base-url http://127.0.0.1:11434/v1 --model qwen3:8b --output physics.json
python app.py --validate physics.json
python app.py --smoke-test
python -m unittest discover -s . -p "test_*.py" -v
```

CLIで外部APIを使う場合は`STUDYTTER_API_KEY`環境変数にキーを指定します。コマンド引数や出力JSONにキーは残りません。`--headless`はTkinter不要で動きます。途中結果の再開機能はGUI内のセッションに限ります。

単体テストはローカルHTTPフィクスチャを使用し、実際のAPIキーやLLM・課金リクエストを必要としません。Android側の交換形式は`src/services/learning-package-schema.ts`、小さな互換例は`sample-package.json`です。

接続仕様: [Ollama公式のOpenAI互換API](https://docs.ollama.com/api/openai-compatibility)、[LM Studio公式のOpenAI互換API](https://lmstudio.ai/docs/developer/openai-compat)。

## 実行ファイルの再ビルド

Windows版はWindows、Linux版は対象とするLinux上でビルドします。Pythonに`requirements.txt`とPyInstallerを導入してください。今回の配布物はpypdf 6.14.2 / PyInstaller 6.21.0、Windows Python 3.13、Linux Python 3.12で作成しています。

```powershell
python -m pip install -r requirements.txt pyinstaller==6.21.0
.\build-windows.ps1 -OutputDirectory .\dist
```

```sh
python3 -m pip install -r requirements.txt pyinstaller==6.21.0
PYTHON=python3 sh build-linux.sh ./dist
```

各ビルドスクリプトは実行ファイルとREADME・互換サンプルを含むアーカイブを生成します。中間ファイルは`companion/build`へ配置します。Windows GUI実行ファイルはコンソールを開かないため、`--headless`などの詳細ログが必要な場合はPythonソース版を使用してください。
