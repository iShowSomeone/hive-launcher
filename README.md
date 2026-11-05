# Hive Launcher

A honeycomb app launcher for GNOME Shell. Your apps sit on a honeycomb (or square) lattice under a fisheye lens: drag or scroll to pan, use only the keyboard, or just start typing to search.

<!-- Add 2-3 screenshots here, e.g.:
![Default look](screenshots/default.png)
![Terminal preset](screenshots/terminal.png)
![Blueprint preset](screenshots/blueprint.png)
-->

## Features

- Honeycomb or grid lattice with a fisheye lens, smooth panning, inertia and keyboard navigation (press **F1** inside the launcher for every key)
- Instant search by typing; right-click a tile for windows, favourites, details and hide
- Folders: by category, from your GNOME app folders, or a fully custom layout you arrange by drag and drop (**Edit layout** in the preferences)
- A centre tile that can show a clock, system load, battery or the playing track
- Many tile shapes, themes, accent colours and one-click presets (including *Terminal* and *Blueprint*), with independent look options: icon tint, backdrop patterns, caption font and glow, search bar style
- Optional liquid-glass tiles with refraction
- Adapts its animation quality to the machine's load (Quality tier setting), and prepares itself in the background so it opens instantly

## Requirements

GNOME Shell 45, 46, 47, 48, 49, 50 or 51.

## Installation

### From extensions.gnome.org

*(link will be added once the extension is published)*

### Manually

```sh
git clone https://github.com/iShowSomeone/hive-launcher.git
cd hive-launcher
bash install.sh
```

Then log out and back in (Wayland) or press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, <kbd>Enter</kbd> (X11), and enable it:

```sh
gnome-extensions enable hive-launcher@ishowsomeone.github.io
```

## Usage

Open the launcher with **Super+Shift+A**, the panel icon, or (optionally, see *Replace the app grid* in the preferences) the Show Applications button. Settings are in the extension's preferences: `gnome-extensions prefs hive-launcher@ishowsomeone.github.io`.

## Privacy

No network access and no telemetry. The extension reads your app list and its own settings, and system figures from `/proc` and `/sys` (load, memory and GPU pressure, battery) to choose its animation quality. The optional performance log is off by default and only writes a text file to `~/.cache/hive-launcher`.

## Development

```sh
./dev/run_all.sh      # syntax check, schema/preset validation and all tests (needs node and glib-compile-schemas)
./pack.sh             # builds the zip for extensions.gnome.org
```

The tests run against stubbed GNOME libraries, so they do not replace trying the extension in a real session. Output of the optional performance log (Preferences, General, Performance) is useful in bug reports.

This project was developed with AI assistance (Claude by Anthropic) and is maintained, reviewed and tested by its author.

## Reporting problems

Open an issue and include your GNOME Shell version (`gnome-shell --version`), whether you use Wayland or X11, and relevant lines from `journalctl -f -o cat /usr/bin/gnome-shell | grep hive-launcher`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

Copyright (C) 2026 iShowSomeone
