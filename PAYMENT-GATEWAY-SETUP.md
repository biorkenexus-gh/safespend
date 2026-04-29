# SafeSpend Payment Gateway Setup (Flutterwave)

This guide walks you through setting up the Mobile Money / Card / Bank
payment system added in **v32**. Once configured, users can pay for
SafeSpend Pro and Business Pro via:

- **Card** — Visa, Mastercard, Verve, plus Bank Transfer / USSD
- **Mobile Money** — MTN, Vodafone, AirtelTigo (Ghana), M-Pesa (Kenya)
- **SafeSpend Wallet** — existing in-app balance (unchanged)

> **Already in your repo:** Google Play Billing flow (TWA users) — see
> `PLAY-CONSOLE-SUBSCRIPTIONS.md`. The new gateway runs **alongside** it:
> Play Store users keep Play Billing; web/PWA users get the new picker.

---

## Architecture at a glance

```
┌─────────────────────┐    httpsCallable   ┌─────────────────────────────┐
│  index.html (PWA)   │ ─────────────────▶ │  Cloud Functions (Node 20)  │
│                     │                    │                             │
│  Plan picker        │ ◀───── txRef ───── │  initiateMomoPayment        │
│  └─ Pay-method      │                    │  initiateCardPayment        │
│     ├─ Card → FLW   │                    │  verifySubscriptionPayment  │
│     ├─ MoMo → poll  │                    │  flutterwaveWebhook (HTTP)  │
│     └─ Wallet       │                    │                             │
└─────────────────────┘                    └──────────────┬──────────────┘
                                                          │
                                              REST + secret key
                                                          ▼
                                            ┌────────────────────────┐
                                            │   Flutterwave API v3   │
                                            └────────────────────────┘
```

**Key security properties:**
- Secret key (`FLW_SECRET_KEY`) lives **only** on Cloud Functions — never the client.
- Pricing is **re-validated server-side** against the same `PRICING` constants used by the frontend.
- Webhook signature (`FLW_SECRET_HASH`) prevents fake payment notifications.
- Subscription activation is **idempotent** — safe to fire from both verify-call AND webhook.
- All transactions written to `/subscriptionTransactions` are **read-only for owners**, and writable **only by Functions** (admin SDK bypasses Firestore rules).

---

## Step 1 — Create a Flutterwave account

1. Go to https://dashboard.flutterwave.com/signup → register your business
2. Verify your email + phone, then complete KYC (business name, ID, etc.)
3. Once approved, in **Settings → API** you'll see:
   - **Public Key** (starts with `FLWPUBK_TEST-` for sandbox, `FLWPUBK-` for live)
   - **Secret Key** (starts with `FLWSECK_TEST-` / `FLWSECK-`)
   - **Encryption Key** (used by some payment methods — not needed for our flows)

> 💡 **Stay in test mode** while integrating. The sandbox accepts test card numbers (e.g. `5531 8866 5214 2950`, CVV `564`, expiry `09/32`, OTP `12345`) and simulated mobile-money prompts.

---

## Step 2 — Wire the public key into the frontend

Open `index.html`, find the `PAYMENT_GATEWAY` constant (search for `v32 PAYMENT GATEWAY CONFIG`):

```javascript
const PAYMENT_GATEWAY = {
    provider:  'flutterwave',
    publicKey: 'FLWPUBK_TEST-SANDBOXDEMOKEY-X',   // ← replace
    currency:        'GHS',                       // mobile money currency
    cardCurrency:    'USD',                       // card billing currency
    momoNetworks: [...],
    polling: { intervalMs: 4000, timeoutMs: 120000 }
};
```

Replace `publicKey` with your real value. **Do not** put the secret key here.

---

## Step 3 — Set the secret key in Cloud Functions

Two ways (Functions v1 syntax — both work):

**Option A: `firebase functions:config:set` (recommended for prod)**

```bash
firebase functions:config:set \
    flutterwave.secret_key="FLWSECK_TEST-XXXXXXXXXXXXXXXXXXXXXXXXX-X" \
    flutterwave.secret_hash="$(openssl rand -hex 16)"
```

Save the secret hash output — you'll paste the same value into the Flutterwave dashboard in Step 5.

