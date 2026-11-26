"""Package the built extension with stable ZIP timestamps, order and permissions."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
build = root / 'extension/next/.output/chrome-mv3'
output = args.output.resolve()
if output.is_relative_to(build.resolve()):
    parser.error('Output must be outside the build directory')
manifest = json.loads((build / 'manifest.json').read_text(encoding='utf-8'))
package = json.loads((root / 'extension/next/package.json').read_text(encoding='utf-8'))
assert manifest['version'] == manifest.get('version_name', manifest['version']) == package['version']
assert manifest['manifest_version'] == 3
files = sorted(path for path in build.rglob('*') if path.is_file())
assert files and (build / 'app.html') in files
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        assert not path.is_symlink(), 'Symlinks must not enter the package'
        entry = ZipInfo(path.relative_to(build).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        entry.compress_type = ZIP_DEFLATED
        archive.writestr(entry, path.read_bytes(), compresslevel=9)
with ZipFile(output) as archive:
    assert archive.testzip() is None
print(json.dumps({'output': str(output), 'files': len(files), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}))
