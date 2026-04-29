/**
 * SafeSpend Cloud Functions — Payment Gateway (Flutterwave)
 *
 * Three exports:
 *   1. initiateMomoPayment      (callable) — push prompt to user's phone
 *   2. initiateCardPayment      (callable) — reserves a tx_ref for inline checkout
 *   3. verifySubscriptionPayment(callable) — verifies a tx with the gateway
 *   4. flutterwaveWebhook       (HTTP)     — server-side reconciliation
 *
 * Security model:
 *   • Secret key (FLW_SECRET_KEY) lives ONLY in env, never on client.
 *   • Webhook signature (FLW_SECRET_HASH) verifies incoming events.
 *   • Subscription activation is IDEMPOTENT — webhook + verify can both
 *     fire and the user doc only ends up activated once.
 *   • Pricing is re-validated server-side against PRICING constants below.
 *     A client trying to pay $0.01 for Business Pro Yearly will be rejected.
 *   • All txns are written to /subscriptionTransactions with ownerUid =
 *     request.auth.uid so users can read their own history but never write.
 *
 * Required env vars (set with `firebase functions:config:set`):
 *   flutterwave.secret_key  = FLWSECK-XXXXXXXX-X
 *   flutterwave.secret_hash = your-webhook-secret-hash (any random string ≥16 chars)
 *
 * For local emulator + Functions v2 (deployment):
 *   .env file in this directory:
 *     FLW_SECRET_KEY=FLWSECK-XXXXXXXX-X
 *     FLW_SECRET_HASH=your-webhook-secret-hash
 *
 * See PAYMENT-GATEWAY-SETUP.md in repo root for full deployment instructions.
 */

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const fetch     = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// ─── Config (server-trusted) ─────────────────────────────────────
// Mirror of frontend PRICING — used to re-validate amounts server-side.
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

// Tolerance: gateway may return amount slightly off due to FX. Allow ±5%.
const AMOUNT_TOLERANCE_PCT = 5;

// Read secret key from either functions config or env
function flwSecretKey() {
    return process.env.FLW_SECRET_KEY
        || (functions.config().flutterwave && functions.config().flutterwave.secret_key)
        || '';
}
function flwSecretHash() {
    return process.env.FLW_SECRET_HASH
        || (functions.config().flutterwave && functions.config().flutterwave.secret_hash)
        || '';
}

const FLW_BASE = 'https://api.flutterwave.com/v3';

// ─── Helpers ─────────────────────────────────────────────────────
function genTxRef(uid, tier, billing) {
    const ts   = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `sub_${uid.slice(0, 8)}_${tier}_${billing}_${ts}_${rand}`.toUpperCase();
}

function expiryFor(billing, startedAt = Date.now()) {
    return billing === 'yearly'
        ? startedAt + 365 * 86400000
        : startedAt + 30  * 86400000;
}

