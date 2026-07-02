# Payment Integration Guide

## 1. Add to package.json dependencies

```json
"stripe": "^14.0.0"
```

## 2. Add these environment variables on Render

| Key | Value | Where to get it |
|-----|-------|-----------------|
| `STRIPE_SECRET_KEY` | `sk_live_...` | stripe.com → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | stripe.com → Webhooks → signing secret |
| `PAYSTACK_SECRET_KEY` | `sk_live_...` | paystack.com → Settings → API keys |
| `WEBSITE_URL` | `https://partneriq.fit` | — |

## 3. Add to server.js (after your existing requires at the top)

```javascript
const payments = require('./payment-routes');

// Expose pool and resend globally so payment-routes.js can access them
// Add these two lines inside your initDb() function, just before console.log:
global.__piqPool = pool;
global.__piqResend = resend;
```

## 4. Add these routes to server.js (before the catch-all `app.get('*', ...)`)

```javascript
// Payment routes
app.post('/api/payments/stripe-checkout', payments.stripeCheckout);
app.post('/api/payments/confirm', payments.confirmPayment);

// Webhooks — must use raw body for Stripe signature verification
app.post('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  payments.stripeWebhook
);
app.post('/api/webhooks/paystack', payments.paystackWebhook);
```

## 5. Replace in index.html

In the `CONFIG` block at the top of the script section:
```javascript
stripePublicKey: 'pk_live_YOUR_KEY',   // → your real Stripe publishable key
paystackPublicKey: 'pk_live_YOUR_KEY', // → your real Paystack public key
```

## 6. Set up Stripe webhook

1. Go to stripe.com → Developers → Webhooks → Add endpoint
2. URL: `https://partneriq-9brl.onrender.com/api/webhooks/stripe`
3. Events to listen for: `checkout.session.completed`
4. Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET` on Render

## 7. Set up Paystack webhook

1. Go to paystack.com → Settings → API Keys & Webhooks
2. Webhook URL: `https://partneriq-9brl.onrender.com/api/webhooks/paystack`
3. Paystack signs webhooks automatically using your secret key

## 8. Create a payment-success page

Add `/payment-success` route to server.js for Stripe redirect-back:

```javascript
app.get('/payment-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

The page will handle the `session_id` query param — codes are delivered by email.

## How it works end-to-end

**Paystack (popup, recommended for SA users):**
1. User fills modal → clicks Pay → Paystack popup opens in-browser
2. User pays → popup calls success callback
3. Frontend calls `/api/payments/confirm` with the reference
4. Server verifies with Paystack API → creates group → emails codes
5. Success screen shown with results code displayed AND emailed

**Stripe (redirect checkout, for international cards):**
1. User fills modal → clicks Pay → server creates Checkout session
2. User redirected to Stripe-hosted checkout page
3. Stripe processes payment → fires webhook to `/api/webhooks/stripe`
4. Server receives webhook → creates group → emails codes
5. User redirected back to partneriq.fit with codes in their inbox

**Both flows:**
- A group is automatically created with the buyer as organiser
- The results code is emailed immediately
- The buyer then shares the group code with their team via the app
