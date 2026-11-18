#!/usr/bin/env node
'use strict';
// Starts each template in dev mode, opens it at phone width with Playwright, clicks through the
// main flow and saves screenshots to docs/. Fails if any step does not reach the expected screen.
// Usage: node scripts/walkthrough.cjs [--no-shots]
const path = require('path');
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');

const T = path.join(__dirname, '..', 'skills', 'miniapp-from-a-sentence', 'templates');
const DOCS = path.join(__dirname, '..', 'docs');
const shots = !process.argv.includes('--no-shots');

const PAY_ENV = ['PAYME_MERCHANT_ID', 'PAYME_KEY', 'PAYME_TEST', 'WEBAPP_URL'];
function load(name, env = {}) {
  delete process.env.BOT_TOKEN;
  process.env.NODE_ENV = 'development';
  for (const k of PAY_ENV) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mafs-wt-')) }, env);
  delete require.cache[require.resolve(path.join(T, name, 'server.js'))];
  const app = require(path.join(T, name, 'server.js'));
  return app;
}

async function run(name, steps, { env, shotName = name } = {}) {
  const app = load(name, env);
  const port = await app.listen(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  // telegram.org is not reachable offline; the mock takes over either way.
  await page.route('https://telegram.org/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  const main = page.locator('#mock-main-button');
  let i = 0;
  for (const [label, act, expectText] of steps) {
    await act(page, main, port);
    await page.getByText(expectText, { exact: false }).first().waitFor({ timeout: 5000 });
    if (shots) await page.screenshot({ path: path.join(DOCS, `${shotName}-${++i}.png`) });
    console.log(`  ok ${name}: ${label}`);
  }
  if (errors.length) throw new Error(`${name}: page errors: ${errors.join('; ')}`);
  await browser.close();
  await new Promise((r) => app.server.close(r));
  return app.outbox;
}

(async () => {
  const ordering = await run('ordering', [
    ['menu', async () => {}, 'Coffee Corner'],
    ['add items', async (p) => { await p.getByRole('button', { name: 'Add Latte' }).click(); await p.getByRole('button', { name: 'Add one Latte' }).click(); await p.getByRole('button', { name: 'Add Croissant' }).click(); }, 'View order'],
    ['cart', async (p, m) => { await m.click(); await p.locator('#note').fill('No sugar, pick up at 9:30'); }, 'Your order'],
    ['placed', async (p, m) => { await m.click(); }, 'placed'],
  ]);
  if (!/Total: 71 000 UZS/.test(ordering.at(-1))) throw new Error('ordering: admin message has the wrong total');

  // Ordering with Payme on: the walkthrough plays Payme's server calls itself (sandbox-style).
  const KEY = 'walkthrough-test-key';
  const payme = (port, method, params) => fetch(`http://127.0.0.1:${port}/payments/payme`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64') },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());
  const paid = await run('ordering', [
    ['menu', async () => {}, 'Coffee Corner'],
    ['add items', async (p) => { await p.getByRole('button', { name: 'Add Latte' }).click(); await p.getByRole('button', { name: 'Add one Latte' }).click(); await p.getByRole('button', { name: 'Add Croissant' }).click(); }, 'View order'],
    ['cart', async (p, m) => { await m.click(); }, 'Your order'],
    ['pay screen', async (p, m) => { await m.click(); }, 'Pay with Payme'],
    ['opened Payme', async (p) => {
      await p.getByRole('button', { name: 'Pay with Payme' }).click();
      const link = await p.evaluate(() => document.body.dataset.openedLink);
      const decoded = Buffer.from(link.split('/').pop(), 'base64').toString();
      if (!/^m=demo-merchant;ac\.order_id=1;a=7100000/.test(decoded)) throw new Error('ordering-pay: wrong Payme link ' + decoded);
    }, 'I have paid'],
    ['not yet paid', async (p, m) => { await m.click(); }, 'not received the payment yet'],
    ['paid', async (p, m, port) => {
      const account = { order_id: '1' };
      const created = await payme(port, 'CreateTransaction', { id: 'wt-1', time: Date.now(), amount: 7100000, account });
      if (!created.result) throw new Error('ordering-pay: ' + JSON.stringify(created));
      await payme(port, 'PerformTransaction', { id: 'wt-1' });
      await m.click();
    }, 'paid'],
  ], { env: { PAYME_MERCHANT_ID: 'demo-merchant', PAYME_KEY: KEY, PAYME_TEST: '1' }, shotName: 'ordering-pay' });
  if (!/Order #1 PAID via Payme/.test(paid.at(-1).replace(/<[^>]+>/g, ''))) throw new Error('ordering-pay: admin did not get the PAID message');

  const booking = await run('booking', [
    ['services', async () => {}, 'Barber Studio'],
    ['times', async (p) => { await p.getByRole('button', { name: 'Choose Haircut', exact: true }).click(); await p.locator('.chip[aria-pressed]').last().click(); await p.locator('.chips').nth(1).locator('.chip:not([disabled])').last().click(); }, 'Continue'],
    ['details', async (p, m) => { await m.click(); await p.locator('#phone').fill('+998 90 123 45 67'); }, 'Your details'],
    ['booked', async (p, m) => { await m.click(); }, 'You are booked'],
  ]);
  if (!/New booking #1/.test(booking.at(-1))) throw new Error('booking: no admin message');

  const survey = await run('survey', [
    ['intro', async () => {}, 'Free consultation'],
    ['choice', async (p, m) => { await m.click(); await p.getByRole('button', { name: 'Telegram bot' }).click(); }, 'Question 1 of 4'],
    ['budget', async (p, m) => { await m.click(); await p.getByRole('button', { name: '$500 – $2,000' }).click(); }, 'Question 2 of 4'],
    ['details', async (p, m) => { await m.click(); await p.locator('#answer').fill('An ordering bot for my bakery'); }, 'Question 3 of 4'],
    ['phone', async (p, m) => { await m.click(); await p.locator('#answer').fill('+998 90 123 45 67'); }, 'Question 4 of 4'],
    ['sent', async (p, m) => { await m.click(); }, 'Thank you'],
  ]);
  if (!/New lead/.test(survey.at(-1))) throw new Error('survey: no admin message');
  console.log('all walkthroughs passed');
})().catch((e) => { console.error(e); process.exit(1); });
