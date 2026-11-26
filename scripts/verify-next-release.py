"""Verify and package the current Kupleno Chromium release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
NPM = 'npm.cmd' if os.name == 'nt' else 'npm'
ZIP_NAME = 'kupleno-extension.zip'


def run(*args, capture=False):
    return subprocess.run(
        args, cwd=ROOT, check=True, text=True, capture_output=capture, encoding='utf-8'
    ).stdout


def git(*args):
    return run('git', *args, capture=True).strip()


def check_tag(tag, version, commit, event_sha):
    if tag != f'v{version}':
        raise ValueError(f'Expected release tag v{version}')
    ref = f'refs/tags/{tag}'
    if git('cat-file', '-t', ref) != 'tag':
        raise ValueError(f'{tag} must be an annotated tag')
    if git('for-each-ref', '--format=%(tag)', ref) != tag:
        raise ValueError(f'Tag annotation must name {tag}')
    tag_object = git('rev-parse', '--verify', ref)
    if git('rev-parse', '--verify', f'{ref}^{{commit}}') != commit:
        raise ValueError(f'{tag} must point to the checked-out commit')
    if event_sha and event_sha not in (commit, tag_object):
        raise ValueError(f'{tag} no longer matches the tag push')
    if git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('The release tag must be checked from a clean working tree')
    return tag_object


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--tag', help='Require this annotated release tag on HEAD')
    parser.add_argument('--event-sha', help='Expected GitHub tag push SHA')
    args = parser.parse_args()
    if args.event_sha and not args.tag:
        parser.error('--event-sha requires --tag')
    output = args.output_dir.resolve()
    extension = ROOT / 'extension/next'
    if output.is_relative_to(extension.resolve()):
        parser.error('Output must be outside extension/next')

    version = json.loads((extension / 'package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}', version):
        raise ValueError('The extension version must be MAJOR.MINOR.PATCH')
    commit = git('rev-parse', 'HEAD')
    tag_object = check_tag(args.tag, version, commit, args.event_sha) if args.tag else ''
    dirty = bool(git('status', '--porcelain', '--untracked-files=all'))

    run(NPM, 'run', 'preview:check')
    run(NPM, 'run', 'preview:browser')
    with tempfile.TemporaryDirectory() as temporary:
        first = Path(temporary) / ZIP_NAME
        second = Path(temporary) / 'rebuild.zip'
        packager = ROOT / 'scripts/package-preview.py'
        run(sys.executable, packager, '--output', first)
        run(NPM, '--prefix', 'extension/next', 'run', 'build')
        run(sys.executable, packager, '--output', second)
        data = first.read_bytes()
        if data != second.read_bytes():
            raise ValueError('The release ZIP changed on rebuild')

        output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(first, output / ZIP_NAME)
        digest = hashlib.sha256(data).hexdigest()
        (output / 'SHA256SUMS').write_text(f'{digest}  {ZIP_NAME}\n', encoding='utf-8', newline='\n')
        (output / 'provenance.txt').write_text(
            f'git_commit={commit}\ngit_dirty={str(dirty).lower()}\n'
            f'tag={args.tag or ""}\ntag_object={tag_object}\n'
            f'extension_version={version}\nsource=extension/next\n',
            encoding='utf-8',
            newline='\n',
        )
    print(f'Verified reproducible release build {version}: {output / ZIP_NAME}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
