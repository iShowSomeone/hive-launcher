// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences window for Hive Launcher (this file is what makes the gear icon appear in the Extensions app).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    SHAPES, LAYOUTS, LOGO_STYLES, LABEL_MODES, SORT_MODES, THEMES, TILE_STYLES, HOVER_EFFECTS,
    BORDER_STYLES, BORDER_MODES, RUNNING_STYLES, OPEN_ANIMS, AMBIENT_ANIMS, SEARCH_POSITIONS,
    ICON_TINTS, CENTER_STYLES, LABEL_FONTS, LABEL_CASES, BACKDROP_PATTERNS, SEARCH_STYLES, SEARCH_PROMPTS, PERF_TIERS,
    PRESETS, PRESET_BASE, HOVER_STYLES, CHROME_STYLES, LIGHT_MODES, WIDGETS, FOLDER_MODES, CUSTOM_POLICIES,
} from './options.js';
import {buildProfile, parseProfile, coerceValue, isProfileKey} from './profile.js';

const THEME_LIST = Object.entries(THEMES).map(([id, t]) => [id, t.name]);

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
]);

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Signal connections made by the helpers below; fillPreferencesWindow() points this at its own list so
// everything is disconnected when the window closes.
let CLEANUP = [];

/**
 * A combo row bound to a string key; `list` is [[id, label], …]. The row follows the setting in both
 * directions, so applying a preset (or `gsettings set …`) is reflected immediately.
 */
