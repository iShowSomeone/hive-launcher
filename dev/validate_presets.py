#!/usr/bin/env python3
"""Validate options.js against the GSettings schema.

  * every PRESET_BASE key exists in the schema, has the right type, and its value equals the schema default
    ("Schema defaults must equal PRESET_BASE")
  * every preset value is a valid value for its key (type, <range>, <choices>)
  * every option list used by a combo (SHAPES, SORT_MODES, FOLDER_MODES, ...) matches the schema <choices>
Run from the project root:  python3 dev/validate_presets.py
"""
import json, subprocess, sys, xml.etree.ElementTree as ET
from pathlib import Path

root = Path(__file__).resolve().parent.parent
schema = ET.parse(next((root / 'schemas').glob('*.gschema.xml'))).getroot()
keys = {}
for k in schema.iter('key'):
    d = k.find('default').text.strip()
    rng = k.find('range')
    choices = [c.get('value') for c in k.iter('choice')]
    keys[k.get('name')] = dict(type=k.get('type'), default=d, min=rng.get('min') if rng is not None else None,
                               max=rng.get('max') if rng is not None else None, choices=choices)

js = """import * as o from './options.js';
console.log(JSON.stringify({base: o.PRESET_BASE, presets: o.PRESETS, lists: {
  shape: o.SHAPES, layout: o.LAYOUTS, 'logo-style': o.LOGO_STYLES, labels: o.LABEL_MODES, 'sort-mode': o.SORT_MODES,
  'group-mode': o.FOLDER_MODES, 'custom-policy': o.CUSTOM_POLICIES, 'tile-style': o.TILE_STYLES, 'hover-effect': o.HOVER_EFFECTS,
  'border-style': o.BORDER_STYLES, 'border-mode': o.BORDER_MODES, 'running-style': o.RUNNING_STYLES,
  'open-animation': o.OPEN_ANIMS, 'ambient-animation': o.AMBIENT_ANIMS, 'hover-style': o.HOVER_STYLES,
  'chrome-style': o.CHROME_STYLES, 'glass-light': o.LIGHT_MODES, 'search-position': o.SEARCH_POSITIONS,
  'center-widget': o.WIDGETS, 'icon-tint': o.ICON_TINTS, 'center-style': o.CENTER_STYLES, 'label-font': o.LABEL_FONTS, 'label-case': o.LABEL_CASES,
  'backdrop-pattern': o.BACKDROP_PATTERNS, 'search-style': o.SEARCH_STYLES, 'search-prompt': o.SEARCH_PROMPTS, 'perf-tier': o.PERF_TIERS, theme: Object.entries(o.THEMES).map(([i, t]) => [i, t.name])}}));"""
out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=root, capture_output=True, text=True, check=True).stdout
data = json.loads(out)
errors = []

def py_default(info):
    t, d = info['type'], info['default']
    if t == 'b': return d == 'true'
    if t == 'd': return float(d)
    if t == 's': return d.strip("'")
    return d

def check_value(key, v, where):
    info = keys.get(key)
    if info is None:
        errors.append(f'{where}: unknown key {key}'); return
    t = info['type']
    ok = {'b': isinstance(v, bool), 'd': isinstance(v, (int, float)) and not isinstance(v, bool), 's': isinstance(v, str)}.get(t, False)
    if not ok:
        errors.append(f'{where}: {key} has wrong type for {t!r}: {v!r}'); return
    if t == 'd':
        if info['min'] is not None and v < float(info['min']): errors.append(f'{where}: {key}={v} < min {info["min"]}')
        if info['max'] is not None and v > float(info['max']): errors.append(f'{where}: {key}={v} > max {info["max"]}')
    if t == 's' and info['choices'] and v not in info['choices']:
        errors.append(f'{where}: {key}={v!r} not in {info["choices"]}')

for key, v in data['base'].items():
    check_value(key, v, 'PRESET_BASE')
    info = keys.get(key)
    if info and info['type'] in 'bds':
        d = py_default(info)
        same = abs(d - v) < 1e-9 if info['type'] == 'd' else d == v
        if not same: errors.append(f'PRESET_BASE: {key}={v!r} but schema default is {d!r}')
for pid, preset in data['presets'].items():
    for key, v in preset['values'].items():
        check_value(key, v, f'preset {pid}')
        if key not in data['base']: errors.append(f'preset {pid}: {key} is missing from PRESET_BASE')
for key, items in data['lists'].items():
    info = keys.get(key)
    if info is None: errors.append(f'list for {key}: no such schema key'); continue
    ids = [i[0] for i in items]
    if info['choices'] and ids != info['choices']:
        errors.append(f'list for {key} {ids} != schema choices {info["choices"]}')
    if info['type'] == 's' and info['default'].strip("'") not in ids:
        errors.append(f'list for {key}: schema default {info["default"]} not offered')

print(f'{len(keys)} schema keys, {len(data["base"])} preset keys, {len(data["presets"])} presets')
if errors:
    print('\n'.join('  ✗ ' + e for e in errors)); sys.exit(1)
print('presets and option lists are consistent with the schema')
