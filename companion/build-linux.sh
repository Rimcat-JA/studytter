#!/usr/bin/env sh
# Build on Linux, using Python 3.11+ with pypdf and pyinstaller installed.
set -eu
companion_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_directory=${1:-"$companion_root/dist"}
python_runtime=${PYTHON:-python3}
mkdir -p "$output_directory" "$companion_root/build/linux"
output_directory=$(CDPATH= cd -- "$output_directory" && pwd)
"$python_runtime" -m PyInstaller --noconfirm --clean --onefile \
  --name StudytterCompanion-Linux-x86_64 \
  --distpath "$output_directory" \
  --workpath "$companion_root/build/linux/work" \
  --specpath "$companion_root/build/linux" \
  "$companion_root/app.py"
archive_directory="$companion_root/build/linux/StudytterCompanion-Linux-x86_64"
mkdir -p "$archive_directory"
cp "$output_directory/StudytterCompanion-Linux-x86_64" "$archive_directory/"
cp "$companion_root/README.md" "$companion_root/sample-package.json" "$archive_directory/"
chmod +x "$archive_directory/StudytterCompanion-Linux-x86_64"
tar -czf "$output_directory/StudytterCompanion-Linux-x86_64.tar.gz" \
  -C "$companion_root/build/linux" StudytterCompanion-Linux-x86_64
printf 'Built Linux executable and archive in %s\n' "$output_directory"
