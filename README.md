# President's Data Bundles Ghana — Paystack starter

This is a **deployment-ready starter implementation**, not a live payment integration. The included `render.yaml` helps configure the Render web service, but you still need to connect a GitHub repository, create a PostgreSQL database, add secrets, and deploy. It includes:
- customer bundle selection and order form;
- server-side price lookup;
- Paystack-hosted checkout initialized for Ghana Mobile Money;
- PostgreSQL order records;
- server-side transaction verification on callback;
- HMAC-SHA512 signature checking for Paystack webhooks, followed by server-side transaction verification;
- an owner order desk at `/admin.html` for viewing orders and marking a verified-paid order delivered.

## Before you begin

Install Node.js 20+ and create a PostgreSQL database. On your hosting provider, configure environment variables; do not put secret keys in `public/` or commit them to Git.

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to your PostgreSQL connection string.
3. Set `DATABASE_SSL=true` if your database provider requires TLS.
4. Set `BASE_URL` to your public HTTPS URL once deployed (locally it can be `http://localhost:3000`). When deployed on Render, the app can use Render's `RENDER_EXTERNAL_URL` if `BASE_URL` is omitted.
5. Set `PAYSTACK_SECRET_KEY` to a **test** secret key initially.
6. Set `ADMIN_TOKEN` to a long random value. Do not use a guessable password.
7. Install dependencies and start the app:

   ```bash
   npm install
   npm start
   ```

8. Open `http://localhost:3000` for the customer site and `http://localhost:3000/admin.html` for the owner order desk.

## Add your real prices

The starter is configured with your current 1 GB prices in `BUNDLES` near the top of `server.js`: MTN = GH₵4.40 (`440` pesewas), Telecel = GH₵6.00 (`600` pesewas), and AT = GH₵5.00 (`500` pesewas). Edit this server-side list whenever you change prices. `pricePesewas` is an integer in pesewas:
- GH₵4.40 = `440`
- GH₵5.00 = `500`
- GH₵6.00 = `600`
- GH₵12.50 = `1250`

The browser never determines the price. The server looks up the chosen bundle ID and uses the server-side price when creating a Paystack transaction. The three configured 1 GB bundles reflect the prices supplied so far. Add more bundle sizes only after deciding their prices.

## Configure Paystack

1. Create/access your Paystack merchant account and complete any required business verification.
2. Use **test keys** while building and testing.
3. Deploy the app on a host that supports a Node.js server and environment variables, and use HTTPS.
4. In Paystack Dashboard > Settings/API or Developers, configure the webhook URL to:

   `https://YOUR-DOMAIN/api/paystack/webhook`

5. Ensure `BASE_URL` exactly matches your public HTTPS site.
6. Test MTN, Telecel, and AT Mobile Money options as applicable to your Paystack account and current provider support. The checkout is initialized with `channels: ["mobile_money"]`; Paystack documents provider-specific codes for its direct Charge API, but this project uses hosted transaction checkout.
7. Test callback and webhook behavior, including delayed/pending payments, wrong amounts, repeated webhook events, failed transactions, and database outages.
8. Only after successful tests, replace the test secret key with the live secret key in the hosting environment and perform a controlled live test.

Official docs:
- Initialize/verify transactions: https://paystack.com/docs/api/transaction/
- Mobile Money: https://paystack.com/docs/payments/payment-channels/
- Verify payments: https://paystack.com/docs/payments/verify-payments/
- Webhooks: https://paystack.com/docs/payments/webhooks/

## Manual fulfilment process

1. Open `/admin.html` over HTTPS.
2. Enter the `ADMIN_TOKEN` configured in your hosting environment.
3. Load orders.
4. Only orders with `payment_status = paid` can be marked delivered.
5. Manually send the correct bundle to the customer's recipient number using your supplier/network process.
6. Click **Mark delivered** only after you have sent the bundle.

The page keeps the admin token only in the current page's memory; do not use this page on a shared device. For a production store, add stronger admin authentication, access logging, rate limiting, privacy/retention rules, and database backups.

## Important production notes

- Do not expose `PAYSTACK_SECRET_KEY` in browser JavaScript.
- Do not mark an order paid because the customer returns to the website, sends a screenshot, or shows a success page. The server must verify the transaction status, reference, amount and currency.
- A paid order starts as `awaiting_fulfilment`; payment verification does not send data automatically.
- The database is required for orders and webhook idempotency. Choose a host with persistent PostgreSQL and backups.
- Add rate limiting, spam protection, input validation appropriate for your customers, privacy notice/consent, refund/support contact, and monitoring before public launch.
- This starter does not provide automatic bundle delivery, receipts, refunds, or a polished dispute-management workflow.
- Never send your secret key or admin token in chat or screenshots.


## Render deployment from Android

1. Create/sign in to GitHub and create a repository called `presidents-data-bundles-ghana`.
2. Upload the project files and folders to the repository root. Upload `package.json`, `server.js`, `render.yaml`, `README.md`, `.gitignore`, `.env.example`, and the `public` folder. **Do not upload `.env` or any secret keys.**
3. Create a PostgreSQL database on a provider such as Neon. Copy its connection string privately.
4. Open Render and choose **New > Blueprint** (or create a Web Service from your GitHub repo if Blueprint is not available). Select the repository containing `render.yaml`.
5. In the Render service's environment settings, enter:
   - `DATABASE_URL`: your PostgreSQL connection string
   - `PAYSTACK_SECRET_KEY`: your Paystack test secret key
   - `ADMIN_TOKEN`: a long random secret generated for admin access
   - `DATABASE_SSL`: `true` for a hosted database requiring SSL
6. Deploy and wait for the build to finish. Open the Render URL and `/health` to check the server is responding.
7. In Paystack test mode, configure the webhook URL as `https://YOUR-RENDER-URL/api/paystack/webhook`.
8. Test the entire payment flow before switching to live credentials.

Render web services require a public web service configuration and support Node.js apps. Free instances may sleep when idle. See https://render.com/docs/web-services and https://render.com/docs/your-first-deploy.
