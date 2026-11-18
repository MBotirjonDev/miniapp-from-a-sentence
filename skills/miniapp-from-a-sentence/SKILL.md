---
name: miniapp-from-a-sentence
description: Builds a working, secure Telegram Mini App (ordering, booking or survey/lead form) with a zero-dependency Node backend from a one-sentence request such as "I need an ordering bot for my shop". Use when the user wants a Telegram Mini App, a Telegram shop, booking or form bot built, not when auditing an existing one.
---

# Telegram Mini App from one sentence

Turn a short request into a running Mini App: plain HTML/CSS/JS front end (no build step) and a
small Node 18+ server with no dependencies. Three tested templates cover most client requests:

| Template | Use for | Flow |
|---|---|---|
| `ordering` | shops, cafes, delivery | catalog → cart → order sent to the admin chat |
| `booking` | barbers, clinics, tutors | service → day → free slot → contact → booking to admin |
| `survey` | leads, applications, feedback | one question per screen → answers to admin |

## Workflow

### 1. Clarify (one message, at most three questions)
Ask only what changes the build:
- What is sold, booked or asked? (items with prices, services with durations, or questions)
- Who receives the orders: a person or a group? (becomes `ADMIN_CHAT_ID`)
- Online payment: Payme, Click, both, or pay on pickup? The `ordering` template has Payme and Click
  built in (server-side Merchant API handlers, checkout links in the app). They switch on when their
  keys are in the environment; without keys orders are "pay on pickup".

If the user gives no details, build the closest template with realistic sample data and say so.

### 2. Create the app
```sh
node scripts/new-app.cjs <ordering|booking|survey> <folder>
```
This copies `templates/<name>/` to `<folder>/app/` and `templates/_lib/` to `<folder>/_lib/`, and
writes `.env.example`, `.gitignore` and `package.json`.

### 3. Fill in the content
Edit only `app/data.json` for names, prices, services, hours or questions. Change `app/server.js`
when the business rules differ (delivery fee, opening hours logic, extra fields). Keep these rules
from `references/security.md` true after every change:
- the user id comes only from validated initData, never from the body or `initDataUnsafe`
- the server recomputes every price and re-checks every slot
- the bot token is only in the server's environment
- user text is escaped (`escapeHtml`) in admin messages and set with `textContent` in the page

### 4. Design
The templates already follow Telegram's look: single column, colors from `themeParams` (so dark mode
works), native MainButton and BackButton, 44 px touch targets. Keep that. Change wording, sample
data and order of sections; avoid adding custom colors that ignore the theme.

### 5. Test
```sh
cd <folder> && npm run dev        # http://localhost:3000, mock Telegram with signed dev initData
```
In dev mode (no `BOT_TOKEN`), a mock `Telegram.WebApp` appears with MainButton and BackButton, and
the server signs a fake user's initData, so the real validation path runs. Click through the whole
flow and check the admin message printed in the terminal. If you changed server logic, add a test in
the style of `tests/miniapp.test.cjs` in this skill's repository.

If the telegram-miniapp-audit skill or its scanner is available, run it on the folder and fix what
it confirms.

### 6. Deploy
Give the user the steps in `references/deploy.md`. They create the bot in @BotFather and set the
environment themselves. Never ask for, store or paste a real bot token, and never create bots or
accounts for the user.

## Files, network and secrets (what this skill touches)

- **Files:** `scripts/new-app.cjs` only creates the new `<folder>` you name and writes the template
  files into it. It refuses to write into a folder that already has files. It deletes nothing and
  runs no shell commands. The generated ordering app, when it runs, writes one file:
  `DATA_DIR/store.json` (its menu, orders and payment records).
- **Network:** the skill itself makes no network calls. The generated app's server, once the user
  deploys it with their own token, calls one endpoint: `https://api.telegram.org/bot<BOT_TOKEN>/sendMessage`
  (and `/setWebhook` if they set one up) to deliver orders to the admin chat. If payments are enabled,
  the app makes no outgoing payment calls: Payme and Click call the app's `/payments/*` URLs, and the
  customer opens `checkout.paycom.uz` / `my.click.uz` links in Telegram. In dev mode
  (`npm run dev`) it only listens on `http://localhost:3000` and prints admin messages to the
  terminal instead of sending them.
- **Secrets:** no token or key is stored anywhere in this skill. The server reads `BOT_TOKEN`,
  `ADMIN_CHAT_ID`, `WEBHOOK_SECRET` and the optional Payme/Click keys from `process.env`. Dev mode signs test data with a random
  key generated at startup, which is never valid for Telegram.

## Payments (ordering template)

Payme (Merchant API) and Click (SHOP-API) are in `_lib/payments.cjs`, wired into `ordering/server.js`:
- the order total is computed on the server and stored in tiyin (so'm × 100); checkout links carry it
- Payme calls `POST /payments/payme` (Basic auth with the cashbox key), Click calls
  `POST /payments/click` (MD5 sign with the secret key); both are checked before anything changes
- an order becomes `paid` only from these callbacks, never from the client; the admin gets a PAID message
- the customer taps "I have paid" and the app asks the server for the real status

Keys go in the server environment only (`PAYME_MERCHANT_ID`, `PAYME_KEY`, `PAYME_TEST`,
`CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY`). The user gets them from their own
Payme Business and Click merchant cabinets (a registered business is required); never ask for them in
chat. Test with Payme's sandbox (`PAYME_TEST=1`) before production. Steps: `references/deploy.md`.

## Shop management and storage (ordering template)

The owner manages the menu from the admin chat (`ADMIN_CHAT_ID`) through the bot, no admin website:
`/items`, `/price <id> <price>`, `/hide <id>`, `/show <id>`, `/add <category> | <name> | <price> |
<description>`, `/orders`, `/done <order>`. Only messages from that chat are accepted, and the bot
webhook must be set with `WEBHOOK_SECRET` (`references/deploy.md`). Tell the owner to send `/help`.

Catalog changes, orders and payment records are saved to `DATA_DIR/store.json` (atomic writes), so a
restart keeps them. `data.json` is only the starting menu. The host must keep `DATA_DIR` on a
persistent disk, and the owner should back it up. One server process only; move to a database
beyond one small shop. The booking and survey templates still keep data in memory.

## Report back
Tell the user: which template, what you changed, how you tested it (the flow you clicked and the
admin message you saw), and the deploy steps. Say clearly where data lives: the ordering template saves to
`DATA_DIR/store.json` (needs a persistent disk and backups); booking and survey keep data in memory
and need a database before real customers.
