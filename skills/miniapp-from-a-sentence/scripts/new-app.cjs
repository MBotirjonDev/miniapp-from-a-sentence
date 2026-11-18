#!/usr/bin/env node
'use strict';
// Copy a template and the shared library into a new folder, ready to run.
// Usage: node new-app.cjs <ordering|booking|survey> <target-dir>
const fs = require('fs');
const path = require('path');

const [template, target] = process.argv.slice(2);
const root = path.join(__dirname, '..', 'templates');
const choices = fs.readdirSync(root).filter((d) => !d.startsWith('_'));
if (!choices.includes(template) || !target) {
  console.error(`usage: new-app.cjs <${choices.join('|')}> <target-dir>`);
  process.exit(2);
}
const dest = path.resolve(target);
if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
  console.error(`${dest} is not empty; choose a new folder`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(path.join(root, template), path.join(dest, 'app'), { recursive: true });
fs.cpSync(path.join(root, '_lib'), path.join(dest, '_lib'), { recursive: true });
fs.writeFileSync(path.join(dest, '.env.example'), [
  '# Copy to .env and fill in. Never commit .env.',
  'BOT_TOKEN=          # from @BotFather',
  'ADMIN_CHAT_ID=      # chat that receives orders (your user id or a group id)',
  'WEBHOOK_SECRET=     # random string, also passed to setWebhook as secret_token',
  'WEBAPP_URL=         # https URL where this app is hosted',
  'NODE_ENV=production',
  'PORT=3000',
  ...(template === 'ordering' ? [
    'DATA_DIR=./data    # where store.json (catalog, orders, payments) is saved; back it up',
    '',
    '# Online payments (optional). Leave empty to take orders as "pay on pickup".',
    '# Payme Business cabinet -> cashbox. Endpoint URL to give Payme: <WEBAPP_URL>/payments/payme',
    'PAYME_MERCHANT_ID=  # public cashbox id',
    'PAYME_KEY=          # cashbox key (secret; use the TEST key with PAYME_TEST=1)',
    'PAYME_TEST=1        # 1 = test.paycom.uz sandbox, remove for production',
    '# Click merchant cabinet. Prepare and Complete URL to give Click: <WEBAPP_URL>/payments/click',
    'CLICK_SERVICE_ID=',
    'CLICK_MERCHANT_ID=',
    'CLICK_SECRET_KEY=   # secret',
  ] : []),
  '',
].join('\n'));
fs.writeFileSync(path.join(dest, '.gitignore'), '.env\nnode_modules/\ndata/\n');
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({
  name: path.basename(dest).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  private: true,
  scripts: { dev: 'node app/server.js', start: 'NODE_ENV=production node app/server.js' },
  engines: { node: '>=18' },
}, null, 2) + '\n');
console.log(`created ${dest}\n  cd ${target} && npm run dev   # opens on http://localhost:3000 with a mock Telegram`);
