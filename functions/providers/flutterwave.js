/**
 * Flutterwave provider for SafeSpend payments.
 *
 * Implements the Provider interface defined in `./base.js`.
 *
 * Required env vars (any one of):
 *   FLW_SECRET_KEY  /  flutterwave.secret_key   (FLWSECK_TEST-... or FLWSECK-...)
 *   FLW_SECRET_HASH /  flutterwave.secret_hash  (any random ≥16 chars; must
 *                                                 match value in FLW dashboard
 *                                                 → Settings → Webhooks)
 *
 * Mobile money endpoints used:
 *   POST /charges?type=mobile_money_ghana   (MTN, VODAFONE, AIRTELTIGO)
 *   POST /charges?type=mpesa                (Kenya)
 *
 * Card flow uses Flutterwave Inline JS on the frontend
 * (https://checkout.flutterwave.com/v3.js) — this provider just reserves
 * a tx_ref so the webhook can match.
 */

const functions = require('firebase-functions');
const fetch     = require('node-fetch');

const FLW_BASE = 'https://api.flutterwave.com/v3';

function secretKey() {
    return process.env.FLW_SECRET_KEY
        || (functions.config().flutterwave && functions.config().flutterwave.secret_key)
        || '';
}
function secretHash() {
    return process.env.FLW_SECRET_HASH
        || (functions.config().flutterwave && functions.config().flutterwave.secret_hash)
        || '';
}

async function flwGet(path) {
    const r = await fetch(`${FLW_BASE}${path}`, {
        headers: { Authorization: `Bearer ${secretKey()}` }
    });
    return r.json();
}
async function flwPost(path, body) {
    const r = await fetch(`${FLW_BASE}${path}`, {
        method:  'POST',
        headers: {
            Authorization:  `Bearer ${secretKey()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    return r.json();
}

const ALLOWED_NETS = ['MTN', 'VODAFONE', 'AIRTELTIGO', 'MPESA'];

function pickEndpoint(network) {
    const net = (network || '').toUpperCase();
    if (net === 'MPESA') return { endpoint: '/charges?type=mpesa', providerEnum: null };
    return { endpoint: '/charges?type=mobile_money_ghana', providerEnum: net };
}

// ─── Provider implementation ─────────────────────────────────────
async function initiateMomo({ uid, tier, billing, txRef, expectedAmount, phone, network, currency, email }) {
    if (!ALLOWED_NETS.includes((network || '').toUpperCase())) {
        throw new functions.https.HttpsError('invalid-argument', 'Unsupported mobile money network for Flutterwave');
    }
    const { endpoint, providerEnum } = pickEndpoint(network);

    const payload = {
        tx_ref:       txRef,
        amount:       String(expectedAmount),
        currency:     currency || 'GHS',
        email,
        phone_number: phone,
        ...(providerEnum ? { network: providerEnum } : {}),
        meta: { uid, tier, billing }
    };

    let resp;
    try {
        resp = await flwPost(endpoint, payload);
    } catch (e) {
        throw new functions.https.HttpsError('unavailable', `Flutterwave unreachable: ${e.message}`);
    }

    if (resp.status !== 'success') {
        throw new functions.https.HttpsError('failed-precondition',
            resp.message || 'Flutterwave rejected the charge', resp);
    }

    return {
        txRef,
        status:       'awaiting_user',
        instructions: resp.meta?.authorization?.note || 'Approve the prompt on your phone to complete payment.',
        providerData: resp.data || null,
        providerId:   resp.data?.id || null
    };
}

async function initiateCard({ uid, tier, billing, txRef, expectedAmount, currency, email }) {
    // Flutterwave's inline checkout doesn't need an API call to start —
    // the SDK uses the tx_ref directly. We just return what the frontend
    // needs to invoke FlutterwaveCheckout.
    return {
        txRef,
        amount:        expectedAmount,
        currency:      currency || 'USD',
        checkoutMeta:  { uid, tier, billing }
    };
}

async function verify(txRef) {
    const resp = await flwGet(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    if (resp.status !== 'success' || !resp.data) {
        return { status: 'pending', amount: null, providerData: resp };
    }
    const fd     = resp.data;
    const status = (fd.status || '').toLowerCase();   // successful | failed | cancelled | pending
    return {
        status:       status || 'pending',
        amount:       Number(fd.amount || 0),
        providerData: fd,
        message:      fd.processor_response || null
    };
}

function verifyWebhookSignature(req) {
    const expected  = secretHash();
    const signature = req.headers['verif-hash'];
    return !!expected && signature === expected;
}

function parseWebhookEvent(req) {
    const event = req.body || {};
    if (event.event !== 'charge.completed') return null;       // ignored
    const fd = event.data || {};
    return {
        txRef:        fd.tx_ref,
        status:       (fd.status || '').toLowerCase(),
        amount:       Number(fd.amount || 0),
        providerData: fd,
        message:      fd.processor_response || null
    };
}

module.exports = {
    name:        'flutterwave',
    displayName: 'Flutterwave',
    initiateMomo,
    initiateCard,
    verify,
    verifyWebhookSignature,
    parseWebhookEvent
};
