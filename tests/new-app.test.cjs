'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', 'skills', 'miniapp-from-a-sentence', 'scripts', 'new-app.cjs');

test('new-app copies a template that starts on its own', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mafs-')), 'shop');
  execFileSync(process.execPath, [script, 'ordering', dir]);
  for (const f of ['app/server.js', 'app/data.json', 'app/public/index.html', '_lib/initdata.cjs', '_lib/client/tma.js', '.env.example', '.gitignore', 'package.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.env$/m);
  const app = require(path.join(dir, 'app', 'server.js'));
  assert.strictEqual(typeof app.listen, 'function');
});

test('new-app refuses unknown templates and non-empty folders', () => {
  assert.throws(() => execFileSync(process.execPath, [script, 'casino', 'x'], { stdio: 'pipe' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafs-'));
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  assert.throws(() => execFileSync(process.execPath, [script, 'survey', dir], { stdio: 'pipe' }));
});