function comboRow(settings, key, title, subtitle, list) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(list.map(m => m[1]))});
    const indexOf = () => Math.max(0, list.findIndex(m => m[0] === settings.get_string(key)));
    let updating = false;
    row.set_selected(indexOf());
    row.connect('notify::selected', () => {
        if (!updating)
            settings.set_string(key, list[row.selected][0]);
    });
    CLEANUP.push([settings, settings.connect(`changed::${key}`, () => {
        updating = true;
        row.set_selected(indexOf());
        updating = false;
    })]);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step, digits = 2) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({
            lower, upper, step_increment: step, page_increment: step * 4,
            value: settings.get_double(key),
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A spin row bound to an integer key. */
function intRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title, subtitle, digits: 0,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 4, value: settings.get_int(key)}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

const EDIT_KEYS = ['edit-wobble', 'edit-wobble-speed', 'edit-dwell-ms', 'edit-long-press-ms', 'edit-lift-distance', 'edit-hit-radius',
    'edit-autopan', 'edit-lift-scale', 'edit-lift-opacity', 'edit-free-rings', 'edit-keep-empty', 'edit-ask-name'];

const PRESET_LIST = Object.entries(PRESETS);

/**
 * A throw-away Gio.Settings for batching writes. NEVER call delay() on the long-lived settings object:
 * delay() switches an object into delay-apply mode for good (apply() does not leave it), after which
 * every later change stays local to the window and never reaches dconf — so the Hive would see
 * nothing. That was the bug where the UI followed a preset but the Hive did not.
 */
function batch(settings, fn) {
    const tmp = new Gio.Settings({settings_schema: settings.settings_schema, path: settings.path});
    tmp.delay();
    try {
        fn(tmp);
    } finally {
        tmp.apply();
    }
}

/** Write every appearance key of a preset in one batch (one change notification, no refresh storm). */
function applyPreset(settings, id) {
    const preset = PRESETS[id];
    if (!preset)
        return;
    batch(settings, tmp => {
        for (const [key, value] of Object.entries({...PRESET_BASE, ...preset.values})) {
            if (typeof value === 'boolean')
                tmp.set_boolean(key, value);
            else if (typeof value === 'number')
                tmp.set_double(key, value);
            else
                tmp.set_string(key, value);
        }
    });
}

/** How many of a preset's keys differ from the current settings. */
function presetDistance(settings, preset) {
    let diff = 0;
    for (const [key, v] of Object.entries({...PRESET_BASE, ...preset.values})) {
        let same;
        if (typeof v === 'boolean')
            same = settings.get_boolean(key) === v;
        else if (typeof v === 'number')
            same = Math.abs(settings.get_double(key) - v) < 1e-6;
        else
            same = settings.get_string(key) === v;
        if (!same)
            diff++;
    }
    return diff;
}

/**
 * The preset the current look is based on: {id, name, diff}. diff = 0 means an exact match; a few differing keys means "modified";
 * a look that is far from every preset is reported as null (Custom).
 */
function currentPreset(settings) {
    let best = null;
    for (const [id, preset] of PRESET_LIST) {
        const diff = presetDistance(settings, preset);
        if (!best || diff < best.diff)
            best = {id, name: preset.name, diff};
    }
    return best && best.diff <= 14 ? best : null;
}

function currentPresetName(settings) {
    const p = currentPreset(settings);
    if (!p)
        return null;
    return p.diff === 0 ? p.name : `${p.name} (modified)`;
}

const rgb255ToHex = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;

const toHex = c => `#${[c.red, c.green, c.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * A colour row: colour button + reset button. An empty string in `key` means "use the default", which is
 * whatever `fallback()` returns (so the button always shows the colour that is actually in effect).
 */
function colorRow(settings, key, title, subtitle, fallback, signals) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.ColorDialogButton({valign: Gtk.Align.CENTER, dialog: new Gtk.ColorDialog({with_alpha: false})});
    const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Use the default colour'});
    reset.add_css_class('flat');
    row.add_suffix(reset);
    row.add_suffix(button);

    let updating = false;
    const sync = () => {
        const hex = settings.get_string(key);
        const rgba = new Gdk.RGBA();
        updating = true;
        rgba.parse(hex || fallback());
        button.set_rgba(rgba);
        updating = false;
        reset.set_sensitive(!!hex);
    };
    sync();
    button.connect('notify::rgba', () => {
        if (!updating)
            settings.set_string(key, toHex(button.get_rgba()));
    });
    reset.connect('clicked', () => settings.set_string(key, ''));
    signals.push([settings, settings.connect(`changed::${key}`, sync)]);
    signals.push([settings, settings.connect('changed::theme', sync)]);
    return row;
}

/** A row with a button that records the next key combination the user presses. */
function shortcutRow(window, settings, signals) {
    const row = new Adw.ActionRow({
        title: 'Toggle shortcut',
        subtitle: 'Click, then press the new combination. Backspace disables it, Esc cancels.',
    });
    const button = new Gtk.Button({valign: Gtk.Align.CENTER, width_request: 160});
    row.add_suffix(button);
    row.set_activatable_widget(button);

    let capturing = false;
    const refresh = () => {
        if (capturing) {
            button.set_label('Press keys…');
            return;
        }
        const [accel] = settings.get_strv('toggle-hive');
        if (!accel) {
            button.set_label('Disabled');
            return;
        }
        const [ok, key, mods] = Gtk.accelerator_parse(accel);
        button.set_label(ok ? Gtk.accelerator_get_label(key, mods) : accel);
    };
    refresh();

    button.connect('clicked', () => {
        capturing = true;
        refresh();
    });

    const keys = new Gtk.EventControllerKey();
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
        if (!capturing)
            return Gdk.EVENT_PROPAGATE;
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (!mods && keyval === Gdk.KEY_Escape) {
            capturing = false;
        } else if (!mods && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv('toggle-hive', []);
            capturing = false;
        } else if (MODIFIER_KEYS.has(keyval) || !mods || !Gtk.accelerator_valid(keyval, mods)) {
            return Gdk.EVENT_STOP; // keep waiting for a real combination (a modifier is required)
        } else {
            settings.set_strv('toggle-hive', [Gtk.accelerator_name(keyval, mods)]);
            capturing = false;
        }
        refresh();
        return Gdk.EVENT_STOP;
    });
    window.add_controller(keys);

    signals.push([settings, settings.connect('changed::toggle-hive', refresh)]);
    return row;
}

const KEYBOARD_HELP = [
    ['Arrow keys', 'Move to the neighbouring tile; the Hive pans to keep it in the centre'],
    ['Ctrl or Shift + arrows', 'Leap four tiles at once'],
    ['Page Up / Page Down', 'Leap six tiles up or down'],
    ['Home / End', 'Jump to the first / last tile'],
    ['Tab / Shift+Tab', 'Next / previous tile, in the order the apps are sorted'],
    ['Enter', 'Open the highlighted app, or step into a folder'],
    ['Shift+Enter', 'Open the app in a new window'],
    ['Ctrl+Enter or Menu key', 'Open the app menu (arrows and Enter work inside it)'],
    ['Alt+Enter', 'Show the app in GNOME Software'],
    ['Backspace or Esc', 'Leave a folder (Esc clears the search field first, then closes the Hive)'],
    ['F2 / Shift+F2', 'Switch the centre-tile widget forwards / backwards'],
    ['F3 / Shift+F3', 'Switch folders: off, by category, my GNOME app folders, my custom layout'],
    ['F4', 'Edit the layout: rearrange tiles and make folders (the Hive switches to “My custom layout”); F4 or Esc to finish'],
    ['Space (while editing)', 'Pick up the highlighted tile; arrows move the cursor, Enter swaps, Shift+Enter makes a folder, Esc cancels'],
    ['Backspace (carrying, in a folder)', 'Take the carried app out of the folder'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo a layout change (custom layout)'],
    ['Ctrl+R / Delete', 'Rename / delete the highlighted custom folder (Delete asks first)'],
    ['F1', 'Show or hide this list inside the Hive'],
    ['Any letter', 'Starts a search; Up / Down then move through the results, Left / Right edit the text'],
];

const isDismissed = e => !!(e?.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
    e?.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED));

/** Apply imported values in one batch. Unknown keys, wrong types and out-of-range values are skipped. */
function applyProfile(settings, values, includePersonal) {
    const schema = settings.settings_schema;
    let applied = 0;
    const skipped = [];
    batch(settings, tmp => {
        for (const [key, raw] of Object.entries(values)) {
            if (!schema.has_key(key) || !isProfileKey(key, includePersonal)) {
                skipped.push(key);
                continue;
            }
            const sk = schema.get_key(key);
            const type = sk.get_value_type().dup_string();
            const c = coerceValue(type, raw);
            if (!c.ok) {
                skipped.push(key);
                continue;
            }
            const v = new GLib.Variant(type, c.value);
            if (!sk.range_check(v)) {
                skipped.push(key);
                continue;
            }
            tmp.set_value(key, v);
            applied++;
        }
    });
    return {applied, skipped};
}

function profileGroup(window, settings, version) {
    const group = new Adw.PreferencesGroup({
        title: 'Profile',
        description: 'Save every setting to a JSON file to back up your look or share it, or load a profile you saved earlier.',
    });
    const personalRow = new Adw.SwitchRow({
        title: 'Include hidden apps and recent history',
        subtitle: 'Off: only look and behaviour settings are saved and loaded',
    });
    group.add(personalRow);

    const toast = title => window.add_toast(new Adw.Toast({title, timeout: 4}));
    const jsonDialog = title => {
        const dialog = new Gtk.FileDialog({title, initial_name: 'hive-launcher-profile.json'});
        const filter = new Gtk.FileFilter({name: 'Hive Launcher profile (JSON)'});
        filter.add_pattern('*.json');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        dialog.set_filters(filters);
        return dialog;
    };

    const row = new Adw.ActionRow({title: 'Export or import', subtitle: 'Importing replaces your current settings'});
    const exportBtn = new Gtk.Button({label: 'Export…', valign: Gtk.Align.CENTER});
    const importBtn = new Gtk.Button({label: 'Import…', valign: Gtk.Align.CENTER});
    row.add_suffix(exportBtn);
    row.add_suffix(importBtn);
    group.add(row);

    exportBtn.connect('clicked', () => {
        jsonDialog('Export profile').save(window, null, (dialog, res) => {
            try {
                const file = dialog.save_finish(res);
                const values = {};
                for (const key of settings.settings_schema.list_keys()) {
                    if (isProfileKey(key, personalRow.active))
                        values[key] = settings.get_value(key).recursiveUnpack();
                }
                const bytes = new TextEncoder().encode(buildProfile(values, version));
                file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                toast(`Saved ${Object.keys(values).length} settings to ${file.get_basename()}`);
            } catch (e) {
                if (!isDismissed(e))
                    toast(`Could not save the profile: ${e.message}`);
            }
        });
    });

    importBtn.connect('clicked', () => {
        jsonDialog('Import profile').open(window, null, (dialog, res) => {
            try {
                const file = dialog.open_finish(res);
                const [, contents] = file.load_contents(null);
                const profile = parseProfile(new TextDecoder().decode(contents));
                const {applied, skipped} = applyProfile(settings, profile.settings, personalRow.active);
                toast(skipped.length > 0
                    ? `Imported ${applied} settings (${skipped.length} skipped)`
                    : `Imported ${applied} settings`);
            } catch (e) {
                if (!isDismissed(e))
                    toast(`Could not import the profile: ${e.message}`);
            }
        });
    });
    return group;
}

export default class HivePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signals = [];
        CLEANUP = signals;
        window._hiveSettings = settings; // keep alive for the lifetime of the window
        window.set_default_size(680, 820);

        // ---------------------------------------------------------------- General
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const launch = new Adw.PreferencesGroup({title: 'Launching'});
        launch.add(shortcutRow(window, settings, signals));
        launch.add(switchRow(settings, 'show-panel-icon', 'Panel button', 'Show a launcher button in the top bar'));
        general.add(launch);

        const folders = new Adw.PreferencesGroup({
            title: 'Folders',
            description: 'Gather apps into folder tiles on the lattice. Open a folder with a click or Enter; leave it with the ' +
                'centre tile, Backspace or Esc. Search always finds every app. You can also switch inside the Hive with F3, ' +
                'or from the centre tile’s right-click menu.',
        });
        folders.add(comboRow(settings, 'group-mode', 'Group apps into folders',
            'By category: Development, Games, Internet, Office… (a category needs at least two apps). ' +
            'My GNOME app folders: the folders you made in GNOME’s app grid. ' +
            'My custom layout: your own folders and positions, edited inside the Hive (drag tiles, or press F4)', FOLDER_MODES));
        folders.add(comboRow(settings, 'custom-policy', 'Custom layout: arrangement',
            'Packed keeps the lattice free of gaps (a tile that leaves is replaced by the last one). ' +
            'Free lets you leave gaps and drop tiles on any empty slot; “Tidy up” in the centre tile’s menu closes them again', CUSTOM_POLICIES));
        const editRow = new Adw.ActionRow({
            title: 'Edit layout…',
            subtitle: 'Opens the Hive in editing mode: drag tiles to swap them, hold or Shift+drop one on another to make a folder, right-click for more. Esc or Done when finished',
        });
        const editBtn = new Gtk.Button({label: 'Edit…', valign: Gtk.Align.CENTER});
        editBtn.add_css_class('suggested-action');
        editBtn.connect('clicked', () => {
            if (settings.get_string('group-mode') !== 'custom')
                settings.set_string('group-mode', 'custom');
            settings.set_uint('edit-request', (settings.get_uint('edit-request') + 1) % 1000000);
        });
        editRow.add_suffix(editBtn);
        folders.add(editRow);
        const resetLayout = new Adw.ActionRow({
            title: 'Reset custom layout',
            subtitle: 'Forget your custom arrangement and folders. The next time you choose “My custom layout” it starts from what you see then',
        });
        const resetLayoutBtn = new Gtk.Button({label: 'Reset…', valign: Gtk.Align.CENTER});
        resetLayoutBtn.add_css_class('destructive-action');
        resetLayoutBtn.connect('clicked', () => {
            const dlg = new Adw.MessageDialog({
                transient_for: window, modal: true, heading: 'Reset custom layout?',
                body: 'Your folders and the positions you chose will be deleted. This cannot be undone.',
            });
            dlg.add_response('cancel', 'Cancel');
            dlg.add_response('reset', 'Reset');
            dlg.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.connect('response', (_d, id) => {
                if (id === 'reset')
                    settings.set_string('custom-layout', '');
            });
            dlg.present();
        });
        resetLayout.add_suffix(resetLayoutBtn);
        folders.add(resetLayout);
        general.add(folders);

        // ---- layout editing: every tunable of the Edit Hive mode
        const editing = new Adw.PreferencesGroup({
            title: 'Layout editing',
            description: 'How editing the custom layout feels (F4, or Edit layout… above). Changes apply the next time the Hive opens or immediately while it is open.',
        });
        editing.add(spinRow(settings, 'edit-wobble', 'Wobble intensity', 'How far tiles wobble while editing, in degrees. 0 turns the wobble off (it also needs animations on)', 0, 3, 0.1, 1));
        editing.add(spinRow(settings, 'edit-wobble-speed', 'Wobble speed', '1 is the normal speed', 0.4, 2.5, 0.1, 1));
        editing.add(intRow(settings, 'edit-dwell-ms', 'Hold time to make a folder (ms)', 'Hover a dragged app over another app this long to make a folder (Shift+drop does it at once)', 150, 1500, 50));
        editing.add(intRow(settings, 'edit-long-press-ms', 'Touch: hold time to lift a tile (ms)', 'How long a finger must rest on a tile before it can be dragged', 150, 1200, 50));
        editing.add(spinRow(settings, 'edit-lift-distance', 'Lift distance (px)', 'How far the pointer must move on a tile before it is lifted. Larger = fewer accidental drags', 2, 30, 1, 0));
        editing.add(spinRow(settings, 'edit-hit-radius', 'Drop target size', 'Fraction of a tile that counts as “on” it. Smaller is more precise, larger is more forgiving', 0.3, 1, 0.05, 2));
        editing.add(spinRow(settings, 'edit-autopan', 'Auto-pan speed', 'How fast the Hive scrolls when you drag a tile near the screen edge. 0 turns it off', 0, 3, 0.1, 1));
        editing.add(spinRow(settings, 'edit-lift-scale', 'Lifted tile size', 'How much larger a tile is drawn while you drag it', 1, 1.5, 0.02, 2));
        editing.add(spinRow(settings, 'edit-lift-opacity', 'Lifted tile opacity', 'Lower values make the dragged tile more see-through', 0.3, 1, 0.02, 2));
        editing.add(intRow(settings, 'edit-free-rings', 'Free arrangement: extra rings', 'Rings of empty slots shown around the outermost tile while editing in the Free arrangement', 0, 4, 1));
        editing.add(switchRow(settings, 'edit-keep-empty', 'Keep empty tiles after editing', 'Normally the empty tiles only show while editing. When on (and Show empty tiles is on) a small flower of them stays around your tiles'));
        editing.add(switchRow(settings, 'edit-ask-name', 'Ask for a folder name', 'When a drop makes a new folder, ask for its name straight away'));
        const editReset = new Adw.ActionRow({title: 'Restore the editing defaults', subtitle: 'Resets only the options in this group'});
        const editResetBtn = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER});
        editResetBtn.connect('clicked', () => EDIT_KEYS.forEach(k => settings.reset(k)));
        editReset.add_suffix(editResetBtn);
        editing.add(editReset);
        general.add(editing);

        // ---- performance log
        const perfDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'hive-launcher']);
        const perfPath = GLib.build_filenamev([perfDir, 'perf.log']);
        const perf = new Adw.PreferencesGroup({
            title: 'Performance log',
            description: 'For finding out what to optimise. While on, every time the Hive closes a short report (frame times, how long opening and rebuilding take, ' +
                'painting cost, memory and CPU of the shell) is appended to the log file below. Nothing leaves your computer; send the file when reporting slowness.',
        });
        perf.add(comboRow(settings, 'perf-tier', 'Quality tier',
            'Automatic lowers animations, refraction and blur while the machine is busy (CPU, disk, memory or GPU pressure) so the Hive still opens instantly. Your settings are never changed', PERF_TIERS));
        perf.add(switchRow(settings, 'prewarm-scene', 'Prepare the Hive in the background',
            'Builds it after login and whenever apps or settings change, so opening is instant. Uses a little memory while the Hive is closed'));
        perf.add(switchRow(settings, 'perf-log', 'Record a performance log', 'Adds a little overhead while the Hive is open, so leave it off normally'));
        const perfRow = new Adw.ActionRow({title: 'Log file', subtitle: perfPath, subtitle_selectable: true});
        const perfOpen = new Gtk.Button({label: 'Open folder', valign: Gtk.Align.CENTER});
        perfOpen.connect('clicked', () => {
            try {
                GLib.mkdir_with_parents(perfDir, 0o755);
                Gio.AppInfo.launch_default_for_uri(`file://${perfDir}`, null);
            } catch (e) {
                console.error(`hive-launcher: could not open ${perfDir}: ${e}`);
            }
        });
        const perfClear = new Gtk.Button({label: 'Clear', valign: Gtk.Align.CENTER});
        perfClear.connect('clicked', () => {
            try {
                GLib.mkdir_with_parents(perfDir, 0o755);
                GLib.file_set_contents(perfPath, '');
            } catch (e) {
                console.error(`hive-launcher: could not clear ${perfPath}: ${e}`);
            }
        });
        perfRow.add_suffix(perfOpen);
        perfRow.add_suffix(perfClear);
        perf.add(perfRow);
        general.add(perf);

        const behave = new Adw.PreferencesGroup({title: 'Behaviour'});
        behave.add(comboRow(settings, 'sort-mode', 'Order', 'Apps earlier in the list sit closer to the centre', SORT_MODES));
        behave.add(switchRow(settings, 'snap', 'Snap to tile', 'After panning, glide so the nearest app sits in the centre'));
        behave.add(switchRow(settings, 'show-running', 'Highlight running apps', 'Running apps get a brighter outline and a glow'));
        behave.add(spinRow(settings, 'inertia', 'Glide after dragging', '0 stops dead, higher values keep gliding further', 0, 2, 0.1, 1));
        behave.add(spinRow(settings, 'scroll-speed', 'Scroll speed', null, 0.3, 3, 0.1, 1));
        behave.add(switchRow(settings, 'middle-click-new-window', 'Middle-click opens a new window', null));
        const recentRow = new Adw.ActionRow({
            title: 'Recently opened history',
            subtitle: 'Used by the “Recently opened” order. Anything you start, from the Hive or elsewhere, is remembered',
        });
        const forgetBtn = new Gtk.Button({label: 'Forget', valign: Gtk.Align.CENTER});
        forgetBtn.connect('clicked', () => settings.set_strv('recent-apps', []));
        recentRow.add_suffix(forgetBtn);
        behave.add(recentRow);
        general.add(behave);

        const centre = new Adw.PreferencesGroup({
            title: 'Centre tile',
            description: 'The middle tile can show a widget. Right-click it in the Hive to switch quickly; click it to open the related app (or pause/play for Now playing).',
        });
        centre.add(comboRow(settings, 'center-widget', 'Widget', null, WIDGETS));
        centre.add(switchRow(settings, 'clock-24h', '24-hour clock', null));
        general.add(centre);

        const menu = new Adw.PreferencesGroup({title: 'App menu'});
        menu.add(switchRow(settings, 'replace-app-grid', 'Use the Hive as the application menu',
            'The dock’s Show Applications button and Super+A open the Hive instead of GNOME’s app grid'));
        general.add(menu);

        const lens = new Adw.PreferencesGroup({title: 'Fisheye lens'});
        lens.add(spinRow(settings, 'zoom', 'Lens radius', 'Larger = flatter lens, more tiles at full size', 0.5, 1.8, 0.05));
        lens.add(spinRow(settings, 'min-scale', 'Rim size', 'Relative size of the smallest tiles. 1.00 turns the fisheye off', 0.12, 1.0, 0.02));
        general.add(lens);

        general.add(profileGroup(window, settings, this.metadata?.['version-name'] ?? ''));

        const reset = new Adw.PreferencesGroup({title: 'Reset'});
        const resetRow = new Adw.ActionRow({
            title: 'Restore default look and behaviour',
            subtitle: 'Keeps your shortcut, panel button, hidden apps and recent history',
        });
        const resetBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        resetBtn.add_css_class('destructive-action');
        resetBtn.connect('clicked', () => {
            const keep = new Set(['toggle-hive', 'show-panel-icon', 'hidden-apps', 'recent-apps', 'preview-request', 'edit-request', 'custom-layout', 'perf-log', 'perf-tier', 'prewarm-scene']);
            batch(settings, tmp => {
                for (const key of tmp.settings_schema.list_keys()) {
                    if (!keep.has(key))
                        tmp.reset(key);
                }
            });
        });
        resetRow.add_suffix(resetBtn);
        reset.add(resetRow);
        general.add(reset);
        window.add(general);

        // ---------------------------------------------------------------- Appearance
        const look = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

        const previewGroup = new Adw.PreferencesGroup();
        const previewRow = new Adw.ActionRow({
            title: 'Preview the Hive',
            subtitle: 'Opens the launcher with the current settings. Press Esc to come back here.',
        });
        const previewBtn = new Gtk.Button({label: 'Preview', valign: Gtk.Align.CENTER});
        previewBtn.add_css_class('suggested-action');
        previewBtn.connect('clicked', () =>
            settings.set_uint('preview-request', (settings.get_uint('preview-request') + 1) % 1000000));
        previewRow.add_suffix(previewBtn);
        previewGroup.add(previewRow);
        look.add(previewGroup);

        const presetGroup = new Adw.PreferencesGroup({
            title: 'Presets',
            description: 'A preset sets the whole look in one go. You can keep tweaking everything below afterwards.',
        });
        const presetRow = new Adw.ComboRow({
            title: 'Apply a preset',
            model: Gtk.StringList.new(['Choose a preset…', ...PRESET_LIST.map(([, p]) => p.name)]),
        });
        let applying = false;
        presetRow.connect('notify::selected', () => {
            if (applying || presetRow.selected === 0)
                return;
            const [id] = PRESET_LIST[presetRow.selected - 1];
            applying = true;
            applyPreset(settings, id);
            presetRow.set_selected(0); // it is an action, not a stored value
            applying = false;
        });
        const refreshPresetInfo = () => presetRow.set_subtitle(`Current look: ${currentPresetName(settings) ?? 'Custom'}`);
        refreshPresetInfo();
        signals.push([settings, settings.connect('changed', refreshPresetInfo)]);
        presetGroup.add(presetRow);
        const revertRow = new Adw.ActionRow({
            title: 'Revert to the preset',
            subtitle: 'Sets every look option back to the preset this look is based on, including the details you changed',
        });
        const revertBtn = new Gtk.Button({label: 'Revert', valign: Gtk.Align.CENTER});
        revertBtn.connect('clicked', () => {
            const p = currentPreset(settings);
            if (p)
                applyPreset(settings, p.id);
        });
        revertRow.add_suffix(revertBtn);
        const syncRevert = () => {
            const p = currentPreset(settings);
            revertRow.set_sensitive(!!p && p.diff > 0);
            revertRow.set_title(p ? `Revert to “${p.name}”` : 'Revert to the preset');
        };
        syncRevert();
        signals.push([settings, settings.connect('changed', syncRevert)]);
        presetGroup.add(revertRow);
        look.add(presetGroup);

        const colours = new Adw.PreferencesGroup({title: 'Colours'});
        colours.add(comboRow(settings, 'theme', 'Theme', null, THEME_LIST));
        colours.add(switchRow(settings, 'use-system-accent', 'Use the system accent colour', 'Follows GNOME’s accent colour (GNOME 47+)'));
        const themeOf = () => THEMES[settings.get_string('theme')] ?? THEMES.tokyo;
        colours.add(colorRow(settings, 'accent-color', 'Custom accent colour',
            'Overrides the theme’s accent. Reset to use the theme colour.', () => themeOf().accent, signals));
        look.add(colours);

        const tiles = new Adw.PreferencesGroup({title: 'Tiles'});
        tiles.add(comboRow(settings, 'shape', 'Shape', null, SHAPES));
        tiles.add(comboRow(settings, 'layout', 'Layout', 'Honeycomb packs tiles tightly; the grid suits squares and circles', LAYOUTS));
        tiles.add(spinRow(settings, 'tile-size', 'Tile size', null, 0.6, 1.5, 0.05));
        tiles.add(spinRow(settings, 'tile-gap', 'Gap', 'Space between tiles in pixels', 0, 20, 1, 0));
        tiles.add(spinRow(settings, 'icon-scale', 'Icon size', null, 0.6, 1.5, 0.05));
        tiles.add(comboRow(settings, 'labels', 'App names', null, LABEL_MODES));
        tiles.add(spinRow(settings, 'label-size', 'App name size', null, 0.7, 1.6, 0.05));
        tiles.add(comboRow(settings, 'logo-style', 'Centre tile', 'What the middle tile shows', LOGO_STYLES));
        tiles.add(switchRow(settings, 'show-empty', 'Decorative empty tiles', 'Draw faint tiles around the apps'));
        look.add(tiles);

        const bgTile = new Adw.PreferencesGroup({title: 'Tile background'});
        bgTile.add(comboRow(settings, 'tile-style', 'Style', null, TILE_STYLES));
        bgTile.add(spinRow(settings, 'tile-opacity', 'Opacity', null, 0.05, 1.0, 0.05));
        bgTile.add(colorRow(settings, 'tile-color', 'Colour', 'Defaults to the theme’s surface colour',
            () => themeOf().surface, signals));
        bgTile.add(spinRow(settings, 'tile-shadow', 'Drop shadow', 'Soft shadow under every tile (0 = off)', 0, 1, 0.05));
        bgTile.add(switchRow(settings, 'tile-sheen', 'Glossy highlight', 'A soft sheen along the top of each tile'));
        bgTile.add(spinRow(settings, 'corner-roundness', 'Corner roundness', 'For the “Rounded square” shape: 0.05 is almost square, 1.00 is a circle', 0.05, 1.0, 0.05));
        bgTile.add(comboRow(settings, 'running-style', 'Running apps', 'How running apps are marked', RUNNING_STYLES));
        look.add(bgTile);

        const details = new Adw.PreferencesGroup({
            title: 'Look details',
            description: 'Each of these is independent: after applying a preset (Terminal and Blueprint use them) you can keep or switch off every one separately.',
        });
        details.add(comboRow(settings, 'icon-tint', 'App icon colours', 'Greyscale or one colour instead of each app’s own colours', ICON_TINTS));
        details.add(colorRow(settings, 'icon-tint-color', 'Icon tint colour', 'Used by “Tinted with a custom colour”. Reset = the accent colour',
            () => themeOf().accent, signals));
        details.add(spinRow(settings, 'icon-tint-strength', 'Icon tint strength', '0 = plain grey, 1 = the full tint colour', 0, 1, 0.05));
        details.add(comboRow(settings, 'center-style', 'Centre tile style', 'Follow the tile style instead of a solid accent slab', CENTER_STYLES));
        details.add(comboRow(settings, 'label-font', 'App name font', null, LABEL_FONTS));
        details.add(comboRow(settings, 'label-case', 'App name capitalisation', null, LABEL_CASES));
        details.add(spinRow(settings, 'label-glow', 'App name glow', 'Soft glow in the accent colour (0 = off)', 0, 1, 0.05));
        details.add(comboRow(settings, 'backdrop-pattern', 'Background pattern', 'Drawn once behind the tiles, so it costs nothing while the Hive is open', BACKDROP_PATTERNS));
        details.add(spinRow(settings, 'pattern-opacity', 'Pattern strength', null, 0.02, 0.6, 0.02));
        details.add(spinRow(settings, 'pattern-spacing', 'Pattern spacing', 'Pixels between lines or dots (graph paper marks every 5th line)', 2, 80, 1, 0));
        details.add(comboRow(settings, 'search-style', 'Search bar shape', null, SEARCH_STYLES));
        details.add(comboRow(settings, 'search-prompt', 'Search bar prefix', null, SEARCH_PROMPTS));
        look.add(details);

        const glass = new Adw.PreferencesGroup({
            title: 'Liquid glass',
            description: 'These only apply to the “Liquid glass” tile style (the Liquid Glass presets use it).',
        });
        glass.add(switchRow(settings, 'glass-refraction', 'Real-time refraction',
            'Bends the desktop through each tile with a GPU shader. It uses a snapshot taken when the Hive opens, so video wallpapers show one frame. Switch off if it looks wrong or runs slowly'));
        glass.add(spinRow(settings, 'refraction-strength', 'Lens strength', 'How far the glass edge bends the image (pixels)', 0, 30, 1, 0));
        glass.add(spinRow(settings, 'refraction-edge', 'Lens width', 'How far in from the edge the bending reaches', 0.2, 0.8, 0.05));
        glass.add(spinRow(settings, 'refraction-frost', 'Frosting', 'Blur inside the glass (pixels)', 0, 12, 0.5, 1));
        glass.add(spinRow(settings, 'refraction-chroma', 'Colour fringing', 'Rainbow edge on the glass (pixels)', 0, 6, 0.25, 2));
        glass.add(spinRow(settings, 'refraction-vibrance', 'Vibrance', 'Saturation of the image seen through the glass', 0.8, 1.8, 0.05));
        glass.add(spinRow(settings, 'glass-rim', 'Rim light', 'The thin bright line along the edge', 0, 1, 0.05));
        glass.add(spinRow(settings, 'glass-gloss', 'Inner glow', 'Soft light gathered inside the edge', 0, 1, 0.05));
        glass.add(spinRow(settings, 'glass-depth', 'Depth shading', 'Shading on the far side of each tile', 0, 1, 0.05));
        glass.add(spinRow(settings, 'glass-angle', 'Light angle', 'Where the light comes from, in degrees (-124 = top-left)', -180, 180, 5, 0));
        glass.add(comboRow(settings, 'glass-light', 'Lighting', 'Following the pointer re-lights nearby tiles as you move', LIGHT_MODES));
        look.add(glass);

        const border = new Adw.PreferencesGroup({title: 'Tile border'});
        border.add(spinRow(settings, 'border-width', 'Width', 'Set to 0 for borderless tiles', 0, 6, 0.1, 1));
        border.add(comboRow(settings, 'border-style', 'Style', null, BORDER_STYLES));
        border.add(comboRow(settings, 'border-mode', 'Colour', 'Rainbow gives every tile its own hue based on its position', BORDER_MODES));
        border.add(colorRow(settings, 'border-color', 'Custom border colour', 'Used when the colour above is “Custom colour”',
            () => themeOf().accent, signals));
        border.add(spinRow(settings, 'border-opacity', 'Opacity', 'Hovered and running tiles are always brighter', 0, 1.0, 0.05));
        look.add(border);

        const bg = new Adw.PreferencesGroup({title: 'Background'});
        bg.add(switchRow(settings, 'blur', 'Blur desktop', 'Blur whatever is behind the Hive'));
        bg.add(spinRow(settings, 'blur-strength', 'Blur radius', null, 5, 80, 1, 0));
        bg.add(colorRow(settings, 'backdrop-color', 'Tint colour', 'Defaults to the theme’s backdrop colour',
            () => rgb255ToHex(themeOf().backdrop), signals));
        bg.add(spinRow(settings, 'backdrop-opacity', 'Tint opacity', 'Raise this if widgets behind the Hive distract you', 0.2, 1.0, 0.02));
        bg.add(spinRow(settings, 'search-width', 'Search bar width', null, 240, 640, 10, 0));
        bg.add(comboRow(settings, 'chrome-style', 'Search bar and menu', 'Glass gives them a frosted, translucent look', CHROME_STYLES));
        bg.add(comboRow(settings, 'search-position', 'Search bar position', null, SEARCH_POSITIONS));
        bg.add(switchRow(settings, 'show-vignette', 'Vignette and glow', 'Soft shading behind the tiles'));
        bg.add(switchRow(settings, 'show-hints', 'Hint line', 'Show the shortcut reminder at the bottom'));
        look.add(bg);
        window.add(look);

        // ---------------------------------------------------------------- Animations
        const anim = new Adw.PreferencesPage({title: 'Animations', icon_name: 'media-playback-start-symbolic'});
        const master = new Adw.PreferencesGroup({
            title: 'Animations',
            description: 'Every animation below can be switched off. The master switch also follows GNOME’s own “Enable animations” setting.',
        });
        master.add(switchRow(settings, 'animations', 'Enable animations', null));
        anim.add(master);

        const opening = new Adw.PreferencesGroup({title: 'Opening and closing'});
        opening.add(comboRow(settings, 'open-animation', 'Opening style', 'How the tiles arrive (and leave)', OPEN_ANIMS));
        opening.add(spinRow(settings, 'animation-speed', 'Speed', '1.00 is the default; lower is slower and floatier', 0.4, 2.5, 0.1, 1));
        opening.add(switchRow(settings, 'launch-animation', 'Launch zoom', 'The launched tile swells while the rest shrink away'));
        opening.add(switchRow(settings, 'menu-animation', 'Menu animation', 'Fade and slide the right-click menu in'));
        anim.add(opening);

        const live = new Adw.PreferencesGroup({title: 'While open'});
        live.add(comboRow(settings, 'hover-style', 'Hover motion', 'How a tile responds when the pointer is over it', HOVER_STYLES));
        live.add(comboRow(settings, 'hover-effect', 'Hover effect', 'Glow, colour fill, or a glint that sweeps across the tile', HOVER_EFFECTS));
        live.add(switchRow(settings, 'press-feedback', 'Press feedback', 'Tiles squish slightly while you hold the button down'));
        live.add(spinRow(settings, 'hover-scale', 'Hover growth', '1.00 turns the hover zoom off', 1.0, 1.4, 0.02));
        live.add(comboRow(settings, 'ambient-animation', 'Idle animation',
            'Continuous motion keeps the GPU a little busier while the Hive is open', AMBIENT_ANIMS));
        anim.add(live);
        window.add(anim);

        // ---------------------------------------------------------------- Keyboard
        const keyPage = new Adw.PreferencesPage({title: 'Keyboard', icon_name: 'input-keyboard-symbolic'});
        const keyGroup = new Adw.PreferencesGroup({
            title: 'Using the Hive without a mouse',
            description: 'Open the Hive with its shortcut, then everything can be done from the keyboard. Press F1 inside the Hive to see this list again.',
        });
        for (const [keys, what] of KEYBOARD_HELP)
            keyGroup.add(new Adw.ActionRow({title: keys, subtitle: what}));
        keyPage.add(keyGroup);
        window.add(keyPage);

        // ---------------------------------------------------------------- Hidden apps
        const hiddenPage = new Adw.PreferencesPage({title: 'Hidden apps', icon_name: 'view-conceal-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Hidden apps',
            description: 'Hidden apps are left out of the Hive until you search for them (they then show a dashed outline). Right-click → “Hide from the Hive” adds one here; restore them here, or from the app’s own menu.',
        });
        const restoreAll = new Gtk.Button({label: 'Restore all', valign: Gtk.Align.CENTER});
        restoreAll.connect('clicked', () => settings.set_strv('hidden-apps', []));
        group.set_header_suffix(restoreAll);
        hiddenPage.add(group);
        window.add(hiddenPage);

        let rows = [];
        const rebuild = () => {
            for (const r of rows)
                group.remove(r);
            rows = [];
            const ids = settings.get_strv('hidden-apps');
            restoreAll.set_sensitive(ids.length > 0);
            if (ids.length === 0) {
                const empty = new Adw.ActionRow({title: 'Nothing is hidden', sensitive: false});
                group.add(empty);
                rows.push(empty);
                return;
            }
            // (Gio.AppInfo.get_all avoids Gio.DesktopAppInfo, which newer GLib versions deprecate)
            const all = Gio.AppInfo.get_all();
            for (const id of ids) {
                const info = all.find(a => a.get_id() === id);
                const row = new Adw.ActionRow({title: info?.get_name() ?? id, subtitle: info ? id : 'Not installed'});
                const icon = info?.get_icon();
                if (icon)
                    row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 32}));
                const btn = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER});
                btn.connect('clicked', () =>
                    settings.set_strv('hidden-apps', settings.get_strv('hidden-apps').filter(x => x !== id)));
                row.add_suffix(btn);
                group.add(row);
                rows.push(row);
            }
        };
        rebuild();
        signals.push([settings, settings.connect('changed::hidden-apps', rebuild)]);

        window.connect('close-request', () => {
            for (const [obj, id] of signals)
                obj.disconnect(id);
            signals.length = 0;
            window._hiveSettings = null;
            return false;
        });
    }
}
