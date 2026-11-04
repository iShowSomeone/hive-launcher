#!/usr/bin/env bash
# Installs Hive Launcher for the current user by copying EVERY file (the extension is split into modules,
# so `gnome-extensions pack` needs --extra-source for each one; this script avoids that).
set -euo pipefail
UUID="hive-launcher@ishowsomeone.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

rm -rf "$DEST"
mkdir -p "$DEST/schemas"
cp "$SRC"/{extension.js,hive.js,shapes.js,options.js,glass.js,refraction.js,widgets.js,keynav.js,grouping.js,profile.js,layout.js,dragdrop.js,perf.js,governor.js,tint.js,prefs.js,stylesheet.css,metadata.json} "$DEST/"
cp "$SRC"/schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"

echo "Installed to $DEST"
echo "Log out and back in (Wayland caches modules), then: gnome-extensions enable $UUID"
