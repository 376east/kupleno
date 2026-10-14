const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.resolve(process.env.KUPLENO_DEMO_PROJECT || path.join(root, '../work/demo-composition'));
  await fs.mkdir(path.join(output, 'assets/fonts'), { recursive: true });
  for (const name of ['index.html', 'hyperframes.json', 'package.json', 'BRIEF.md', 'STORYBOARD.md']) {
    await fs.copyFile(path.join(__dirname, 'demo-cleanup', name), path.join(output, name));
  }
  await fs.copyFile(path.join(__dirname, 'render-demo.py'), path.join(output, 'render-demo.py'));
  for (const name of ['overview', 'purchases', 'details', 'stores', 'control', 'returns']) {
    await fs.copyFile(path.join(root, 'assets/demo/scenes', `${name}.png`), path.join(output, 'assets', `${name}.png`));
  }
  for (const name of ['golos-regular.ttf', 'golos-bold.ttf', 'OFL.txt']) {
    await fs.copyFile(path.join(root, 'extension/fonts', name), path.join(output, 'assets/fonts', name));
  }
  console.log(output);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
