# ADL Checkout API

Stripe backend for Adelaide Landscape & Building Supplies online checkout.

## Deploy to Railway

1. Go to railway.app → New Project → Deploy from GitHub repo (or drag this folder)
2. Set environment variables (see .env.example):
   - `STRIPE_SECRET_KEY` — from stripe.com/dashboard → Developers → API keys
   - `STRIPE_WEBHOOK_SECRET` — after setting up webhook (see below)
   - `FRONTEND_URL` — `https://adl-landscape-supplies.sintra.site`
3. Railway auto-detects Node.js and runs `npm start`
4. Copy the Railway URL (e.g. `https://adl-checkout-api.up.railway.app`)

## Set the API URL in the website

Open `src/lib/config.ts` in the website and set:
```
NEXT_PUBLIC_API_URL=https://your-railway-url.up.railway.app
```
(set this in .env.local for dev, or as a build env var before publishing)

## Set up Stripe Webhook

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://your-railway-url.up.railway.app/api/webhook`
3. Events to listen for: `checkout.session.completed`
4. Copy the signing secret → paste as `STRIPE_WEBHOOK_SECRET` in Railway

## Test with Stripe test keys

Use `sk_test_...` keys first. Test card: `4242 4242 4242 4242`, any future date, any CVC.
