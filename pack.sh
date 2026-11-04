#!/usr/bin/env bash
# Builds the zip that is uploaded to extensions.gnome.org (only the files the extension needs; no tests, no compiled schema).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
UUID="$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")"
FILES=(extension.js hive.js shapes.js options.js glass.js refraction.js widgets.js keynav.js grouping.js profile.js layout.js dragdrop.js perf.js governor.js tint.js prefs.js stylesheet.css metadata.json schemas/*.gschema.xml)
glib-compile-schemas --strict --dry-run schemas
for f in *.js; do node --check "$f" 2>/dev/null || true; done
OUT="$UUID.shell-extension.zip"
rm -f "$OUT"
zip -q "$OUT" "${FILES[@]}"
echo "built $OUT"
unzip -l "$OUT" | tail -n +4 | head -n -2
