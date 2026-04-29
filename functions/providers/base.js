/**
 * SafeSpend Payment Provider Interface (v33)
 *
 * Every payment gateway plugs in by exporting an object that matches the
 * `Provider` shape below. The orchestrator in `../index.js` discovers
 * providers via `getProvider(name)` and routes calls to them.
 *
 *   ┌──────────────────┐   initiate / verify / webhook
 *   │  Cloud Functions │ ─────────────────────────────▶ provider.method(...)
 *   │  (orchestrators) │
 *   └──────────────────┘
 *
 * To add a new gateway (e.g. Stripe, Adyen):
 *   1. Create `providers/<name>.js` exporting the Provider shape.
 *   2. Register it in `providers/index.js` (the registry).
 *   3. Add a webhook export in `../index.js` that calls
 *      `provider.verifyWebhookSignature` + `provider.parseWebhookEvent`.
 *   4. Add the provider's frontend config to PAYMENT_GATEWAYS in index.html.
 *
 * The Provider shape:
 *
 *   {
 *     name:        'flutterwave',     // unique id, used as routing key
 *     displayName: 'Flutterwave',     // for any future server-rendered UI
 *
 *     // Returns { txRef, status, instructions, providerData } — pushes a
 *     // mobile-money prompt to the user's phone.
 *     initiateMomo({ uid, tier, billing, phone, network, currency, email }),
 *
 *     // Returns { txRef, amount, currency, checkoutMeta } — reserves a
 *     // tx_ref for an inline-checkout flow (provider's hosted iframe).
 *     initiateCard({ uid, tier, billing, currency, email }),
 *
 *     // Returns { status: 'successful'|'failed'|'pending'|'cancelled',
 *     //          amount, providerData } — checks tx state with the gateway.
 *     verify(txRef),
 *
 *     // Returns boolean — verifies HMAC/header signature on incoming webhook.
 *     verifyWebhookSignature(req),
 *
 *     // Returns { txRef, status, amount, providerData } from a webhook body.
 *     parseWebhookEvent(req)
 *   }
 */

const admin = require('firebase-admin');
const functions = require('firebase-functions');

// ─── Pricing (server-trusted mirror of frontend PRICING) ─────────
const YEARLY_DISCOUNT_PCT = 2;
const PRICING = {
    pro: {
        name: 'SafeSpend Pro',
        monthly: 19.99,
        yearly:  Math.round(19.99 * 12 * (1 - YEARLY_DISCOUNT_PCT / 100) * 100) / 100  // 235.08
    },
    business: {
        name: 'Business Pro',
        monthly: 49.99,
        yearly:  Math.round(49.99 * 12 * (1 - YEARLY_DISCOUNT_PCT / 100) * 100) / 100  // 587.88
    }
};

function priceFor(tier, billing) {
    if (!PRICING[tier]) return 0;
    return billing === 'yearly' ? PRICING[tier].yearly : PRICING[tier].monthly;
}

// Tolerance for FX rounding when comparing expected vs gateway-returned amount.
const AMOUNT_TOLERANCE_PCT = 5;

function genTxRef(provider, uid, tier, billing) {
    const ts   = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    const p    = (provider || 'unknown').slice(0, 4).toUpperCase();
    return `${p}_SUB_${uid.slice(0, 8)}_${tier}_${billing}_${ts}_${rand}`.toUpperCase();
}

function expiryFor(billing, startedAt = Date.now()) {
    return billing === 'yearly'
        ? startedAt + 365 * 86400000
        : startedAt + 30  * 86400000;
}

/**
 * Idempotent subscription activation.
 * Safe to call from BOTH the verify-callable AND the webhook handler;
 * the Firestore transaction guarantees only one activation per txRef.
 */
async function activateSubscription({ db, uid, tier, billing, txRef, paymentMethod, provider, providerData }) {
    const txDocRef = db.collection('subscriptionTransactions').doc(txRef);
    const userRef  = db.collection('users').doc(uid);

    return db.runTransaction(async (t) => {
        const txSnap = await t.get(txDocRef);
        if (!txSnap.exists) {
            throw new functions.https.HttpsError('not-found', `Transaction ${txRef} not found`);
        }
        const tx = txSnap.data();

        if (tx.status === 'successful' && tx.activatedAt) {
            return { alreadyActive: true };
        }

        const startedAt = Date.now();
        const expiresAt = expiryFor(billing, startedAt);

        const subscription = {
            tier, billing, startedAt, expiresAt,
            grandfathered: false,
            paymentMethod,
            provider:    provider || tx.provider || null,
            providerRef: txRef
        };

        t.update(userRef, {
            subscription,
            isPremium:    true,
            premiumSince: admin.firestore.FieldValue.serverTimestamp()
        });

        t.update(txDocRef, {
            status:                'successful',
            activatedAt:           admin.firestore.FieldValue.serverTimestamp(),
            providerData:          providerData || tx.providerData || null,
            subscriptionExpiresAt: expiresAt
        });

        return { activated: true };
    });
}

function amountWithinTolerance(expected, got) {
    const tolerance = expected * (AMOUNT_TOLERANCE_PCT / 100);
    return Math.abs(Number(got) - expected) <= tolerance;
}

module.exports = {
    PRICING,
    YEARLY_DISCOUNT_PCT,
    AMOUNT_TOLERANCE_PCT,
    priceFor,
    expiryFor,
    genTxRef,
    activateSubscription,
    amountWithinTolerance
};
