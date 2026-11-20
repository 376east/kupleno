'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const requiredFiles = [
  '.nvmrc',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/release-candidate.yml',
  'package-lock.json',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'MONETIZATION.md',
  'PRIVACY.md',
  'RELEASE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/ARCHITECTURE.md',
  'docs/DATA_AND_COMPATIBILITY.md',
  'docs/MAINTENANCE.md',
  'docs/PRODUCT.md',
  'docs/TESTING.md',
  'assets/screenshots/analytics.png',
  'assets/screenshots/overview.png',
  'assets/brand/kupleno-social-preview.png',
  'assets/brand/kupleno-social-preview.svg',
  'extension/analytics-core.js',
  'extension/analytics-utils.js',
  'extension/category-benchmark.json',
  'extension/fixtures/ozon-receipts.json',
  'extension/fixtures/wb-receipts.json',
  'extension/fixtures/yandex-receipts.json',
  'extension/report-quality.js',
  'extension/source-health.js',
  'scripts/browser-smoke.js',
  'scripts/category-benchmark.js',
  'scripts/check-doc-links.js',
  'scripts/performance-benchmark.js',
  'scripts/release-notes.js',
  'scripts/verify-packaged-extension.sh'
];

for (const relative of requiredFiles) {
  assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} must exist`);
}

const manifest = JSON.parse(read('extension/manifest.json'));
const packageJson = JSON.parse(read('package.json'));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(packageJson.version, manifest.version);
assert.match(read('CHANGELOG.md'), new RegExp(`^## ${manifest.version}\\b`, 'm'));
assert.ok(read('README.md').includes(`Текущая версия исходников: \`${manifest.version}\``));
assert.ok(read('extension/README.md').includes(`Версия: \`${manifest.version}\``));

const legacyBrandPattern = new RegExp(['market', 'trat'].join('[ _-]?'), 'i');
const trackedTextFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((relative) => /(?:^|\/)(?:[^/]+\.(?:css|html|js|json|md|sh|txt|ya?ml)|\.gitignore|\.nvmrc)$/.test(relative));
for (const relative of trackedTextFiles) {
  assert.doesNotMatch(read(relative), legacyBrandPattern, `${relative} contains an obsolete product name`);
}

for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release-candidate.yml']) {
  const source = read(workflow);
  const uses = [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0, `${workflow} must use pinned actions`);
  for (const action of uses) {
    assert.match(action, /^[^@]+@[0-9a-f]{40}$/, `${action} must be pinned to a full commit SHA`);
  }
  assert.match(source, /npm ci/);
  assert.match(source, /playwright install --with-deps chromium/);
}

const candidateWorkflow = read('.github/workflows/release-candidate.yml');
assert.match(candidateWorkflow, /^name: Build and publish release/m);
assert.match(candidateWorkflow, /^permissions:\n\s+contents: read/m);
assert.match(candidateWorkflow, /publish:\n[\s\S]+?permissions:\n\s+actions: read\n\s+contents: write/);
assert.match(candidateWorkflow, /npm run verify:release/);
assert.match(candidateWorkflow, /workflow_dispatch:/);
assert.match(candidateWorkflow, /inputs\.tag \|\| github\.ref_name/);
assert.match(candidateWorkflow, /github\.event_name == 'push' \|\| github\.ref == 'refs\/heads\/master'/);
assert.match(candidateWorkflow, /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/);
assert.match(candidateWorkflow, /gh release view/);
assert.match(candidateWorkflow, /gh release create/);
assert.match(candidateWorkflow, /gh release edit/);
assert.match(candidateWorkflow, /gh release delete/);
assert.match(candidateWorkflow, /gh run download/);
assert.match(candidateWorkflow, /--verify-tag/);
assert.match(candidateWorkflow, /--draft/);
assert.match(candidateWorkflow, /--latest/);
assert.match(candidateWorkflow, /cleanup_failed_draft/);
assert.match(candidateWorkflow, /refusing to replace immutable assets/);
for (const asset of ['kupleno-extension.zip', 'SHA256SUMS', 'provenance.txt', 'release-evidence.json']) {
  assert.ok(candidateWorkflow.includes(`dist/${asset}`), `${asset} must be published from dist/`);
}

