"""Local Semgrep CE scan; fail on findings, scan errors, or a broken control."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import shutil
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--rules', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path('work/security-results'))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
scanner = shutil.which('semgrep', path=str(Path(sys.executable).parent)) or shutil.which('semgrep')
if not scanner:
    raise SystemExit('Install semgrep==1.179.0 in this Python environment')
base = [scanner, 'scan', '--metrics=off',
        '--disable-version-check', '--strict', '--error', '--no-rewrite-rule-ids',
        '--timeout', '60', '--json']
for folder in ('javascript/browser/security', 'javascript/lang/security', 'typescript/react/security'):
    base += ['--config', str((args.rules / folder).resolve())]

with tempfile.TemporaryDirectory(prefix='kupleno-security-') as directory:
    control = Path(directory) / 'unsafe.js'
    control.write_text('eval(window.location.hash);\n', encoding='utf-8')
    report = args.output / 'negative-control.json'
    result = subprocess.run(base + ['--no-git-ignore', '--output', str(report), str(control)])
    data = json.loads(report.read_text(encoding='utf-8'))
    if result.returncode != 1 or data.get('errors') or not any(
            item['check_id'] == 'eval-detected' for item in data.get('results', [])):
        raise SystemExit('FAIL: the unsafe eval control was not detected cleanly')

command = base + ['--output', str(args.output / 'production.json')]
for pattern in ('extension/vendor', 'extension/next/node_modules', 'extension/next/.output',
                'extension/next/.wxt', '*.test.js', '*.test.mjs', '*.test.ts'):
    command += ['--exclude', pattern]
result = subprocess.run(command + ['extension'])
if result.returncode:
    raise SystemExit(result.returncode)
data = json.loads((args.output / 'production.json').read_text(encoding='utf-8'))
scanned = data.get('paths', {}).get('scanned', [])
if data.get('errors') or data.get('results') or not scanned:
    raise SystemExit('FAIL: scan has errors, findings, or no scanned files')
print(f'PASS: {len(scanned)} production files; negative control detected unsafe eval')
