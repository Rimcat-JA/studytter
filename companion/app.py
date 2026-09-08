"""Run the native desktop UI, or use the same validated pipeline from a CLI."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import threading

from core import BuildSession, ClientConfig, LlmClient, export_package, validate_package


def main(argv: list[str] | None = None) -> int:
    # PyInstaller's Windows GUI launcher intentionally has no console streams.
    # Libraries/argparse must still be able to write diagnostics without crashing.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    parser = argparse.ArgumentParser(description="Studytter Companion — prepare learning materials with a local LLM.")
    parser.add_argument("--headless", action="store_true", help="Generate without opening a window")
    parser.add_argument("--smoke-test", action="store_true", help="Open the native UI briefly and exit")
    parser.add_argument("--validate", type=Path, help="Validate an existing learning-package JSON and exit")
    parser.add_argument("--input", type=Path, action="append", default=[], help="PDF/TXT/MD file; repeat for multiple files")
    parser.add_argument("--subject", default="Local study materials")
    parser.add_argument("--language", choices=("ja", "en", "zh-Hans"), default="ja")
    parser.add_argument("--base-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--model", default="qwen3:8b")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.validate:
            validate_package(json.loads(args.validate.read_text(encoding="utf-8-sig")))
            print("Valid Studytter learning package.")
            return 0
        if args.headless:
            if not args.input or not args.output:
                parser.error("--headless requires --input and --output")
            config = ClientConfig(args.base_url, args.model, os.environ.get("STUDYTTER_API_KEY", "")).validate()
            session = BuildSession(args.input, args.subject, args.language, threading.Event())
            package = session.run(LlmClient(config), threading.Event(), lambda done, total, label: print(f"[{done}/{total}] {label}", flush=True))
            export_package(package, args.output)
            print(f"Exported {len(package['posts'])} posts to {args.output.resolve()}")
            return 0
        from gui import App
        app = App()
        if args.smoke_test:
            app.after(1500, app.destroy)
        app.mainloop()
        if args.smoke_test:
            print("UI smoke test passed.")
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
