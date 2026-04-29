# SafeSpend Payment Gateway Setup (v33 — Multi-provider)

This guide walks you through SafeSpend's pluggable payment system. As of
**v33**, SafeSpend supports multiple gateways side-by-side — currently
**Flutterwave** and **Paystack** — with a clean abstraction that makes
adding new providers (Stripe, Adyen, etc.) a drop-in change.

You can run with one provider, both, or neither (wallet-only).
The frontend automatically shows a provider picker when multiple
qualify; if only one qualifies for a given method, it's auto-selected.

---

## What's supported

| Method | Flutterwave | Paystack |
|---|---|---|
| Card (Visa / Mastercard / Verve) | ✅ | ✅ |
| Bank Transfer | ✅ (inline) | ✅ (inline) |
| USSD | ✅ | ✅ |
| Mobile Money — MTN | ✅ (GH) | ✅ (GH) |
| Mobile Money — Vodafone | ✅ (GH) | ✅ (GH) |
| Mobile Money — AirtelTigo | ✅ (GH) | ✅ (GH) |
| Mobile Money — M-Pesa | ✅ (KE) | ❌ |
| SafeSpend Wallet | n/a | n/a |
| Google Play Billing (TWA only) | n/a | n/a |

The wallet path bypasses external gateways entirely — funds are debited
from the user's own SafeSpend balance. The TWA / Play Billing path is
unchanged from earlier versions; on Play Store installs the picker is
hidden and Play handles billing per Google's policy.

---

## Architecture

```
┌──────────────────────┐  callable  ┌────────────────────────────┐
│   index.html (PWA)   │ ─────────▶ │  Cloud Functions (Node 20) │
│                      │            │   index.js (orchestrator)  │
│  Plan picker         │            │           │                │
│   └─ Pay-method      │            │           ├──▶ providers/  │
│      ├─ Card         │            │           │    ├ flutterwave.js
│      ├─ MoMo         │            │           │    ├ paystack.js
│      └─ Wallet       │            │           │    └ base.js   │
│  Provider picker     │            │           │                │
│   ├─ Flutterwave SDK │ ◀── txRef  │  initiatePayment           │
│   └─ Paystack SDK    │            │  verifySubscriptionPayment │
│                      │            │  flutterwaveWebhook (HTTP) │
│                      │            │  paystackWebhook    (HTTP) │
└──────────────────────┘            └──────────────┬─────────────┘
                                                   │
                                       per-provider REST + secrets
                                                   ▼
                                  ┌────────────────────────────────┐
                                  │ Flutterwave API │ Paystack API │
                                  └────────────────────────────────┘
```

### Key security properties (per provider)
- Secret keys live **only** in Cloud Functions env — never the client.
- Webhook signatures verified per provider before any DB writes.
- Subscription activation is **idempotent** — verify-call AND webhook
  can both fire; the Firestore transaction guarantees a single activation.
- Pricing is re-validated server-side. The client cannot pay $0.01 for
  Business Pro Yearly — `initiatePayment` ignores client `amount` and
  uses its own `priceFor(tier, billing)` from a server-trusted PRICING
  table.
- All txns written to `/subscriptionTransactions` are read-only for owners
  and writable only by Cloud Functions (admin SDK bypasses Firestore rules).

---

## Provider abstraction (server-side)

Each provider lives in `functions/providers/<name>.js` and exports the
same shape:

```js
{
  name:        'paystack',                // routing key
  displayName: 'Paystack',                // for any future UI
  initiateMomo({ uid, tier, billing, txRef, expectedAmount, phone, network, currency, email }),
  initiateCard({ uid, tier, billing, txRef, expectedAmount, currency, email }),
  verify(txRef),                          // → { status, amount, providerData }
  verifyWebhookSignature(req),            // → boolean
  parseWebhookEvent(req)                  // → { txRef, status, amount, ... } | null
}
```

The orchestrator in `functions/index.js` is gateway-agnostic — it picks
a provider via `data.provider` and routes to it. The same activation
logic in `providers/base.js#activateSubscription` runs regardless of
which provider made the payment.

---

## Provider abstraction (client-side)

Configs live in the `PAYMENT_GATEWAYS` array near the top of
`index.html` (search for `v33: Multi-provider payment configuration`).
Each entry:

