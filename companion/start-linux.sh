#!/usr/bin/env sh
set -eu
companion_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -x "$companion_root/.venv/bin/python" ]; then
  python3 -m venv "$companion_root/.venv"
fi
"$companion_root/.venv/bin/python" -m pip install -r "$companion_root/requirements.txt"
exec "$companion_root/.venv/bin/python" "$companion_root/app.py"
