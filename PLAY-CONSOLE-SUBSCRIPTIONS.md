# SafeSpend Subscriptions — Google Play Console Setup

This guide tells you exactly what to configure in Google Play Console
and Bubblewrap to switch from the in-app wallet-based mock payment to
**real Google Play Billing** for the v31 subscription system.

---

## What's already done in code (commit `v31`)

✅ Pricing config (single source of truth in `index.html` → `PRICING`)
✅ Plan picker UI (2 tiers × 2 billing cycles, Best Value badge, savings shown)
✅ Subscription data model on user profile (`profile.subscription`)
✅ Tier-active accessors (`isProActive()`, `isBusinessProActive()`)
✅ Backward-compat migration (existing `isPremium` users → grandfathered Pro/lifetime)
✅ Wallet-based mock purchase (debits user's in-app wallet, sets sub state)

What you'll do here: **swap the wallet debit for a real Play Billing call**
in the `purchaseSubscription()` function, after Play Console + Bubblewrap
are configured below.

---

## Step 1 — Decide on pricing in your local currency

The PRICING constant uses the user's chosen display currency for the in-app
mock. For Play Console you must specify USD prices (or your home currency)
once — Google auto-converts to every other supported currency.

| Tier | Monthly | Yearly | Yearly effective monthly | Yearly savings |
|---|---|---|---|---|
| **SafeSpend Pro** | $19.99 | **$235.08** | ~$19.59 | $4.80 (2%) |
| **Business Pro**  | $49.99 | **$587.88** | ~$49.00 | $12.00 (2%) |

To change pricing later, edit only the `PRICING` constant at the top of
`index.html`. All UI text and CTAs flow from it.

---

## Step 2 — Create the 4 subscription products in Play Console

1. Open https://play.google.com/console → select **SafeSpend** → **Monetize → Subscriptions**
2. Click **Create subscription** four times, with these IDs (case-sensitive):

| Subscription ID | Name | Description |
|---|---|---|
| `safespend.pro.monthly` | SafeSpend Pro (Monthly) | Track expenses, advanced AI insights, unlimited goals |
| `safespend.pro.yearly` | SafeSpend Pro (Yearly) | Save 2% — billed once a year |
| `safespend.business.monthly` | Business Pro (Monthly) | Adds business profile + invoicing |
| `safespend.business.yearly` | Business Pro (Yearly) | Save 2% — billed once a year |

3. For each, click **Add base plan**:
   - Pro Monthly:    **Auto-renewing**, billing period **P1M** (1 month), price **$19.99**
   - Pro Yearly:     **Auto-renewing**, billing period **P1Y** (1 year), price **$235.08**
   - Business Mo:    **Auto-renewing**, billing period **P1M**, price **$49.99**
   - Business Yr:    **Auto-renewing**, billing period **P1Y**, price **$587.88**

4. Add at least the 5 most-spoken-in-your-region languages for **Subscription benefits** + **Description** (copy the `features` arrays from the `PRICING` const in `index.html`).

5. Click **Activate** on each — they go live within ~1 hour.

> 💡 **Tip:** Add a **7-day free trial** on the Pro Monthly base plan (Play Console → base plan → Free trial). Boosts conversion by 30-60%.

---

## Step 3 — Enable Play Billing in Bubblewrap

Edit `twa-manifest.json` in your project folder:

```json
"features": {
    "playBilling": { "enabled": true }
}
```

Then rebuild the AAB:

```bash
bubblewrap update
bubblewrap build
```

Upload the new AAB to Play Console (bumps `appVersionCode`).

---

## Step 4 — Wire `purchaseSubscription()` to the Digital Goods API

The Digital Goods API is the browser API a TWA uses to talk to Play Billing.
Current `purchaseSubscription()` in `index.html` debits the in-app wallet.
For production, replace the wallet logic with this:

```javascript
async function purchaseSubscription() {
    const err  = document.getElementById('premium-error');
    const showErr = msg => { err.textContent = msg; err.classList.remove('hidden'); };

    const { tier, billing } = pickerState;
    const productId = `safespend.${tier}.${billing}`;
    // e.g. 'safespend.pro.yearly'

    if (!('getDigitalGoodsService' in window)) {
        return showErr('Digital Goods API not available — install via Play Store first');
    }

    try {
        const service = await window.getDigitalGoodsService(
            'https://play.google.com/billing'
        );

        // Show the Play Billing UI
        const paymentRequest = new PaymentRequest([{
            supportedMethods: 'https://play.google.com/billing',
            data: { sku: productId }
        }], { total: { label: 'SafeSpend', amount: { currency: 'USD', value: '0' } } });

        const response = await paymentRequest.show();
        const { purchaseToken } = response.details;
        await response.complete('success');

        // Acknowledge — REQUIRED within 3 days or Google auto-refunds
        await service.acknowledge(purchaseToken, 'repeatable');

        // Activate locally
        const startedAt = Date.now();
        const expiresAt = billing === 'yearly'
            ? startedAt + 365 * 86400000
            : startedAt + 30 * 86400000;

        profile.subscription = {
            tier:      tier,
            billing:   billing,
            startedAt: startedAt,
            expiresAt: expiresAt,
            playToken: purchaseToken      // store for verification
        };
        profile.isPremium = true;
        saveData();

        // Persist + verify on backend (recommended — see Step 5)
        await fetch('https://your-cloud-function/verifyPlayPurchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purchaseToken,
                productId,
                userId: firebase.auth().currentUser.uid
            })
        });

        closePremiumModal();
        showPayToast(`${PRICING[tier].badgeEmoji} Welcome to ${PRICING[tier].name}!`);
        updateUI();
    } catch (e) {
        if (e.name === 'AbortError') return;     // user cancelled
        console.warn('[Play Billing] Purchase failed:', e);
        showErr('Purchase failed. Try again.');
    }
}
```

---

## Step 5 — Server-side validation via Cloud Function

Client-side trust isn't enough — anyone could `localStorage` a fake
subscription. Add a Cloud Function that verifies the `purchaseToken`
with Google's API.

```javascript
// functions/verifyPlayPurchase.js
const functions = require('firebase-functions');
const { google } = require('googleapis');

exports.verifyPlayPurchase = functions.https.onCall(async (data, ctx) => {
    if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in');

    const { purchaseToken, productId } = data;
    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/androidpublisher']
    });
    const androidPublisher = google.androidpublisher({ version: 'v3', auth });

    const result = await androidPublisher.purchases.subscriptionsv2.get({
        packageName: 'com.safespend.app',
        token: purchaseToken
    });

    // Verify it's active and not refunded
    const subscription = result.data;
    if (subscription.subscriptionState !== 'SUBSCRIPTION_STATE_ACTIVE') {
        throw new functions.https.HttpsError('permission-denied', 'Subscription not active');
    }

    // Update Firestore user doc with verified subscription
    await admin.firestore().collection('users').doc(ctx.auth.uid).update({
        subscription: {
            tier: productId.includes('business') ? 'business' : 'pro',
            billing: productId.includes('yearly') ? 'yearly' : 'monthly',
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            playToken: purchaseToken
        }
    });

    return { ok: true };
});
```

**Deploy:**
```bash
firebase deploy --only functions:verifyPlayPurchase
```

**Required service account:** in Google Cloud Console, give your Firebase
Functions service account the `androidpublisher.subscriptions.get` permission
under **IAM → Edit roles**.

---

## Step 6 — Real-time Developer Notifications (RTDN)

When a user cancels, refunds, or their subscription expires, Google fires
a Pub/Sub notification. You need to listen so the app reflects the change.

1. Play Console → **Monetization setup → Real-time developer notifications**
2. Topic name: `projects/YOUR-PROJECT/topics/play-rtdn`
3. Create a Pub/Sub subscription pointing to a Cloud Function:

```javascript
exports.handlePlayRTDN = functions.pubsub.topic('play-rtdn').onPublish(async (msg) => {
    const data = JSON.parse(Buffer.from(msg.data, 'base64').toString());
    const sub = data.subscriptionNotification;
    if (!sub) return;

    // Notification types: 1=recovered, 2=renewed, 3=canceled, 5=on-hold,
    // 7=restarted, 13=expired
    if ([3, 13].includes(sub.notificationType)) {
        // Find user by purchaseToken
        const snap = await admin.firestore().collection('users')
            .where('subscription.playToken', '==', sub.purchaseToken).limit(1).get();
        if (!snap.empty) {
            await snap.docs[0].ref.update({
                'subscription.tier': null,
                'subscription.expiresAt': Date.now()
            });
        }
    }
});
```

---

## Step 7 — Subscription restoration (across devices / reinstalls)

When a user reinstalls or signs in on a new device, automatically restore
their subscription:

```javascript
async function restoreSubscriptions() {
    if (!('getDigitalGoodsService' in window)) return;
    const service = await window.getDigitalGoodsService('https://play.google.com/billing');
    const purchases = await service.listPurchases();

    for (const p of purchases) {
        if (p.productId.startsWith('safespend.')) {
            const [, tier, billing] = p.productId.split('.');
            profile.subscription = {
                tier, billing,
                startedAt: p.purchaseTime,
                playToken: p.purchaseToken
            };
            profile.isPremium = true;
            saveData();
            break;
        }
    }
}
// Call this on app load, after auth completes
```

Hook this into `_boot(user)` in `index.html` after `loadData()`.

---

## Step 8 — Handle failed transactions

Already covered in `purchaseSubscription()`:
- `AbortError` → user dismissed Play UI; silent
- Other errors → red toast with "Purchase failed. Try again."

For more granular handling, the `PaymentRequest` API throws codes you can map:

| Error | Cause | UX |
|---|---|---|
| `AbortError` | User cancelled | Silent close |
| `NotSupportedError` | Play Billing not available (sideloaded APK?) | "Install from Play Store to subscribe" |
| `InvalidStateError` | Already subscribed to a competing tier | "Switch via Play Store > Subscriptions" |

---

## Pre-launch checklist

- [ ] All 4 subscription products created + activated in Play Console
- [ ] `twa-manifest.json` has `playBilling: { enabled: true }`
- [ ] AAB rebuilt (`bubblewrap build`) with new `appVersionCode`
- [ ] AAB uploaded to **Internal testing** track first
- [ ] Add yourself as a license tester (Play Console → Setup → License testing)
- [ ] License testers can purchase without being charged real money
- [ ] `purchaseSubscription()` swapped from wallet to Digital Goods API
- [ ] `verifyPlayPurchase` Cloud Function deployed + service account configured
- [ ] `handlePlayRTDN` Cloud Function deployed + Pub/Sub subscription wired
- [ ] `restoreSubscriptions()` called on app boot
- [ ] Tested all 4 products in test mode (purchase, cancel, refund flows)

---

## Going live

1. Promote the AAB from Internal Testing → Production
2. Wait for Google review (1-3 days typically)
3. SafeSpend Pro and Business Pro now visible in Play Store

---

## Yearly discount calculation (for your records)

```
Monthly price × 12 × (1 - 0.02) = Yearly price

SafeSpend Pro:    19.99 × 12 × 0.98 = $235.08/yr
Business Pro:     49.99 × 12 × 0.98 = $587.88/yr

Customer saves:   monthly_price × 12 × 0.02
                  = $4.80/yr (Pro)
                  = $12.00/yr (Business)
```

To change the discount, edit `YEARLY_DISCOUNT_PCT` in `index.html`.

---

## Maintenance: changing prices later

1. Edit the `PRICING` constant in `index.html` → push change to web host (PWA users update instantly)
2. In Play Console, edit each base plan's price (price changes are queued; existing subscribers keep their old price for 365 days)
3. Update `appVersionCode` in `twa-manifest.json` and rebuild AAB if the change is significant enough that you want native users on the new version sooner

That's it. The subscription system is config-driven — pricing changes
require **zero code edits** beyond the `PRICING` constant.
