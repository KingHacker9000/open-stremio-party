#!/usr/bin/env python3
"""Deterministic Chrome and Firefox WebExtension source ZIPs."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json

ROOT = Path(__file__).resolve().parent.parent
for browser in ('chrome', 'firefox'):
    output = ROOT / 'dist' / browser
    output.mkdir(parents=True, exist_ok=True)
    scripts = ('torrent.js', 'content.js', 'background.js')
    filenames = (*scripts, 'manifest.json')
    for filename in scripts:
        source = (ROOT / 'extension' / filename).read_text(encoding='utf-8')
        (output / filename).write_bytes(source.encode('utf-8'))
    manifest = json.loads((ROOT / 'extension' / f'manifest.{browser}.json').read_text())
    (output / 'manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
    archive = ROOT / 'dist' / f'open-stremio-party-{browser}.zip'
    with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
        for filename in sorted(filenames):
            info = ZipInfo(filename, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            z.writestr(info, (output / filename).read_bytes())
    print(archive)