const ciWorkflow = read('.github/workflows/ci.yml');
assert.match(ciWorkflow, /^name: CI/m);
assert.match(ciWorkflow, /permissions:\n\s+contents: read/);
assert.match(ciWorkflow, /push:\n\s+branches:\n\s+- master\b/);
assert.match(ciWorkflow, /pull_request:/);
assert.match(ciWorkflow, /workflow_dispatch:/);
assert.match(ciWorkflow, /schedule:/);
assert.match(ciWorkflow, /cancel-in-progress: true/);
assert.doesNotMatch(ciWorkflow, /collab\/|continue-on-error|contents:\s*write|security-events:\s*write|gh release/i);
for (const command of ['npm run verify', 'npm run verify:reproducible', 'npm run preview:check',
  'npm run preview:browser', 'npm run preview:design', 'python3 scripts/security-scan.py']) {
  assert.ok(ciWorkflow.includes(command), `${command} must remain a CI gate`);
}
for (const job of ['verify', 'preview', 'semgrep']) assert.ok(ciWorkflow.includes(`  ${job}:`));
assert.equal((ciWorkflow.match(/if: github.event_name != 'schedule'/g) || []).length, 2);
assert.equal((ciWorkflow.match(/if: always\(\) && github.event_name == 'workflow_dispatch' && inputs.keep_artifacts/g) || []).length, 3);
assert.match(ciWorkflow, /keep_artifacts:[\s\S]+?type: boolean\n\s+default: false/);
assert.match(ciWorkflow, /semgrep==1\.179\.0/);
assert.match(ciWorkflow, /ref: [0-9a-f]{40}/);
assert.match(ciWorkflow, /Show scan reports in logs/);
for (const action of [...ciWorkflow.matchAll(/(?:uses:|^- uses:)\s*([^\s#]+)/gm)].map((match) => match[1])) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/, `${action} must be pinned`);
}

const scanScript = read('scripts/security-scan.py');
for (const flag of ['--strict', '--error', '--metrics=off', '--disable-version-check']) assert.ok(scanScript.includes(flag));
assert.match(scanScript, /negative-control\.json/);
assert.match(scanScript, /result\.returncode != 1/);

const candidateScript = read('scripts/verify-release-candidate.sh');
assert.match(candidateScript, /status --porcelain --untracked-files=all/);
assert.match(candidateScript, /cat-file -t/);
assert.match(candidateScript, /rev-parse "refs\/tags\/\$TAG\^\{commit\}"/);
assert.match(candidateScript, /npm --prefix "\$ROOT" run verify:reproducible/);

const releaseNotes = require('../scripts/release-notes.js');
assert.deepEqual(releaseNotes.parseTag('v1.2.3'), { tag: 'v1.2.3', version: '1.2.3' });
assert.throws(() => releaseNotes.parseTag('latest'), /Expected a version tag/);
assert.equal(
  releaseNotes.extractChangelogSection('# Changelog\n\n## 1.2.3\n\n- Fixed\n\n## 1.2.2\n\n- Old\n', '1.2.3'),
  '- Fixed'
);
const generatedNotes = releaseNotes.buildReleaseNotes(read('CHANGELOG.md'), `v${manifest.version}`);
assert.match(generatedNotes, new RegExp(`blob/v${manifest.version}/README\\.md`));
assert.match(generatedNotes, /CI не имеет пользовательских сессий маркетплейсов/);

const packageScript = read('scripts/package-extension.sh');
assert.match(packageScript, /Refusing ambiguous root archive/);
for (const required of ['LICENSE', 'PRIVACY.md', 'SECURITY.md', 'SUPPORT.md', 'THIRD_PARTY_NOTICES.md']) {
  assert.ok(packageScript.includes(required), `${required} must be included in the package`);
}

const verifyScript = read('scripts/verify.sh');
assert.match(verifyScript, /verify:categories/);
assert.match(verifyScript, /verify:performance/);
assert.match(verifyScript, /check-doc-links\.js/);
assert.match(verifyScript, /verify-packaged-extension\.sh/);
assert.doesNotMatch(verifyScript, /npm --prefix "\$ROOT" run verify:browser\s*\n\s*"\$ROOT\/scripts\/package-extension\.sh"/);

const packagedSmoke = read('scripts/verify-packaged-extension.sh');
assert.match(packagedSmoke, /unzip -q "\$ARCHIVE"/);
assert.match(packagedSmoke, /verify:browser -- "\$stage\/extension"/);

const thirdParty = read('THIRD_PARTY_NOTICES.md');
const vendoredCheck = read('scripts/check-vendored-dependencies.sh');
for (const hash of vendoredCheck.match(/[0-9a-f]{64}/g) || []) {
  assert.ok(thirdParty.includes(hash), `vendored hash ${hash} must be documented`);
}

assert.equal(
  fs.existsSync(path.join(root, 'kupleno-extension.zip')),
  false,
  'obsolete root archive must not exist; build only into dist/'
);

console.log('release-process.test.js: ok');
