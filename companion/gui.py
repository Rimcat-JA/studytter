"""Thread-safe Tkinter desktop interface; keys exist only in this process."""
from __future__ import annotations

from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from core import BuildSession, CancelledError, ClientConfig, LlmClient, PRESETS, export_package, is_local_endpoint, normalize_base_url


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Studytter Companion")
        self.geometry("1030x780")
        self.minsize(850, 670)
        self.configure(background="#eef2f7")
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.events: queue.Queue = queue.Queue()
        self.cancel_event = threading.Event()
        self.busy = False
        self.session: BuildSession | None = None
        self.session_signature = None
        self.files: list[Path] = []
        self.preset = tk.StringVar(value="Ollama (local)")
        self.base_url = tk.StringVar(value=PRESETS[self.preset.get()][0])
        self.model = tk.StringVar(value=PRESETS[self.preset.get()][1])
        self.api_key = tk.StringVar()
        self.subject = tk.StringVar(value="新しい学習教材")
        self.language = tk.StringVar(value="ja")
        self.status = tk.StringVar(value="教材と接続先を選び、生成を開始してください。")
        self.destination_note = tk.StringVar()
        self.locked_widgets = []
        self._build()
        self.base_url.trace_add("write", lambda *_: self._destination())
        self._destination()
        self.after(100, self._poll)

    def _build(self):
        style = ttk.Style(self)
        if "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure("TFrame", background="#eef2f7")
        style.configure("TLabel", background="#eef2f7", foreground="#172235", font=("", 10))
        style.configure("Title.TLabel", font=("", 23, "bold"))
        style.configure("Sub.TLabel", foreground="#58677c")
        style.configure("TButton", padding=(10, 7))
        style.configure("Accent.TButton", background="#2366be", foreground="white")
        style.configure("TLabelframe", background="#eef2f7")
        style.configure("TLabelframe.Label", background="#eef2f7", foreground="#2366be", font=("", 11, "bold"))
        wrapper = ttk.Frame(self, padding=22)
        wrapper.pack(fill="both", expand=True)
        ttk.Label(wrapper, text="Studytter Companion", style="Title.TLabel").pack(anchor="w")
        ttk.Label(wrapper, text="PCで教材を問題集に変換し、Androidへファイルで転送", style="Sub.TLabel").pack(anchor="w", pady=(3, 16))

        notebook = ttk.Notebook(wrapper)
        setup_page = ttk.Frame(notebook)
        setup_canvas = tk.Canvas(setup_page, background="#eef2f7", highlightthickness=0)
        setup_scrollbar = ttk.Scrollbar(setup_page, orient="vertical", command=setup_canvas.yview)
        setup_scrollbar.pack(side="right", fill="y")
        setup_canvas.pack(side="left", fill="both", expand=True)
        setup_canvas.configure(yscrollcommand=setup_scrollbar.set)
        setup = ttk.Frame(setup_canvas, padding=16)
        setup_window = setup_canvas.create_window((0, 0), window=setup, anchor="nw")
        setup.bind("<Configure>", lambda _event: setup_canvas.configure(scrollregion=setup_canvas.bbox("all")))
        setup_canvas.bind("<Configure>", lambda event: setup_canvas.itemconfigure(setup_window, width=event.width))
        self.setup_canvas = setup_canvas
        preview = ttk.Frame(notebook, padding=16)
        notebook.add(setup_page, text="  教材と接続  ")
        notebook.add(preview, text="  内容を確認  ")
        self.notebook = notebook

        connection = ttk.LabelFrame(setup, text="1  LLMの接続先", padding=12)
        connection.pack(fill="x")
        connection.columnconfigure(1, weight=1)
        ttk.Label(connection, text="サービス").grid(row=0, column=0, sticky="w", padx=(0, 10), pady=4)
        preset = ttk.Combobox(connection, textvariable=self.preset, values=list(PRESETS), state="readonly")
        preset.grid(row=0, column=1, sticky="ew", pady=4)
        preset.bind("<<ComboboxSelected>>", self._preset_changed)
        self.locked_widgets.append((preset, "readonly"))
        ttk.Label(connection, text="Base URL").grid(row=1, column=0, sticky="w", pady=4)
        self._entry(connection, self.base_url).grid(row=1, column=1, sticky="ew", pady=4)
        ttk.Label(connection, text="モデルID").grid(row=2, column=0, sticky="w", pady=4)
        model = ttk.Combobox(connection, textvariable=self.model)
        model.grid(row=2, column=1, sticky="ew", pady=4)
        self.model_box = model
        self.locked_widgets.append((model, "normal"))
        self.models_button = ttk.Button(connection, text="モデル一覧", command=self.load_models)
        self.models_button.grid(row=2, column=2, padx=(10, 0))
        self.locked_widgets.append((self.models_button, "normal"))
        ttk.Label(connection, text="APIキー").grid(row=3, column=0, sticky="w", pady=4)
        self._entry(connection, self.api_key, show="●").grid(row=3, column=1, sticky="ew", pady=4)
        ttk.Label(connection, text="ローカルは通常空欄。キーは保存されません。", style="Sub.TLabel").grid(row=4, column=1, sticky="w")
        ttk.Label(connection, textvariable=self.destination_note, style="Sub.TLabel", wraplength=760).grid(row=5, column=0, columnspan=3, sticky="w", pady=(8, 0))

        material = ttk.LabelFrame(setup, text="2  教材と出力言語", padding=12)
        material.pack(fill="both", expand=True, pady=(12, 0))
        settings = ttk.Frame(material)
        settings.pack(fill="x")
        ttk.Label(settings, text="科目名").pack(side="left", padx=(0, 8))
        self._entry(settings, self.subject).pack(side="left", fill="x", expand=True)
        ttk.Label(settings, text="言語").pack(side="left", padx=(16, 8))
        language = ttk.Combobox(settings, textvariable=self.language, values=("ja", "en", "zh-Hans"), state="readonly", width=10)
        language.pack(side="left")
        self.locked_widgets.append((language, "readonly"))
        file_row = ttk.Frame(material)
        file_row.pack(fill="both", expand=True, pady=(10, 0))
        self.file_list = tk.Listbox(file_row, height=5, selectmode=tk.EXTENDED, relief="flat", highlightthickness=1, highlightbackground="#cbd5e1", background="white", foreground="#172235")
        self.file_list.pack(side="left", fill="both", expand=True)
        file_buttons = ttk.Frame(file_row)
        file_buttons.pack(side="right", padx=(10, 0), fill="y")
        for label, command in (("教材を追加", self.add_files), ("選択を削除", self.remove_files)):
            button = ttk.Button(file_buttons, text=label, command=command)
            button.pack(fill="x", pady=(0, 5))
            self.locked_widgets.append((button, "normal"))
        ttk.Label(material, text="PDF / TXT / Markdown。PDFは文字が選択できる形式が必要です。スキャンは先にOCRしてください。", style="Sub.TLabel", wraplength=790).pack(anchor="w", pady=(8, 0))

        ttk.Label(preview, text="生成済みの内容と出典を確認できます。", style="Sub.TLabel").pack(anchor="w", pady=(0, 10))
        preview_frame = ttk.Frame(preview)
        preview_frame.pack(fill="both", expand=True)
        scrollbar = ttk.Scrollbar(preview_frame)
        scrollbar.pack(side="right", fill="y")
        self.preview = tk.Text(preview_frame, wrap="word", state="disabled", relief="flat", padx=16, pady=16, background="white", foreground="#172235", yscrollcommand=scrollbar.set, font=("", 11))
        self.preview.pack(fill="both", expand=True)
        scrollbar.configure(command=self.preview.yview)

        # Reserve the footer before expanding the notebook. Packing the
        # notebook first can push the action buttons off-screen on Linux.
        footer = ttk.Frame(wrapper)
        footer.pack(side="bottom", fill="x")
        self.progress = ttk.Progressbar(footer, mode="determinate")
        self.progress.pack(fill="x", pady=(15, 7))
        ttk.Label(footer, textvariable=self.status, wraplength=930).pack(anchor="w")
        buttons = ttk.Frame(footer)
        buttons.pack(fill="x", pady=(12, 0))
        self.start_button = ttk.Button(buttons, text="教材を生成", style="Accent.TButton", command=self.start)
        self.start_button.pack(side="left")
        self.cancel_button = ttk.Button(buttons, text="停止", command=self.cancel, state="disabled")
        self.cancel_button.pack(side="left", padx=8)
        self.export_button = ttk.Button(buttons, text="Android用JSONを書き出す", command=self.export, state="disabled")
        self.export_button.pack(side="right")
        notebook.pack(fill="both", expand=True)

    def _entry(self, parent, variable, **options):
        widget = ttk.Entry(parent, textvariable=variable, **options)
        self.locked_widgets.append((widget, "normal"))
        return widget

    def _destination(self):
        try:
            url = normalize_base_url(self.base_url.get())
            location = "ローカル接続" if is_local_endpoint(url) else "外部API接続"
            self.destination_note.set(f"{location}: 教材から抽出したテキストは {url} へ送信されます。元のPDFは送信しません。")
        except ValueError:
            self.destination_note.set("Base URLにAPIのルートURLを入力してください。")

    def _preset_changed(self, _event=None):
        endpoint, model = PRESETS[self.preset.get()]
        self.base_url.set(endpoint)
        self.model.set(model)
        self.api_key.set("")
        self.model_box.configure(values=())

    def add_files(self):
        for value in filedialog.askopenfilenames(title="教材を選択", filetypes=(("教材", "*.pdf *.txt *.md"), ("PDF", "*.pdf"), ("テキスト", "*.txt *.md"))):
            path = Path(value).resolve()
            if path not in self.files:
                self.files.append(path)
                self.file_list.insert(tk.END, str(path))

    def remove_files(self):
        for index in reversed(self.file_list.curselection()):
            self.file_list.delete(index)
            del self.files[index]

    def _config(self):
        return ClientConfig(normalize_base_url(self.base_url.get()), self.model.get().strip(), self.api_key.get().strip())

    def _set_busy(self, busy):
        self.busy = busy
        for widget, normal in self.locked_widgets:
            widget.configure(state="disabled" if busy else normal)
        self.start_button.configure(state="disabled" if busy else "normal")
        self.cancel_button.configure(state="normal" if busy else "disabled")
        self.export_button.configure(state="normal" if not busy and self.session and self.session.complete else "disabled")

    def load_models(self):
        try:
            config = self._config()
        except ValueError as error:
            messagebox.showerror("接続設定", str(error))
            return
        self._set_busy(True)
        self.cancel_button.configure(state="disabled")
        self.status.set("モデル一覧を読み込んでいます…")
        def worker():
            try:
                self.events.put(("models", LlmClient(config).models()))
            except Exception as error:
                self.events.put(("error", str(error)))
            finally:
                self.events.put(("idle", None))
        threading.Thread(target=worker, daemon=True).start()

    def start(self):
        try:
            config = self._config().validate()
            if not self.files:
                raise ValueError("教材ファイルを追加してください。")
            if not self.subject.get().strip():
                raise ValueError("科目名を入力してください。")
            paths, name, language = list(self.files), self.subject.get().strip(), self.language.get()
            signature = (tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths), name, language)
        except (ValueError, OSError) as error:
            messagebox.showerror("入力内容", str(error))
            return
        resume = self.session if self.session_signature == signature and self.session and not self.session.complete else None
        self.cancel_event = threading.Event()
        cancel = self.cancel_event
        self._set_busy(True)
        self.status.set("教材を読み込んでいます…" if resume is None else "完了済みの部分を保持して再開します…")
        def worker():
            try:
                session = resume or BuildSession(paths, name, language, cancel)
                self.events.put(("session", (session, signature)))
                package = session.run(LlmClient(config), cancel, lambda done, total, label: self.events.put(("progress", (done, total, label))))
                self.events.put(("complete", package))
            except CancelledError as error:
                self.events.put(("stopped", str(error)))
            except Exception as error:
                self.events.put(("error", str(error)))
            finally:
                self.events.put(("idle", None))
        threading.Thread(target=worker, daemon=True).start()

    def cancel(self):
        self.cancel_event.set()
        self.cancel_button.configure(state="disabled")
        self.status.set("停止を要求しました。通信中の応答を待って停止します（通信タイムアウト90秒）。完了済みの内容は保持します。")

    def _show_preview(self):
        if not self.session:
            return
        package = self.session.package
        sections = [f"{package['subject']['displayName']}\n{len(package['atoms'])} 知識 / {len(package['posts'])} 投稿\n"]
        by_atom = {}
        for post in package["posts"]:
            by_atom.setdefault(post["atomId"], []).append(post)
        for index, atom in enumerate(package["atoms"], 1):
            sections.append(f"{index}. {atom['topicLabel']}\n{atom['core']}\n出典: {atom['sourceAnchor']}\n引用: {atom.get('sourceExcerpt', '')}")
            for post in by_atom.get(atom["id"], []):
                sections.append(f"  [{post['format']}] {post['text']}")
                quiz = post.get("quiz")
                if quiz:
                    sections.append(f"  {quiz['question']}")
                    sections.extend(f"    {i + 1}. {option}" for i, option in enumerate(quiz.get("choices", [])))
                    sections.append(f"  解答: {quiz['answerText']}\n  {quiz['explanation']}")
            sections.append("")
        self.preview.configure(state="normal")
        self.preview.delete("1.0", tk.END)
        self.preview.insert(tk.END, "\n".join(sections))
        self.preview.configure(state="disabled")

    def _poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "session":
                    self.session, self.session_signature = value
                    self.export_button.configure(state="disabled")
                elif kind == "progress":
                    done, total, label = value
                    self.progress.configure(maximum=max(1, total), value=done)
                    if not self.cancel_event.is_set():
                        self.status.set(f"{done}/{total}  {label}")
                elif kind == "models":
                    self.model_box.configure(values=value)
                    if self.model.get() not in value:
                        self.model.set(value[0])
                    self.status.set(f"{len(value)}件のモデルを確認しました。生成するモデルを選んでください。")
                elif kind == "complete":
                    self._show_preview()
                    self.notebook.select(1)
                    self.status.set(f"生成完了: {len(value['atoms'])}知識 / {len(value['posts'])}投稿。内容を確認して書き出してください。")
                elif kind in ("error", "stopped"):
                    self._show_preview()
                    self.status.set(value)
                    if kind == "error":
                        messagebox.showerror("処理を完了できませんでした", value + "\n\n完了済みの部分はこのウィンドウ内に保持されています。設定を確認し、再開してください。")
                elif kind == "idle":
                    self._set_busy(False)
                    self.start_button.configure(text="残りを再開" if self.session and not self.session.complete else "教材を生成")
        except queue.Empty:
            pass
        self.after(100, self._poll)

    def export(self):
        if not self.session or not self.session.complete:
            return
        filename = filedialog.asksaveasfilename(title="Androidへ転送する学習パッケージ", defaultextension=".json", initialfile="studytter-learning-package.json", filetypes=(("Studytter学習パッケージ", "*.json"),))
        if not filename:
            return
        try:
            export_package(self.session.package, Path(filename))
            self.status.set(f"保存しました: {filename}")
            messagebox.showinfo("書き出し完了", "JSONファイルをUSB・共有フォルダなどでAndroidへ転送し、Studytterの学習パッケージ取込から開いてください。\n\nAPIキーと接続先、元のPDFは含まれません。")
        except Exception as error:
            messagebox.showerror("書き出し失敗", str(error))

    def close(self):
        if self.busy and not messagebox.askyesno("終了", "処理中です。ウィンドウを閉じると、未保存の生成結果は失われます。終了しますか？"):
            return
        self.cancel_event.set()
        self.api_key.set("")
        self.destroy()
