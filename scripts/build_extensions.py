#!/usr/bin/env python3
"""Deterministic Chrome and Firefox WebExtension source ZIPs."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
for browser in ('chrome', 'firefox'):
    output = ROOT / 'dist' / browser
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'extension' / 'content.js', output / 'content.js')
    manifest = json.loads((ROOT / 'extension' / f'manifest.{browser}.json').read_text())
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    archive = ROOT / 'dist' / f'open-stremio-party-{browser}.zip'
    with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
        for path in sorted(output.glob('*')):
            z.write(path, path.name)
    print(archive)
