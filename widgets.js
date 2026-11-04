// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Data sources for the centre-tile widgets. Everything here is cheap and defensive: reads are tiny sysfs/procfs
// files, media info comes from MPRIS over D-Bus (asynchronously), and any failure just leaves the old value.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const decoder = new TextDecoder();

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? decoder.decode(bytes) : '';
}

export class WidgetData {
    constructor() {
        this._cpuPrev = null;
        this._batteryDir = undefined; // undefined = not looked up yet, null = no battery
        this._media = {have: false, title: '', artist: '', playing: false};
        this._player = null;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        if (this._cmdTimer) {
            GLib.source_remove(this._cmdTimer);
            this._cmdTimer = 0;
        }
        this._cancellable.cancel();
    }

    /** Refresh `out` (the shared G.WIDGET_DATA object) for the widget `kind`. */
    update(kind, out, clock24) {
        const now = GLib.DateTime.new_now_local();
        out.hour = now.get_hour();
        out.min = now.get_minute();
        out.sec = now.get_second();
        out.day = now.get_day_of_month();
        out.month = now.format('%b') ?? '';
        out.weekday = now.format('%A') ?? '';
        out.hhmm = (clock24 ? now.format('%H:%M') : now.format('%-I:%M')) ?? '--:--';
        out.date = now.format('%a %-d %b') ?? '';

        try {
            if (kind === 'system') {
                out.cpu = this._cpu();
                out.mem = this._mem();
            } else if (kind === 'battery') {
                out.bat = this._battery();
            } else if (kind === 'media') {
                out.media = this._media;
                this._pollMedia();
            }
        } catch (e) {
            console.warn(`[hive-launcher] widget data failed: ${e}`);
        }
    }

    // ------------------------------------------------------------------ system
    _cpu() {
        const line = readText('/proc/stat').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
        const idle = (line[3] ?? 0) + (line[4] ?? 0);
        const total = line.reduce((a, b) => a + b, 0);
        let pct = 0;
        if (this._cpuPrev) {
            const dt = total - this._cpuPrev.total;
            const di = idle - this._cpuPrev.idle;
            pct = dt > 0 ? 100 * (1 - di / dt) : 0;
        }
        this._cpuPrev = {idle, total};
        return Math.max(0, Math.min(100, pct));
    }

    _mem() {
        const txt = readText('/proc/meminfo');
        const get = key => Number((new RegExp(`${key}:\\s+(\\d+)`).exec(txt) ?? [0, 0])[1]);
        const total = get('MemTotal');
        const avail = get('MemAvailable');
        return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - avail / total))) : 0;
    }

    // ------------------------------------------------------------------ battery
    _findBattery() {
        try {
            const dir = Gio.File.new_for_path('/sys/class/power_supply');
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                const path = GLib.build_filenamev(['/sys/class/power_supply', info.get_name()]);
                try {
                    if (readText(`${path}/type`).trim() === 'Battery') {
                        en.close(null);
                        return path;
                    }
                } catch (_e) { /* not a battery */ }
            }
            en.close(null);
        } catch (_e) { /* no power_supply class */ }
        return null;
    }

    _battery() {
        if (this._batteryDir === undefined)
            this._batteryDir = this._findBattery();
        if (!this._batteryDir)
            return {present: false};
        const pct = Number(readText(`${this._batteryDir}/capacity`).trim());
        const status = readText(`${this._batteryDir}/status`).trim();
        return {present: true, pct: Number.isFinite(pct) ? pct : 0, charging: status === 'Charging'};
    }

    // ------------------------------------------------------------------ media (MPRIS)
    _call(name, path, iface, method, params, replyType, cb) {
        Gio.DBus.session.call(name, path, iface, method, params, replyType, Gio.DBusCallFlags.NONE, 600,
            this._cancellable, (conn, res) => {
                try {
                    cb(conn.call_finish(res));
                } catch (_e) { /* player vanished, or we were cancelled */
                    cb(null);
                }
            });
    }

    _pollMedia() {
        if (this._busy)
            return;
        this._busy = true;
        this._call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), reply => {
                const names = reply ? reply.recursiveUnpack()[0].filter(n => n.startsWith(MPRIS_PREFIX)) : [];
                if (names.length === 0) {
                    this._media = {have: false, title: '', artist: '', playing: false};
                    this._player = null;
                    this._busy = false;
                    return;
                }
                let pending = names.length;
                let best = null;
                for (const name of names) {
                    this._call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', [MPRIS_PLAYER]), new GLib.VariantType('(a{sv})'), r => {
                            if (r) {
                                const props = r.recursiveUnpack()[0];
                                const meta = props.Metadata ?? {};
                                const artist = Array.isArray(meta['xesam:artist']) ? meta['xesam:artist'].join(', ') : (meta['xesam:artist'] ?? '');
                                const info = {
                                    have: true, name,
                                    title: String(meta['xesam:title'] ?? ''),
                                    artist: String(artist),
                                    playing: props.PlaybackStatus === 'Playing',
                                };
                                if (!best || (info.playing && !best.playing))
                                    best = info;
                            }
                            if (--pending === 0) {
                                this._busy = false;
                                if (best) {
                                    this._player = best.name;
                                    this._media = best;
                                } else {
                                    this._media = {have: false, title: '', artist: '', playing: false};
                                }
                            }
                        });
                }
            });
    }

    _command(method) {
        if (!this._player)
            return;
        Gio.DBus.session.call(this._player, MPRIS_PATH, MPRIS_PLAYER, method, null, null,
            Gio.DBusCallFlags.NONE, 600, null, null);
        // pick up the new state quickly
        if (this._cmdTimer)
            GLib.source_remove(this._cmdTimer);
        this._cmdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._cmdTimer = 0;
            this._pollMedia();
            return GLib.SOURCE_REMOVE;
        });
    }

    playPause() {
        this._command('PlayPause');
    }

    next() {
        this._command('Next');
    }

    previous() {
        this._command('Previous');
    }
}