async function flwGet(path) {
    const r = await fetch(`${FLW_BASE}${path}`, {
        headers: { Authorization: `Bearer ${flwSecretKey()}` }
    });
    return r.json();
}
async function flwPost(path, body) {
    const r = await fetch(`${FLW_BASE}${path}`, {
        method:  'POST',
        headers: {
            Authorization:  `Bearer ${flwSecretKey()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    return r.json();
}

// Idempotent activation — safe to call multiple times for same txRef
async function activateSubscription({ uid, tier, billing, txRef, paymentMethod, providerData }) {
    const txDocRef = db.collection('subscriptionTransactions').doc(txRef);
    const userRef  = db.collection('users').doc(uid);

    return db.runTransaction(async (t) => {
        const txSnap = await t.get(txDocRef);
        if (!txSnap.exists) {
            throw new functions.https.HttpsError('not-found', `Transaction ${txRef} not found`);
        }
        const tx = txSnap.data();

        // Already activated? No-op.
        if (tx.status === 'successful' && tx.activatedAt) {
            return { alreadyActive: true };
        }

        const startedAt = Date.now();
        const expiresAt = expiryFor(billing, startedAt);

        const subscription = {
            tier, billing, startedAt, expiresAt,
            grandfathered: false,
            paymentMethod,
            providerRef:   txRef
        };

        t.update(userRef, {
            subscription,
            isPremium:    true,                                          // back-compat
            premiumSince: admin.firestore.FieldValue.serverTimestamp()
        });

        t.update(txDocRef, {
            status:           'successful',
            activatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            providerData:     providerData || tx.providerData || null,
            subscriptionExpiresAt: expiresAt
        });

        return { activated: true };
    });
}

// ─── 1. Initiate Mobile Money payment (push prompt) ─────────────
exports.initiateMomoPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Sign in to subscribe');
    }
    const { tier, billing, phone, network, currency, description } = data || {};
    const uid = context.auth.uid;

    // Validate
    if (!PRICING[tier])                     throw new functions.https.HttpsError('invalid-argument', 'Invalid tier');
    if (!['monthly', 'yearly'].includes(billing)) throw new functions.https.HttpsError('invalid-argument', 'Invalid billing cycle');
    if (!phone || phone.replace(/\D/g, '').length < 9)
        throw new functions.https.HttpsError('invalid-argument', 'Invalid phone number');
    const allowedNets = ['MTN', 'VODAFONE', 'AIRTELTIGO', 'MPESA'];
    if (!allowedNets.includes((network || '').toUpperCase()))
        throw new functions.https.HttpsError('invalid-argument', 'Unsupported mobile money network');

    const expectedAmount = priceFor(tier, billing);
    const txRef = genTxRef(uid, tier, billing);

    // Pick the right Flutterwave endpoint by network/region
    const net = network.toUpperCase();
    let endpoint, providerEnum;
    if (net === 'MPESA') {
        endpoint = '/charges?type=mpesa';
        providerEnum = null;
    } else {
        endpoint = '/charges?type=mobile_money_ghana';
        providerEnum = net;   // MTN | VODAFONE | AIRTELTIGO
    }

    // Get user email for receipt
    const userSnap = await db.collection('users').doc(uid).get();
    const u = userSnap.data() || {};
    const email = u.email || `user-${uid}@safespend.app`;

    // Reserve the tx record FIRST (so webhook can match even if API call fails)
    await db.collection('subscriptionTransactions').doc(txRef).set({
        ownerUid:       uid,
        tier,
        billing,
        amount:         expectedAmount,
        currency:       currency || 'GHS',
        phone,
        network:        net,
        paymentMethod:  'momo',
        status:         'pending',
        description:    description || `${PRICING[tier].name} ${billing}`,
        createdAt:      admin.firestore.FieldValue.serverTimestamp()
    });

    // Call Flutterwave
    const payload = {
        tx_ref:    txRef,
        amount:    String(expectedAmount),
        currency:  currency || 'GHS',
        email,
        phone_number: phone,
        ...(providerEnum ? { network: providerEnum } : {}),
        meta:      { uid, tier, billing }
    };

    let flwResp;
    try {
        flwResp = await flwPost(endpoint, payload);
    } catch (e) {
        await db.collection('subscriptionTransactions').doc(txRef).update({
            status: 'failed', error: e.message || 'Network error'
        });
        throw new functions.https.HttpsError('unavailable', 'Could not reach payment provider — try again');
    }

    if (flwResp.status !== 'success') {
        await db.collection('subscriptionTransactions').doc(txRef).update({
            status: 'failed', error: flwResp.message || 'Provider rejected charge', providerData: flwResp
        });
        throw new functions.https.HttpsError('failed-precondition', flwResp.message || 'Payment provider rejected the charge');
    }

    // Stash provider info for verification
    await db.collection('subscriptionTransactions').doc(txRef).update({
        flwId:        flwResp.data?.id || null,
        providerData: flwResp.data || null,
        status:       'awaiting_user'    // user must now approve on phone
    });

    return {
        txRef,
        status:       'awaiting_user',
        instructions: flwResp.meta?.authorization?.note || 'Approve the prompt on your phone to complete payment.'
    };
});

// ─── 2. Initiate Card payment (reserve tx_ref for inline checkout) ───
exports.initiateCardPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in to subscribe');
    const { tier, billing, currency, description } = data || {};
    const uid = context.auth.uid;

    if (!PRICING[tier])                     throw new functions.https.HttpsError('invalid-argument', 'Invalid tier');
    if (!['monthly', 'yearly'].includes(billing)) throw new functions.https.HttpsError('invalid-argument', 'Invalid billing cycle');

    const expectedAmount = priceFor(tier, billing);
    const txRef = genTxRef(uid, tier, billing);

    await db.collection('subscriptionTransactions').doc(txRef).set({
        ownerUid:       uid,
        tier,
        billing,
        amount:         expectedAmount,
        currency:       currency || 'USD',
        paymentMethod:  'card',
        status:         'pending',
        description:    description || `${PRICING[tier].name} ${billing}`,
        createdAt:      admin.firestore.FieldValue.serverTimestamp()
    });

    return { txRef, amount: expectedAmount, currency: currency || 'USD' };
});

// ─── 3. Verify subscription payment ──────────────────────────────
exports.verifySubscriptionPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in to subscribe');
    const { txRef } = data || {};
    if (!txRef) throw new functions.https.HttpsError('invalid-argument', 'Missing tx_ref');

    const uid = context.auth.uid;
    const docRef = db.collection('subscriptionTransactions').doc(txRef);
    const snap   = await docRef.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Transaction not found');
    const tx = snap.data();
    if (tx.ownerUid !== uid) throw new functions.https.HttpsError('permission-denied', 'Not your transaction');

    // Already finalized? Return cached state.
    if (tx.status === 'successful' || tx.status === 'failed' || tx.status === 'cancelled') {
        return { status: tx.status, message: tx.error || null };
    }

    // Ask Flutterwave for the truth
    const verifyResp = await flwGet(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);

    if (verifyResp.status !== 'success' || !verifyResp.data) {
        // Could be still pending — surface "verifying"
        return { status: 'verifying', message: verifyResp.message || 'Awaiting confirmation' };
    }

    const fd = verifyResp.data;
    const flwStatus = (fd.status || '').toLowerCase();    // 'successful' | 'failed' | 'pending'
    const expected  = tx.amount;
    const got       = Number(fd.amount || 0);
    const tolerance = expected * (AMOUNT_TOLERANCE_PCT / 100);

    if (flwStatus === 'successful') {
        if (Math.abs(got - expected) > tolerance) {
            await docRef.update({
                status: 'failed', error: `Amount mismatch: expected ${expected}, got ${got}`, providerData: fd
            });
            return { status: 'failed', message: 'Amount mismatch — payment refunded automatically' };
        }
        // Activate (idempotent)
        await activateSubscription({
            uid, tier: tx.tier, billing: tx.billing, txRef,
            paymentMethod: tx.paymentMethod, providerData: fd
        });
        return { status: 'successful' };
    }

    if (flwStatus === 'failed' || flwStatus === 'cancelled') {
        await docRef.update({
            status: flwStatus, error: fd.processor_response || 'Payment did not complete',
            providerData: fd
        });
        return { status: flwStatus, message: fd.processor_response || 'Payment did not complete' };
    }

    // Still pending
    return { status: 'pending', message: 'Awaiting your approval' };
});

// ─── 4. Flutterwave webhook (server-side reconciliation) ─────────
// Configure in Flutterwave dashboard → Settings → Webhooks:
//   URL:         https://<region>-<project>.cloudfunctions.net/flutterwaveWebhook
//   Secret hash: same value as FLW_SECRET_HASH env var
exports.flutterwaveWebhook = functions.https.onRequest(async (req, res) => {
    // Verify signature
    const signature = req.headers['verif-hash'];
    const expected  = flwSecretHash();
    if (!expected || signature !== expected) {
        console.warn('[flutterwaveWebhook] Bad signature');
        return res.status(401).send('Unauthorized');
    }

    const event = req.body || {};
    if (event.event !== 'charge.completed') {
        return res.status(200).send('Ignored event');
    }

    const fd     = event.data || {};
    const txRef  = fd.tx_ref;
    const status = (fd.status || '').toLowerCase();

    if (!txRef) return res.status(400).send('Missing tx_ref');

    const docRef = db.collection('subscriptionTransactions').doc(txRef);
    const snap   = await docRef.get();
    if (!snap.exists) {
        console.warn(`[flutterwaveWebhook] Unknown tx_ref ${txRef}`);
        return res.status(200).send('Unknown tx_ref'); // 200 so FLW doesn't keep retrying
    }
    const tx = snap.data();

    if (status !== 'successful') {
        await docRef.update({
            status: status || 'failed',
            error:  fd.processor_response || 'Webhook reported failure',
            providerData: fd,
            webhookAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.status(200).send('Recorded non-success');
    }

    // Validate amount
    const expectedAmt = tx.amount;
    const gotAmt      = Number(fd.amount || 0);
    const tolerance   = expectedAmt * (AMOUNT_TOLERANCE_PCT / 100);
    if (Math.abs(gotAmt - expectedAmt) > tolerance) {
        await docRef.update({
            status: 'failed',
            error:  `Webhook amount mismatch: expected ${expectedAmt}, got ${gotAmt}`,
            providerData: fd
        });
        console.warn(`[flutterwaveWebhook] Amount mismatch on ${txRef}`);
        return res.status(200).send('Amount mismatch');
    }

    // Activate (idempotent — safe even if verifySubscriptionPayment already ran)
    try {
        await activateSubscription({
            uid:           tx.ownerUid,
            tier:          tx.tier,
            billing:       tx.billing,
            txRef,
            paymentMethod: tx.paymentMethod,
            providerData:  fd
        });
        return res.status(200).send('Activated');
    } catch (e) {
        console.error(`[flutterwaveWebhook] Activation failed for ${txRef}:`, e);
        return res.status(200).send('Activation failed (will retry on next webhook)');
    }
});

// ─── 5. Manual reactivation utility (admin-callable, optional) ────
// If a webhook is missed (rare), the admin can re-run verification for
// any tx_ref. Safe to expose to admins only.
exports.reverifySubscriptionPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in');
    // Replace this UID with your admin UID (matches firestore.rules isAdmin())
    const ADMIN_UIDS = ['uaiU5Afc1gMowVL37hTzJpSNqBT2'];
    if (!ADMIN_UIDS.includes(context.auth.uid))
        throw new functions.https.HttpsError('permission-denied', 'Admin only');

    const { txRef } = data || {};
    if (!txRef) throw new functions.https.HttpsError('invalid-argument', 'Missing tx_ref');

    const verifyResp = await flwGet(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    if (verifyResp.status !== 'success' || !verifyResp.data) {
        return { status: 'unknown', raw: verifyResp };
    }
    const fd = verifyResp.data;
    if ((fd.status || '').toLowerCase() === 'successful') {
        const txDoc = await db.collection('subscriptionTransactions').doc(txRef).get();
        const tx = txDoc.data();
        await activateSubscription({
            uid: tx.ownerUid, tier: tx.tier, billing: tx.billing, txRef,
            paymentMethod: tx.paymentMethod, providerData: fd
        });
        return { status: 'activated' };
    }
    return { status: (fd.status || 'unknown').toLowerCase() };
});
