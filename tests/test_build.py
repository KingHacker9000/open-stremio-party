import hashlib
import json
from pathlib import Path
import subprocess
import sys
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent


def test_reproducible_extension_packages():
    hashes = []
    for _ in range(2):
        subprocess.run([sys.executable, str(ROOT / 'scripts/build_extensions.py')], check=True, capture_output=True)
        current = []
        for browser in ('chrome', 'firefox'):
            bundle = ROOT / 'dist' / f'open-stremio-party-{browser}.zip'
            current.append(hashlib.sha256(bundle.read_bytes()).hexdigest())
            with ZipFile(bundle) as archive:
                assert set(archive.namelist()) == {'manifest.json', 'content.js', 'background.js'}
                manifest = json.loads(archive.read('manifest.json'))
                assert manifest == json.loads((ROOT / 'extension' / f'manifest.{browser}.json').read_text())
                for info in archive.infolist():
                    assert info.date_time == (2020, 1, 1, 0, 0, 0)
                for name in ('content.js', 'background.js'):
                    assert archive.read(name) == (ROOT / 'extension' / name).read_bytes()
        hashes.append(current)
    assert hashes[0] == hashes[1]
