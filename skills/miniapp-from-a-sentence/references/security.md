# Security checklist for every Mini App

The templates already do all of this. When you change them, keep every line true.
For a deeper audit, run the telegram-miniapp-audit skill (github.com/MBotirjonDev/telegram-miniapp-audit).

1. **Validate initData on the server, on every request.** The client sends `Telegram.WebApp.initData`
   in the `X-Telegram-Init-Data` header; `_lib/initdata.cjs` checks the HMAC
   (`secret = HMAC_SHA256("WebAppData", bot_token)`), compares with `crypto.timingSafeEqual`, and
   rejects `auth_date` older than `INITDATA_MAX_AGE` (default 1 hour).
2. **Take the user id only from validated initData.** Never from the request body, a query string or
   `initDataUnsafe`. `initDataUnsafe` is fine for showing a name, never for deciding anything.
3. **The server owns prices, stock and schedules.** The client sends ids and quantities; the server
   looks up prices and recomputes totals. Booking re-checks the slot at the moment of booking.
4. **The bot token lives only in the server's environment** (`BOT_TOKEN`). Never in HTML, JS,
   `VITE_*`/`NEXT_PUBLIC_*` variables, or git. Calls to api.telegram.org happen only on the server.
5. **Webhook secret.** Call `setWebhook` with `secret_token`, and reject updates whose
   `X-Telegram-Bot-Api-Secret-Token` header does not match (`/bot/webhook` does this).
6. **Escape user text** before putting it into HTML messages (`escapeHtml`) and render user text in the
   page with `textContent`, never `innerHTML`.
7. **Limit input.** Body size limit (16 KB), max quantities, max text lengths, phone format checks.
8. **Payments**: an order is paid only when Payme's `PerformTransaction` or Click's Complete
   reaches the server with a valid key or signature, never because the client says so. Compare the
   amount exactly in integer tiyin, refuse a second transaction for the same order, and keep the
   Payme and Click keys in the server environment (checkout links need only public ids).
9. **Admins by numeric id** (`ADMIN_CHAT_ID`), never by username: usernames can be changed and taken.
10. **Production refuses to start without `BOT_TOKEN`,** and the dev mock (`/dev/init-data`) exists
    only when no real token is set.
