/**
 * SafeSpend Cloud Functions — Multi-provider Payment Orchestrator (v33)
 *
 * This file is a THIN ROUTER. All gateway-specific logic lives in
 * providers/<name>.js. To add a new gateway, drop a new file in providers/
 * matching the interface in providers/base.js and register it below.
 *
 * Exports:
 *   1. initiatePayment              (callable) — provider-aware momo/card init
 *   2. verifySubscriptionPayment    (callable) — provider-aware verification
 *   3. flutterwaveWebhook           (HTTP)     — Flutterwave reconciliation
 *   4. paystackWebhook              (HTTP)     — Paystack reconciliation
 *   5. reverifySubscriptionPayment  (callable, admin) — manual reverify
 *
 * Security model:
 *   • All secret keys live ONLY in env / functions config.
 *   • Webhook signatures verified per-provider before any DB writes.
 *   • Subscription activation is IDEMPOTENT (Firestore transaction).
 *   • Pricing re-validated server-side; client `amount` is ignored.
 *   • All txns written to /subscriptionTransactions with ownerUid;
 *     clients can read their own, never write.
 */

const functions = require('firebase-functions');
const admin     = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const {
    PRICING,
    priceFor,
    genTxRef,
    activateSubscription,
    amountWithinTolerance
} = require('./providers/base');

// ─── Provider registry ───────────────────────────────────────────
const PROVIDERS = {
    flutterwave: require('./providers/flutterwave'),
    paystack:    require('./providers/paystack')
};