```js
{
  id:           'paystack',
  displayName:  'Paystack',
  publicKey:    'pk_test_...',          // public key — safe to ship
  methods:      ['card', 'momo', 'bank'],
  momoCurrency: 'GHS',
  cardCurrency: 'GHS',
  cardOptions:  'card,bank,bank_transfer,ussd,mobile_money',
  momoNetworks: [
    { code: 'MTN', name: 'MTN Mobile Money', flag: '📱', country: 'GH' },
    { code: 'VODAFONE', name: 'Vodafone Cash', flag: '📞', country: 'GH' },
    { code: 'AIRTELTIGO', name: 'AirtelTigo Money', flag: '📲', country: 'GH' }
  ],
  sdk:     { url: 'https://js.paystack.co/v2/inline.js', global: 'PaystackPop' },
  color:   'from-cyan-500 to-blue-600',
  logo:    '🔵',
  enabled: true
}
```

To **disable a provider** without removing it: set `enabled: false`.
A provider is also auto-disabled if its `publicKey` still contains
`PASTE_YOUR_KEY_HERE` — so half-configured providers can't accidentally
send a real user to a broken checkout.

---

## Step 1 — Choose your providers

You need at least one to charge cards/momo. The wallet path keeps
working with neither.

| If you primarily serve... | Use |
|---|---|
| Ghana / Nigeria / multi-region with M-Pesa | **Flutterwave** |
| Ghana / Nigeria / South Africa, simpler KYC | **Paystack** |
| All of the above | **both** (recommended for resilience) |

Sign-up links:
- Flutterwave: https://dashboard.flutterwave.com/signup
- Paystack:    https://dashboard.paystack.com/#/signup

Both have free sandbox modes — you don't have to complete KYC to test
sandbox transactions.

---

## Step 2 — Get your keys (sandbox)

### Flutterwave
Settings → API:
- `FLWPUBK_TEST-XXXX-X` — public key (frontend)
- `FLWSECK_TEST-XXXX-X` — secret key (Cloud Functions)

### Paystack
Settings → Developers:
- `pk_test_XXXX` — public key (frontend)
- `sk_test_XXXX` — secret key (Cloud Functions; same key signs webhooks)

> Stay in test mode while integrating. Sandbox cards/numbers below.

---

## Step 3 — Install Cloud Functions deps

```bash
cd functions
npm install
cd ..
```

This pulls `firebase-admin`, `firebase-functions`, `node-fetch`. Node 20.

---

## Step 4 — Set the secret keys

Copy the env template and fill in only the providers you're using:

```bash
cp functions/.env.example functions/.env
```

Then edit `functions/.env`:

```
# Flutterwave (omit if not using Flutterwave)
FLW_SECRET_KEY=FLWSECK_TEST-XXXXXXXXXXXXXXXXXXXXXXXXX-X
FLW_SECRET_HASH=<random ≥32-char string — paste same value in FLW dashboard>

# Paystack (omit if not using Paystack)
PSTK_SECRET_KEY=sk_test_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Generate a random hash for Flutterwave with:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

`functions/.env` is git-ignored.

For production you can also use `firebase functions:config:set`:
```bash
firebase functions:config:set \
    flutterwave.secret_key="FLWSECK-..." \
    flutterwave.secret_hash="..." \
    paystack.secret_key="sk_live_..."
