/**
 * Paystack provider for SafeSpend payments.
 *
 * Implements the Provider interface defined in `./base.js`.
 *
 * Required env vars:
 *   PSTK_SECRET_KEY  /  paystack.secret_key   (sk_test_... or sk_live_...)
 *
 * Webhook signature: HMAC-SHA512 of the raw request body using the secret
 * key, sent in the `x-paystack-signature` header. Paystack does NOT use a
 * separate webhook secret — the API secret key is the signing key.
 *
 * Mobile money (Ghana):
 *   POST /charge
 *   { email, amount: pesewas, currency: 'GHS',
 *     mobile_money: { phone, provider: 'mtn'|'vod'|'tgo' } }
 *
 * Card / Bank: uses Paystack Inline JS on the frontend
 * (https://js.paystack.co/v2/inline.js). This provider just reserves a
 * `reference` and lets the frontend invoke `PaystackPop.setup({...})`.
 *
 * Verification:
 *   GET /transaction/verify/:reference
 *
 * Amounts: Paystack uses subunits (pesewas for GHS, kobo for NGN). We
 * always convert to/from major units at the boundary so `expectedAmount`
 * and `verify().amount` are major-unit numbers.
 */

const functions = require('firebase-functions');
const fetch     = require('node-fetch');
const crypto    = require('crypto');

const PSTK_BASE = 'https://api.paystack.co';

function secretKey() {
    return process.env.PSTK_SECRET_KEY
        || (functions.config().paystack && functions.config().paystack.secret_key)
        || '';
}

async function pstkGet(path) {
    const r = await fetch(`${PSTK_BASE}${path}`, {
        headers: { Authorization: `Bearer ${secretKey()}` }
    });
    return r.json();
}
async function pstkPost(path, body) {
    const r = await fetch(`${PSTK_BASE}${path}`, {
        method:  'POST',
        headers: {
            Authorization:  `Bearer ${secretKey()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    return r.json();
}

// Paystack Ghana mobile-money provider codes
const NETWORK_MAP = {
    MTN:        'mtn',
    VODAFONE:   'vod',
    AIRTELTIGO: 'atl'
};

// Subunits per major unit
function toSubunits(amount, currency) {
    // GHS, NGN, USD, KES, ZAR all use 100 subunits per major unit on Paystack
    return Math.round(Number(amount) * 100);
}
function fromSubunits(subAmount) {
    return Number(subAmount) / 100;
}

// Paystack status mapping → SafeSpend canonical statuses
function mapStatus(pstkStatus) {
    const s = (pstkStatus || '').toLowerCase();
    if (s === 'success')   return 'successful';
    if (s === 'failed')    return 'failed';
    if (s === 'abandoned') return 'cancelled';
    if (s === 'reversed')  return 'failed';
    // 'ongoing', 'pending', 'pay_offline', 'send_otp', 'send_pin', 'send_phone',
    // 'send_birthday', 'send_addr' all mean: still in progress
    return 'pending';
}

// ─── Provider implementation ─────────────────────────────────────
async function initiateMomo({ uid, tier, billing, txRef, expectedAmount, phone, network, currency, email }) {
    const code = NETWORK_MAP[(network || '').toUpperCase()];
    if (!code) {
        throw new functions.https.HttpsError('invalid-argument', 'Unsupported mobile money network for Paystack');
    }
    if ((currency || 'GHS').toUpperCase() !== 'GHS') {
        // Paystack mobile money is Ghana-only at the moment.
        throw new functions.https.HttpsError('invalid-argument', 'Paystack mobile money currently supports GHS only');
    }

    const payload = {
        email,
        amount:       toSubunits(expectedAmount, 'GHS'),
        currency:     'GHS',
        reference:    txRef,
        mobile_money: { phone, provider: code },
        metadata:     { uid, tier, billing }
    };

    let resp;
    try {
        resp = await pstkPost('/charge', payload);
    } catch (e) {
        throw new functions.https.HttpsError('unavailable', `Paystack unreachable: ${e.message}`);
    }

    if (!resp.status) {
        throw new functions.https.HttpsError('failed-precondition',
            resp.message || 'Paystack rejected the charge', resp);
    }

    const display = resp.data?.display_text || resp.data?.message
                  || 'Approve the prompt on your phone to complete payment.';

    return {
        txRef,
        status:       'awaiting_user',
        instructions: display,
        providerData: resp.data || null,
        providerId:   resp.data?.id || null
    };
}

async function initiateCard({ uid, tier, billing, txRef, expectedAmount, currency, email }) {
    // Paystack inline-checkout doesn't need a server hit to start. The
    // frontend invokes PaystackPop.setup({ key, reference, amount, ... }).
    // We return the values it needs.
    return {
        txRef,
        amount:        expectedAmount,
        currency:      (currency || 'GHS').toUpperCase(),
        checkoutMeta:  { uid, tier, billing }
    };
}

async function verify(txRef) {
    const resp = await pstkGet(`/transaction/verify/${encodeURIComponent(txRef)}`);
    if (!resp.status || !resp.data) {
        return { status: 'pending', amount: null, providerData: resp };
    }
    const d = resp.data;
    return {
        status:       mapStatus(d.status),
        amount:       fromSubunits(d.amount || 0),
        providerData: d,
        message:      d.gateway_response || null
    };
}

function verifyWebhookSignature(req) {
    const key = secretKey();
    const sig = req.headers['x-paystack-signature'];
    if (!key || !sig) return false;

    // Paystack signs the RAW request body. Cloud Functions parses JSON
    // by default, so we use req.rawBody (Firebase exposes it on
    // onRequest handlers as a Buffer).
    const raw = req.rawBody
        ? req.rawBody.toString('utf8')
        : JSON.stringify(req.body || {});
    const computed = crypto.createHmac('sha512', key).update(raw).digest('hex');
    return computed === sig;
}

function parseWebhookEvent(req) {
    const event = req.body || {};
    // We only care about successful charges; ignore everything else.
    if (event.event !== 'charge.success') return null;

    const d = event.data || {};
    return {
        txRef:        d.reference,
        status:       mapStatus(d.status),
        amount:       fromSubunits(d.amount || 0),
        providerData: d,
        message:      d.gateway_response || null
    };
}

module.exports = {
    name:        'paystack',
    displayName: 'Paystack',
    initiateMomo,
    initiateCard,
    verify,
    verifyWebhookSignature,
    parseWebhookEvent
};