function getProvider(name) {
    const p = PROVIDERS[(name || '').toLowerCase()];
    if (!p) {
        throw new functions.https.HttpsError('invalid-argument',
            `Unknown payment provider: ${name}. Configured: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    return p;
}

// ─── Helpers ─────────────────────────────────────────────────────
async function lookupEmail(uid) {
    const snap = await db.collection('users').doc(uid).get();
    return (snap.data() || {}).email || `user-${uid}@safespend.app`;
}

function validatePlan(tier, billing) {
    if (!PRICING[tier]) throw new functions.https.HttpsError('invalid-argument', 'Invalid tier');
    if (!['monthly', 'yearly'].includes(billing))
        throw new functions.https.HttpsError('invalid-argument', 'Invalid billing cycle');
}

// ─── 1. Initiate Payment (unified, provider-aware) ───────────────
exports.initiatePayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Sign in to subscribe');
    }
    const { provider: providerName, method, tier, billing, phone, network, currency, description } = data || {};
    const uid = context.auth.uid;

    if (!['momo', 'card'].includes(method))
        throw new functions.https.HttpsError('invalid-argument', 'Invalid payment method');
    validatePlan(tier, billing);

    if (method === 'momo') {
        if (!phone || phone.replace(/\D/g, '').length < 9)
            throw new functions.https.HttpsError('invalid-argument', 'Invalid phone number');
        if (!network)
            throw new functions.https.HttpsError('invalid-argument', 'Mobile money network required');
    }

    const provider       = getProvider(providerName);
    const expectedAmount = priceFor(tier, billing);
    const txRef          = genTxRef(provider.name, uid, tier, billing);
    const email          = await lookupEmail(uid);

    // Reserve the tx record FIRST so the webhook can match even if the
    // provider call fails after we send it.
    await db.collection('subscriptionTransactions').doc(txRef).set({
        ownerUid:      uid,
        provider:      provider.name,
        tier,
        billing,
        amount:        expectedAmount,
        currency:      currency || (method === 'momo' ? 'GHS' : 'USD'),
        phone:         phone || null,
        network:       network ? network.toUpperCase() : null,
        paymentMethod: method,
        status:        'pending',
        description:   description || `${PRICING[tier].name} ${billing}`,
        createdAt:     admin.firestore.FieldValue.serverTimestamp()
    });

    // Call provider
    let initResult;
    try {
        initResult = method === 'momo'
            ? await provider.initiateMomo({ uid, tier, billing, txRef, expectedAmount, phone, network, currency, email })
            : await provider.initiateCard({ uid, tier, billing, txRef, expectedAmount, currency, email });
    } catch (e) {
        await db.collection('subscriptionTransactions').doc(txRef).update({
            status: 'failed',
            error:  e.message || 'Provider rejected charge'
        });
        throw e;
    }

    // Stash provider info
    await db.collection('subscriptionTransactions').doc(txRef).update({
        providerId:   initResult.providerId || null,
        providerData: initResult.providerData || null,
        status:       method === 'momo' ? 'awaiting_user' : 'pending'
    });

    return {
        txRef,
        provider:     provider.name,
        method,
        status:       initResult.status,
        instructions: initResult.instructions || null,
        // Card-only fields the frontend needs to invoke the inline SDK
        amount:       initResult.amount       || null,
        currency:     initResult.currency     || null,
        checkoutMeta: initResult.checkoutMeta || null
    };
});

// ─── 2. Verify Subscription Payment ──────────────────────────────
exports.verifySubscriptionPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in to subscribe');
    const { txRef } = data || {};
    if (!txRef) throw new functions.https.HttpsError('invalid-argument', 'Missing tx_ref');

    const uid    = context.auth.uid;
    const docRef = db.collection('subscriptionTransactions').doc(txRef);
    const snap   = await docRef.get();
    if (!snap.exists)            throw new functions.https.HttpsError('not-found', 'Transaction not found');
    const tx = snap.data();
    if (tx.ownerUid !== uid)     throw new functions.https.HttpsError('permission-denied', 'Not your transaction');

    // Already finalized? Return cached state.
    if (['successful', 'failed', 'cancelled'].includes(tx.status)) {
        return { status: tx.status, message: tx.error || null };
    }

    const provider = getProvider(tx.provider);
    const result   = await provider.verify(txRef);
    const status   = result.status;

    if (status === 'successful') {
        if (!amountWithinTolerance(tx.amount, result.amount)) {
            await docRef.update({
                status:       'failed',
                error:        `Amount mismatch: expected ${tx.amount}, got ${result.amount}`,
                providerData: result.providerData
            });
            return { status: 'failed', message: 'Amount mismatch — payment refunded automatically' };
        }
        await activateSubscription({
            db, uid,
            tier: tx.tier, billing: tx.billing, txRef,
            paymentMethod: tx.paymentMethod,
            provider:      provider.name,
            providerData:  result.providerData
        });
        return { status: 'successful' };
    }

    if (status === 'failed' || status === 'cancelled') {
        await docRef.update({
            status,
            error:        result.message || 'Payment did not complete',
            providerData: result.providerData
        });
        return { status, message: result.message || 'Payment did not complete' };
    }

    // Pending / verifying / awaiting_user
    return { status: 'pending', message: 'Awaiting your approval' };
});

// ─── 3. Webhook handler factory (DRY across providers) ───────────
function makeWebhookHandler(providerName) {
    return functions.https.onRequest(async (req, res) => {
        const provider = getProvider(providerName);

        if (!provider.verifyWebhookSignature(req)) {
            console.warn(`[${providerName}Webhook] Bad signature`);
            return res.status(401).send('Unauthorized');
        }

        const event = provider.parseWebhookEvent(req);
        if (!event) return res.status(200).send('Ignored event');     // not a relevant event type

        const { txRef, status, amount, providerData } = event;
        if (!txRef) return res.status(400).send('Missing tx_ref');

        const docRef = db.collection('subscriptionTransactions').doc(txRef);
        const snap   = await docRef.get();
        if (!snap.exists) {
            console.warn(`[${providerName}Webhook] Unknown tx_ref ${txRef}`);
            return res.status(200).send('Unknown tx_ref'); // 200 so provider stops retrying
        }
        const tx = snap.data();

        if (status !== 'successful') {
            await docRef.update({
                status,
                error:        event.message || 'Webhook reported failure',
                providerData,
                webhookAt:    admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(200).send('Recorded non-success');
        }

        if (!amountWithinTolerance(tx.amount, amount)) {
            await docRef.update({
                status:       'failed',
                error:        `Webhook amount mismatch: expected ${tx.amount}, got ${amount}`,
                providerData
            });
            console.warn(`[${providerName}Webhook] Amount mismatch on ${txRef}`);
            return res.status(200).send('Amount mismatch');
        }

        try {
            await activateSubscription({
                db,
                uid:           tx.ownerUid,
                tier:          tx.tier,
                billing:       tx.billing,
                txRef,
                paymentMethod: tx.paymentMethod,
                provider:      provider.name,
                providerData
            });
            return res.status(200).send('Activated');
        } catch (e) {
            console.error(`[${providerName}Webhook] Activation failed for ${txRef}:`, e);
            return res.status(200).send('Activation failed');
        }
    });
}

exports.flutterwaveWebhook = makeWebhookHandler('flutterwave');
exports.paystackWebhook    = makeWebhookHandler('paystack');

// ─── 4. Manual reactivation (admin-only) ─────────────────────────
exports.reverifySubscriptionPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in');
    const ADMIN_UIDS = ['uaiU5Afc1gMowVL37hTzJpSNqBT2'];
    if (!ADMIN_UIDS.includes(context.auth.uid))
        throw new functions.https.HttpsError('permission-denied', 'Admin only');

    const { txRef } = data || {};
    if (!txRef) throw new functions.https.HttpsError('invalid-argument', 'Missing tx_ref');

    const txDoc = await db.collection('subscriptionTransactions').doc(txRef).get();
    if (!txDoc.exists) throw new functions.https.HttpsError('not-found', 'Transaction not found');
    const tx = txDoc.data();

    const provider = getProvider(tx.provider);
    const result   = await provider.verify(txRef);

    if (result.status === 'successful') {
        await activateSubscription({
            db,
            uid:           tx.ownerUid,
            tier:          tx.tier,
            billing:       tx.billing,
            txRef,
            paymentMethod: tx.paymentMethod,
            provider:      provider.name,
            providerData:  result.providerData
        });
        return { status: 'activated' };
    }
    return { status: result.status };
});