**Option B: `.env` file (works for emulator + Functions v2)**

```bash
cd functions
cp .env.example .env
# Edit .env and fill in real values
```

```
FLW_SECRET_KEY=FLWSECK_TEST-XXXXXXXXXXXXXXXXXXXXXXXXX-X
FLW_SECRET_HASH=4f8a2d9c1e5b7a3f9d2c8e6b1a4f7d3e
```

`.env` is git-ignored.

---

## Step 4 — Deploy Cloud Functions

First-time setup (only if you don't already have Firebase CLI):

```bash
npm install -g firebase-tools
firebase login
firebase use safespend-b0a22   # or your project ID
```

Then install + deploy:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

You'll see four endpoints come up:
- `initiateMomoPayment` (callable)
- `initiateCardPayment` (callable)
- `verifySubscriptionPayment` (callable)
- `flutterwaveWebhook` (HTTPS — note the URL!)

The webhook URL looks like:
```
https://us-central1-safespend-b0a22.cloudfunctions.net/flutterwaveWebhook
```

---

## Step 5 — Configure the webhook

1. Flutterwave Dashboard → **Settings → Webhooks**
2. Paste the webhook URL from Step 4
3. Paste the **same** `FLW_SECRET_HASH` value from Step 3
4. Save

> ⚠️ Without the webhook, payments still work (verify-call activates them), but if a user closes their browser before verification, their subscription won't activate until they reopen the app. The webhook is your safety net.

---

## Step 6 — Deploy the Firestore rules

The new `subscriptionTransactions` collection rule is in `firestore.rules`. Deploy:

```bash
firebase deploy --only firestore:rules
```

---

## Step 7 — Test it end-to-end

### Test card

```
Card:    5531 8866 5214 2950
CVV:     564
Expiry:  09/32
PIN:     3310
OTP:     12345
```

### Test mobile money

Pick any network → enter `0244000000` (or any 10-digit number) → in test mode Flutterwave auto-approves after a few seconds.

### What to verify

| Test | Expected outcome |
|---|---|
| Card → success | Modal closes, "Welcome to SafeSpend Pro!" toast, sub badge appears, premium gates open |
| Card → cancel  | Inline modal closes silently, no charge, can retry |
| MoMo → approve | Spinner → success screen → modal closes → sub active |
| MoMo → ignore (timeout) | After 2 min: "Payment Timed Out" with helpful message + retry |
| MoMo → fail PIN | "Payment Failed" → user can retry without re-entering tier |
| Page reload mid-payment | Webhook still activates the sub (open Firestore Console, watch `subscription` field flip) |
| Pay $19.99 for Pro Yearly | Server REJECTS — amount mismatch (price should be $235.08) |
| Two parallel payments | Idempotent — only one activation, both txRefs land in `/subscriptionTransactions` |

---

## Step 8 — Going live

1. Switch to live keys in `index.html`:
   ```javascript
   publicKey: 'FLWPUBK-XXXXXXXXXXXXXXXXX-X'   // live (no _TEST)
   ```
2. Update Cloud Functions secret:
   ```bash
   firebase functions:config:set \
       flutterwave.secret_key="FLWSECK-XXXXXXXXXXXXXXXXXXXXXXXXX-X"
   firebase deploy --only functions
   ```
3. Update Flutterwave dashboard webhook → toggle from test to live
4. Bump service-worker cache (e.g. `safespend-v33`) to invalidate old clients
5. Smoke-test with a small real charge ($1) — refund yourself afterwards

---

## How the flows work

### Mobile Money (push prompt)

```
User → picks "Mobile Money"
     → enters phone + network
     → clicks Pay
Frontend → callable: initiateMomoPayment(tier, billing, phone, network)
Backend  → reserves tx_ref in /subscriptionTransactions (status: pending)
         → calls FLW /charges?type=mobile_money_ghana
         → returns tx_ref to frontend
Frontend → shows "Check your phone" + spinner
         → polls verifySubscriptionPayment every 4s
Backend  → on each poll: calls FLW /transactions/verify_by_reference
         → returns status: pending | successful | failed
Frontend → on successful: animates checkmark, activates locally, closes
         → on failed:     shows retry screen
         → on 2min:       shows timeout message
Backend  → meanwhile FLW also fires webhook → idempotent activation
```

### Card / Bank (inline checkout)

```
User → picks "Card or Bank"
Frontend → callable: initiateCardPayment(tier, billing) → tx_ref
         → loads checkout.flutterwave.com/v3.js
         → FlutterwaveCheckout({ public_key, tx_ref, amount, customer })
         → user enters card details inside FLW iframe
         → FLW callback: { status, tx_ref }
Frontend → callable: verifySubscriptionPayment(tx_ref)
Backend  → verifies via FLW REST → activates if successful
```

### Wallet (unchanged from v31)

Direct Firestore write — no gateway involved.

---

## Server-side amount validation (anti-fraud)

A user could in theory tamper with `tx_ref` and claim a $19.99 charge bought them Business Pro Yearly ($587.88). The server prevents this in three places:

1. **`initiateXPayment`** — server picks the price from its own `PRICING` table; client `amount` is ignored.
2. **`verifySubscriptionPayment`** — compares `flw.data.amount` against the stored expected amount (±5% FX tolerance).
3. **`flutterwaveWebhook`** — same check before activating.

If amounts don't match, the txn is marked `failed` with reason `Amount mismatch — payment refunded automatically`, and you should manually refund via Flutterwave dashboard if needed.

---

## Multi-region pricing (optional)

Right now `PAYMENT_GATEWAY.currency` is hardcoded to `GHS` for mobile money. To support multiple countries:

```javascript
function getMomoCurrency(profile) {
    const map = { GH: 'GHS', KE: 'KES', UG: 'UGX', NG: 'NGN', ZA: 'ZAR' };
    return map[profile?.country] || 'GHS';
}
```

Then call `getMomoCurrency(profile)` in `submitMomoPayment()` instead of the constant. Flutterwave auto-converts your USD-set base price to the local currency at checkout.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `Cloud Functions not available` | Functions not deployed | `firebase deploy --only functions` |
| `No transaction reference returned` | Wrong region / wrong project | `firebase use <project-id>` then redeploy |
| Webhook never fires | Wrong URL / wrong secret hash | Re-check both in FLW dashboard, redeploy hash |
| Amount mismatch on every txn | Currency confusion (paying GHS, expecting USD) | Set `currency: 'USD'` for cards, `'GHS'` for momo |
| `auth/unauthenticated` from callable | User not signed in | Force Google sign-in before showing plan picker |
| Test cards rejected with "Insufficient funds" | Using live keys against test cards | Switch back to FLWPUBK_TEST- / FLWSECK_TEST- |

---

## Pre-launch checklist

- [ ] Live FLW public key in `index.html`
- [ ] Live FLW secret key set in Cloud Functions config
- [ ] Webhook URL configured in Flutterwave dashboard
- [ ] `flutterwaveWebhook` reachable (test with a real test charge — watch logs in Firebase Console)
- [ ] `firestore.rules` deployed with `subscriptionTransactions` rule
- [ ] At least one successful card test (any tier)
- [ ] At least one successful mobile money test (any tier)
- [ ] At least one timeout test (mobile money — let it expire)
- [ ] At least one failure test (cancel mid-flow)
- [ ] Tested cross-device: pay on phone, see active sub on desktop
- [ ] Verified webhook activates sub when client closes early (kill the tab mid-payment)
- [ ] PWA users: NO Google Play option visible
- [ ] TWA users: ONLY Play Billing path visible (Card/MoMo hidden)

---

## Cost reference

Flutterwave fees (verify on their pricing page — these change):
- **Card (international)**: 3.8% + small fee
- **Card (domestic Ghana)**: 1.95%
- **Mobile Money**: 1.4–2%
- **Bank transfer**: ~$0.50 flat

Build these into your pricing or absorb them into your margin. The current PRICING already has comfortable margin at $19.99 Pro / $49.99 Business Pro.

---

That's it. Both gateways now run side-by-side: Play Billing for TWA users (per Google policy), Flutterwave for everyone else. The wallet path is preserved as a third option so users can spend in-app credit toward their subscription.
