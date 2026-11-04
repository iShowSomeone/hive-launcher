#!/usr/bin/env bash
# Everything that can be checked without a GNOME Shell session. Run from the project root: ./dev/run_all.sh
set -euo pipefail
cd "$(dirname "$0")/.."
for f in extension hive shapes options glass refraction widgets keynav grouping profile layout dragdrop perf governor tint prefs; do node --check "$f.js"; done
echo "syntax ok"
bash -n install.sh
glib-compile-schemas --strict schemas
python3 dev/validate_presets.py
for t in keynav grouping profile dragdrop perf governor; do node dev/test_$t.mjs; done
node --import ./dev/register.mjs dev/test_layout.mjs
node --import ./dev/register.mjs dev/test_look.mjs
node --import ./dev/register.mjs dev/smoke.mjs | tail -3
