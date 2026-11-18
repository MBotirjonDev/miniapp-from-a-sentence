# Going live (tell the user to do these steps; never do them for them)

1. **Create the bot** in Telegram with @BotFather: `/newbot`, pick a name. BotFather gives the token.
   Keep it secret: anyone with it controls the bot.
2. **Host the app over HTTPS.** Any Node 18+ host works (Render, Railway, Fly.io, a VPS with Caddy).
   Set the environment: `BOT_TOKEN`, `ADMIN_CHAT_ID`, `WEBHOOK_SECRET`, `WEBAPP_URL`,
   `NODE_ENV=production`. Start command: `npm start`.
3. **Find `ADMIN_CHAT_ID`:** send any message to @userinfobot (your id), or add the bot to a group and
   read the group id from the first update.
4. **Attach the Mini App to the bot** in @BotFather: `/mybots` → your bot → Bot Settings →
   Menu Button → set the URL to `WEBAPP_URL`. (Or `/newapp` to create a direct-link Mini App.)
5. **Optional /start button:** register the webhook with the secret:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEBAPP_URL>/bot/webhook&secret_token=<WEBHOOK_SECRET>`
   Run this from your own terminal or browser; do not paste the token into chats or code.
6. **Test in Telegram** on a phone: open the bot, tap the menu button, place a test order, and check
   that the admin chat receives it.
7. **Storage.** The ordering template saves to `DATA_DIR/store.json`: put `DATA_DIR` on a persistent
   disk (a VPS folder, or a volume on Render/Railway/Fly.io; plain container disks are wiped on
   redeploy) and back the file up daily. Booking and survey still keep data in memory: add a database
   before real customers.
8. **Shop commands (ordering):** set the webhook from step 5, then send `/help` in the admin chat.
   Only that chat can change prices or the menu.

## Payme and Click (ordering template, optional)

The shop owner needs a registered business (LLC or sole proprietor) and merchant contracts with
Payme and/or Click. The skill never asks for or stores these keys; the owner puts them in the host's
environment.

**Payme**
1. In the Payme Business cabinet, create a cashbox. Set the endpoint URL to
   `<WEBAPP_URL>/payments/payme` and the account field to `order_id`.
2. Set `PAYME_MERCHANT_ID` (cashbox id) and `PAYME_KEY` (the **test** key first) and `PAYME_TEST=1`.
3. Run Payme's sandbox checks (test.paycom.uz): create, perform, cancel, the timeout case and wrong
   amount / unknown order. All must pass before Payme activates the cashbox.
4. Switch to the production key and remove `PAYME_TEST`.

**Click**
1. In the Click merchant cabinet, set both the Prepare and Complete URLs to `<WEBAPP_URL>/payments/click`.
2. Set `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID` and `CLICK_SECRET_KEY`.
3. Make a small real payment and check that the admin chat gets "Order #N PAID via Click".

**Before real payments:** move orders and transactions to a database. A restart of the in-memory
version forgets which orders were paid, and Payme/Click will retry against orders that no longer exist.
