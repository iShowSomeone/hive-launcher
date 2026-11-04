// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings profiles: a JSON file holding every Hive Launcher setting, so a look can be backed up or shared.
// This module is pure (no imports): preferences read the values out of GSettings and call these helpers to
// build / validate the file; see dev/test_profile.mjs.

export const PROFILE_FORMAT = 'hive-launcher-profile';
export const PROFILE_VERSION = 1;
/** Longest string value accepted on import (the custom layout is the only big one). */
export const MAX_STRING = 256 * 1024;

/** Never exported or imported: bookkeeping that only makes sense inside one session. */
export const TRANSIENT_KEYS = new Set(['preview-request', 'edit-request']);

/** Personal data rather than look-and-feel: exported only when the user asks for it. */
export const PERSONAL_KEYS = new Set(['hidden-apps', 'recent-apps']);

export function isProfileKey(key, includePersonal) {
    if (TRANSIENT_KEYS.has(key))
        return false;
    return includePersonal || !PERSONAL_KEYS.has(key);
}

/** `values` is {key: plain JS value}. */
export function buildProfile(values, extensionVersion, now = new Date()) {
    return JSON.stringify({
        format: PROFILE_FORMAT,
        version: PROFILE_VERSION,
        extension: extensionVersion ?? '',
        exported: now.toISOString(),
        settings: values,
    }, null, 2);
}

/** Parse and sanity-check a profile file. Throws an Error with a message fit to show the user. */
export function parseProfile(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (_e) {
        throw new Error('That file is not valid JSON.');
    }
    if (!data || typeof data !== 'object' || data.format !== PROFILE_FORMAT)
        throw new Error('That is not a Hive Launcher profile.');
    if (typeof data.version === 'number' && data.version > PROFILE_VERSION)
        throw new Error('That profile was made by a newer version of Hive Launcher.');
    if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))
        throw new Error('The profile contains no settings.');
    return {settings: data.settings, extension: String(data.extension ?? '')};
}

/**
 * Check a JSON value against a GVariant type string. Returns {ok: true, value} (value normalised for
 * `new GLib.Variant(type, value)`) or {ok: false}. Handles the types the schema uses: b, d, s, u, i, as.
 */
export function coerceValue(type, v) {
    switch (type) {
    case 'b':
        return typeof v === 'boolean' ? {ok: true, value: v} : {ok: false};
    case 'd':
        return typeof v === 'number' && Number.isFinite(v) ? {ok: true, value: v} : {ok: false};
    case 's':
        return typeof v === 'string' && v.length <= MAX_STRING ? {ok: true, value: v} : {ok: false};
    case 'u':
        return Number.isInteger(v) && v >= 0 && v <= 4294967295 ? {ok: true, value: v} : {ok: false};
    case 'i':
        return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? {ok: true, value: v} : {ok: false};
    case 'as':
        return Array.isArray(v) && v.every(x => typeof x === 'string') ? {ok: true, value: [...v]} : {ok: false};
    default:
        return {ok: false};
    }
}
