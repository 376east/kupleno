const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../extension/next');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const { version } = readJson('package.json');
const manifest = readJson('.output/chrome-mv3/manifest.json');

assert.equal(manifest.version, version, 'Built extension version must match package.json');
assert.equal(manifest.version_name, `${version} preview`, 'Built extension must show the current preview version');
console.log(`Preview manifest version verified: ${manifest.version_name}`);