```

The provider modules read from both `process.env` and
`functions.config()` — whichever is set takes effect.

---

## Step 5 — Wire public keys into the frontend

Open `index.html`, find `PAYMENT_GATEWAYS` (search for
`v33: Multi-provider payment configuration`), and replace the
placeholder `publicKey` for each provider you're enabling.

```js
// In index.html
const PAYMENT_GATEWAYS = [
    {
        id: 'flutterwave',
        publicKey: 'FLWPUBK_TEST-XXXX-X',     // ← your real test key
        ...
    },
    {
        id: 'paystack',
        publicKey: 'pk_test_XXXX',            // ← your real test key
        ...
    }
];
```

A provider with `PASTE_YOUR_KEY_HERE` still in its `publicKey` is
treated as disabled — so leave the placeholder for any provider you're
not using yet.

---

## Step 6 — Deploy

```bash
firebase use safespend-b0a22
firebase deploy --only functions,firestore:rules
```

Takes 2–4 min. Watch the output for the webhook URLs:

```
Function URL (flutterwaveWebhook(us-central1)): https://us-central1-safespend-b0a22.cloudfunctions.net/flutterwaveWebhook
Function URL (paystackWebhook(us-central1)):    https://us-central1-safespend-b0a22.cloudfunctions.net/paystackWebhook
```

Save both — you'll paste them into the respective dashboards next.

> Cloud Functions require the **Blaze** (pay-as-you-go) plan. The free
> Spark plan blocks deploy. Upgrade at
> https://console.firebase.google.com/project/safespend-b0a22/usage/details

---

## Step 7 — Configure webhooks

### Flutterwave
1. Dashboard → **Settings → Webhooks**
2. URL: paste the `flutterwaveWebhook` URL from Step 6
3. Secret hash: paste the same value as `FLW_SECRET_HASH`
4. Save

### Paystack
1. Dashboard → **Settings → API Keys & Webhooks**
2. Webhook URL: paste the `paystackWebhook` URL from Step 6
3. Save (no separate secret to set — Paystack signs with your API key)

Without webhooks, payments still complete via the verify-call path. But
if a user closes their browser between charge and verify, the webhook
is the safety net that activates their subscription.

---

## Step 8 — Test it end-to-end

### Sandbox card (Flutterwave)
```
Card:    5531 8866 5214 2950
CVV:     564
Expiry:  09/32
PIN:     3310
OTP:     12345
```

### Sandbox card (Paystack)
```
Card:    4084 0840 8408 4081
CVV:     408
Expiry:  any future date
PIN:     0000
OTP:     123456
```

### Sandbox mobile money
Either provider, any 10-digit phone (e.g. `0244000000`). Both
auto-approve in test mode after a few seconds.

### Verification matrix

| Test | Expected |
|---|---|
| Pick Card → Flutterwave → success | Modal closes, "Welcome to..." toast, sub badge appears, premium gates open. `users/<uid>.subscription.provider == 'flutterwave'` |
| Pick Card → Paystack → success | Same as above with `provider == 'paystack'` |
| Pick MoMo → Flutterwave → MTN | Spinner → success → modal closes → sub active |
| Pick MoMo → Paystack → MTN | Same |
| Cancel mid-flow (either provider) | Silent close (Flutterwave) or "Payment was cancelled" (Paystack) — no charge |
| MoMo timeout (2 min) | "Payment Timed Out" message + retry button |
| Disable Flutterwave (`enabled: false`) | Provider picker only shows Paystack; if only Paystack supports method, picker is skipped entirely |
| Page reload mid-payment | Webhook still activates the sub. Watch Firestore `users/<uid>.subscription` flip |
| Pay $0.01 via tampered console | Server REJECTS — `initiatePayment` ignores client amount |
| Two parallel payments | Idempotent — only one activation |

---

## Step 9 — Going live

Per provider:

### Flutterwave
1. Dashboard → flip top-left toggle from Test to Live
2. Settings → API → copy **live** keys (no `_TEST`)
3. Update `index.html`: `publicKey: 'FLWPUBK-XXXX-X'`
4. Update `functions/.env`: `FLW_SECRET_KEY=FLWSECK-XXXX-X`
5. Update Flutterwave dashboard webhook → live mode (same URL + hash)

### Paystack
1. Dashboard → top-right "Test Mode" → flip to Live
2. Copy **live** keys (`pk_live_...` / `sk_live_...`)
3. Update `index.html`: `publicKey: 'pk_live_XXXX'`
4. Update `functions/.env`: `PSTK_SECRET_KEY=sk_live_XXXX`
5. Add the same webhook URL on Paystack live mode

Then:
```bash
firebase deploy --only functions,hosting
```

Bump `CACHE_NAME` in `service-worker.js` (e.g. `safespend-v34`) so PWA
clients pick up the new keys.

Smoke-test with a small real charge ($1 / ₵1) on each enabled provider.
Refund yourself afterward via the respective dashboard if needed.

---

## How to add a new gateway

Pluggable design — adding Stripe, Adyen, etc. is a 5-step drop-in:

### 1. Create `functions/providers/<name>.js`
Match the interface in `providers/base.js`. Implement:
- `initiateMomo` (or no-op if the provider doesn't support momo)
- `initiateCard` (or no-op)
- `verify(txRef)` — returns canonical `{ status, amount, providerData }`
- `verifyWebhookSignature(req)` — returns boolean
- `parseWebhookEvent(req)` — returns the canonical event shape, or `null` to ignore

Use `crypto.createHmac` for signature verification. Use `node-fetch`
for REST calls (already in deps).

### 2. Register it in `functions/index.js`
```js
const PROVIDERS = {
    flutterwave: require('./providers/flutterwave'),
    paystack:    require('./providers/paystack'),
    stripe:      require('./providers/stripe')   // ← new
};
```

### 3. Add a webhook export
```js
exports.stripeWebhook = makeWebhookHandler('stripe');
```

### 4. Add the frontend config in `PAYMENT_GATEWAYS`
```js
{
    id: 'stripe',
    displayName: 'Stripe',
    publicKey: 'pk_test_...',
    methods: ['card'],
    momoCurrency: 'USD',
    cardCurrency: 'USD',
    momoNetworks: [],
    sdk: { url: 'https://js.stripe.com/v3/', global: 'Stripe' },
    color: 'from-indigo-500 to-purple-600',
    logo: '🟣',
    enabled: true
}
```

### 5. (If new SDK shape) Add a branch in `purchaseWithCard`
The existing `if (providerId === 'flutterwave') ... else if (providerId === 'paystack') ...`
in `index.html` is where each provider's inline-checkout SDK is
launched with its provider-specific options. Add an
`else if (providerId === 'stripe')` branch that calls the right SDK.

That's the entire change. UI provider-picker, server orchestrator,
webhook router, and verification all wire up automatically.

---

## How to switch between providers

You can do any of:

**Disable one** — set `enabled: false` in `PAYMENT_GATEWAYS` (and
optionally remove its key from `.env`). Picker only shows the others.

**Replace one** — set `enabled: false` on the one you don't want and
add config for the new one.

**Run multiple side-by-side** — keep `enabled: true` on all of them.
The provider picker auto-shows when ≥2 enabled providers support the
chosen method.

**Make Paystack default for momo / Flutterwave default for card** —
not a config option today; both providers offering both methods will
trigger the picker. If you want forced routing, narrow each provider's
`methods` array (e.g. Flutterwave `['card']` only, Paystack
`['momo']` only). Then no picker fires.

---

## Server-side amount validation (anti-fraud)

A user could in theory tamper with the client and claim a $19.99
charge bought them Business Pro Yearly ($587.88). The server prevents
this in three places:

1. **`initiatePayment`** — server picks the price from its own
   `PRICING` table; client `amount` is ignored.
2. **`verifySubscriptionPayment`** — compares provider-returned amount
   against stored expected amount (±5% FX tolerance).
3. **Webhook handlers** — same check before activating.

Mismatches mark the txn `failed` with reason "Amount mismatch — payment
refunded automatically". Refund manually via the provider dashboard.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `Cloud Functions not available` toast | Functions not deployed | `firebase deploy --only functions` |
| `Unknown payment provider: X` | Provider misspelled or not registered | Check `PROVIDERS` map in `functions/index.js` and `PAYMENT_GATEWAYS` in `index.html` |
| Provider picker not showing | Only one provider enabled for that method | Expected — provider auto-selected |
| Provider missing from picker | `enabled: false` or placeholder key still in publicKey | Set `enabled: true` and replace placeholder |
| Flutterwave webhook never fires | Wrong URL / wrong secret hash | Re-check both in FLW dashboard |
| Paystack webhook never fires | Wrong URL | Re-paste in Paystack dashboard (no secret to set) |
| Paystack signature fails | `req.rawBody` not available | Ensure handler is `onRequest`, not `onCall` (already correct in v33) |
| Amount mismatch | Currency confusion (paying GHS, expecting USD) | Set the right `cardCurrency` / `momoCurrency` per provider |
| `auth/unauthenticated` from callable | User not signed in | Force Google sign-in before showing plan picker |
| Test cards rejected with "Insufficient funds" | Live keys against test cards | Switch to test keys |

---

## Pre-launch checklist

- [ ] Live keys for at least one provider in `index.html` `PAYMENT_GATEWAYS`
- [ ] Live secret keys in Cloud Functions config (`firebase functions:config:set` or `.env`)
- [ ] Webhook URLs configured in each provider's dashboard
- [ ] `firestore.rules` deployed with `subscriptionTransactions` rule
- [ ] One successful card test per enabled provider
- [ ] One successful mobile money test per enabled provider
- [ ] One timeout test (mobile money, let it expire)
- [ ] One failure test (cancel mid-flow)
- [ ] Cross-device test: pay on phone, verify on desktop
- [ ] Webhook reactivation test (close tab mid-payment, sub still activates)
- [ ] PWA users see the multi-provider picker
- [ ] TWA users see ONLY Play Billing path (Card/MoMo hidden)

---

## Cost reference (verify on each provider's pricing page — these change)

| | Flutterwave | Paystack |
|---|---|---|
| Card (international) | 3.8% + small flat | 3.9% + ₵1 |
| Card (domestic GH) | 1.95% | 1.95% |
| Mobile Money | 1.4–2% | 1.5% capped at ₵2 |
| Bank Transfer | ~$0.50 flat | ~₵1 flat |
| Settlement timing | T+1 | T+2 |

The current PRICING (Pro $19.99, Business $49.99) leaves comfortable
margin even at the highest fee tier.

---

That's it. Both gateways run side-by-side on demand, switching is a
config flip, and adding new ones is a 5-step drop-in.
