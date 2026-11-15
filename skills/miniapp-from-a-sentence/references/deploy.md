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
7. **Before real customers:** replace the in-memory storage (orders counter, bookings, survey answers)
   with a database; it resets on every restart.
