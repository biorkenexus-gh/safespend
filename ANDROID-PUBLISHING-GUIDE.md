# SafeSpend → Android / Google Play Store

A complete, copy-pasteable guide to wrap SafeSpend as a real Android app
and ship it to the Play Store. Plan for **2–4 hours of focused work** the
first time, plus **1–7 days** for Google's review.

> **Approach:** SafeSpend is a Progressive Web App. The fastest, cheapest,
> and most maintainable way to put it on the Play Store is via a
> **Trusted Web Activity (TWA)** — a thin Android shell that loads your
> live PWA fullscreen, with no browser bar. Updates ship instantly when
> you push to your web host (no Play Store re-review needed).

---

## 0 · Prerequisites — install once

| Tool | Why | Install |
|---|---|---|
| **Node.js 18+** | Runs Bubblewrap | https://nodejs.org |
| **Java JDK 17** | Android build needs it | https://adoptium.net |
| **Bubblewrap CLI** | The TWA generator | `npm install -g @bubblewrap/cli` |
| **Android Studio** *(optional)* | If you want to debug the AAB | https://developer.android.com/studio |

After installing, run `bubblewrap doctor` — it will tell you if anything
is missing and offer to install Android SDK + JDK automatically.

---

## 1 · Host the PWA on a real HTTPS URL

TWA REQUIRES a public HTTPS URL. You can't use `localhost` or `file://`.

**Free options (pick one):**

| Host | Setup time | URL format |
|---|---|---|
| **Netlify** *(easiest)* | 5 min | `https://safespend-app.netlify.app` |
| **Vercel** | 5 min | `https://safespend-app.vercel.app` |
| **Firebase Hosting** | 10 min | `https://safespend-b0a22.web.app` |
| **GitHub Pages** | 10 min | `https://biorkenexus-gh.github.io/safespend` |

### Netlify (recommended — drag-and-drop):

1. Go to https://app.netlify.com/drop
2. Drag the entire **SafeSpend Claude Code Project** folder onto the page
3. Done — copy the URL Netlify gives you (looks like `https://thunder-blah.netlify.app`)
4. Optional: change the site name in **Site settings → General → Change site name** to `safespend-app`
5. Optional: add a custom domain like `safespend.app` in **Domain management**

> **Important:** add the same URL to Firebase Console → Authentication →
> Settings → Authorized domains — otherwise Google Sign-In will fail in
> the published app.

---

## 2 · Generate the AAB with Bubblewrap

### A. Initialize the TWA project

```bash
cd "C:\Users\THE OAKS INTER GROUP\Desktop\SafeSpend Claude Code Project"

# Replace YOUR-DOMAIN.com with your real hosted URL
# (the one from step 1 above, without https:// or trailing slash)
bubblewrap init --manifest https://YOUR-DOMAIN.com/manifest.json
```

Bubblewrap will ask you a series of questions. Use these answers:

| Question | Answer |
|---|---|
| Domain | `YOUR-DOMAIN.com` *(no `https://`)* |
| Application name | `SafeSpend` |
| Short name | `SafeSpend` |
| Display mode | `standalone` |
| Status bar color | `#1E3A8A` |
| Splash screen color | `#1E3A8A` |
| Icon URL | `https://YOUR-DOMAIN.com/icon-512.svg` |
| Start URL | `/` |
| Application ID | `com.safespend.app` |
| Version code | `1` |
| Version name | `1.0.0` |
| Signing key path | accept default (`android.keystore`) |
| Key alias | `android` |
| Key password | **make a strong one and write it down** |
| Keystore password | **make a strong one and write it down** |

> **🔴 CRITICAL:** Back up the generated `android.keystore` file AND your
> two passwords. If you lose them, you can never publish updates to your
> own app — Google will not let anyone else upload with the same package
> ID. Store both in a password manager AND on a separate USB drive.

### B. Build the AAB

```bash
bubblewrap build
```

This produces two files:
- **`app-release-bundle.aab`** — upload this to Google Play
- **`app-release-signed.apk`** — for sideloading / testing on real devices

### C. Get the SHA-256 fingerprint for asset links

```bash
bubblewrap fingerprint
```

Copy the SHA-256 line — it looks like
`AB:CD:EF:12:34:56:...` (64 hex chars separated by colons).

### D. Update assetlinks.json with the real fingerprint

1. Open `.well-known/assetlinks.json` in your project folder
2. Replace `REPLACE_WITH_YOUR_SHA256_FINGERPRINT_FROM_BUBBLEWRAP` with the fingerprint from step C
3. Re-deploy your hosted PWA (drag the folder to Netlify again)
4. Verify: `https://YOUR-DOMAIN.com/.well-known/assetlinks.json` returns the JSON

> **Why this matters:** without a valid `assetlinks.json` matching your
> app's signing fingerprint, the TWA will show an ugly Chrome address bar
> at the top instead of running truly fullscreen.

---

## 3 · Test the APK on a real device (highly recommended before publishing)

### Option A — Install via USB:

1. Enable **Developer Mode** on your phone:
   Settings → About → tap **Build number** 7 times
2. Settings → Developer Options → enable **USB debugging**
3. Connect phone to computer via USB
4. Run: `adb install app-release-signed.apk`
5. Open SafeSpend on your phone — verify Google Sign-In works, navigation works, no crashes

### Option B — Install via direct download:

1. Upload `app-release-signed.apk` to Google Drive
2. Share the link to your phone
3. Open on phone, allow "Install from unknown sources" if prompted
4. Install, test

---

## 4 · Create a Google Play Developer account

1. Go to https://play.google.com/console
2. Sign in with the Google account you want to use as your developer identity
3. Pay the **one-time $25 USD registration fee**
4. Fill out developer profile (name, address, payment info for paid apps)
5. Wait for verification (typically same-day, sometimes 24h)

---

## 5 · Create the app on Play Console

1. Play Console → **Create app**
2. Fill in:
   - **App name:** SafeSpend
   - **Default language:** English (United States)
   - **App or game:** App
   - **Free or paid:** Free
   - Accept the declarations
3. Click **Create app**

### Required pre-launch setup (in the left sidebar)

You'll see a checklist. Complete each section:

| Section | What to fill |
|---|---|
| **App access** | Mark "All functionality available without restrictions" (or provide test login if you gate features) |
| **Ads** | "No, my app does not contain ads" |
| **Content rating** | Take the questionnaire — SafeSpend = Finance, no violent/adult content, → rated **Everyone** |
| **Target audience** | 18+ (it's a finance app) |
| **News app** | No |
| **COVID-19 contact tracing** | No |
| **Data safety** | List Firebase Auth (email, name, profile photo), Firestore (transaction data, encrypted at rest, not shared with third parties) |
| **Government apps** | No |
| **Financial features** | YES — declare it manages money / is a finance product |

### Store listing

| Field | Value |
|---|---|
| **App name** | SafeSpend |
| **Short description** | Smart weekly budgeting + Mobile Money wallet + business invoicing (max 80 chars) |
| **Full description** | (paste your README + feature list, up to 4000 chars) |
| **App icon** | 512×512 PNG (export `logo.png` at 512×512, transparent background) |
| **Feature graphic** | 1024×500 PNG (use the gradient + logo design from your splash screen) |
| **Phone screenshots** | 8 screenshots, 1080×1920 portrait — see screenshot guide below |
| **App category** | Finance |
| **Tags** | budgeting, money, wallet, invoice, mobile money |
| **Email** | biorkenexus@gmail.com |
| **Privacy policy URL** | required — generate at https://app-privacy-policy-generator.firebaseapp.com and host the result on your PWA domain |

---

## 6 · Upload the AAB

1. Play Console → **Production** (or **Internal testing** for first run)
2. **Create new release**
3. Drag in `app-release-bundle.aab`
4. **Release name** auto-fills as `1 (1.0.0)`
5. **Release notes:** "Initial release — track expenses, manage budget, send/receive Mobile Money."
6. Click **Save → Review release → Start rollout to Production**

> **First-time tip:** use the **Internal testing** track first. Add your
> own email as a tester, install via the link Google sends, verify
> everything works on a real Play Store install. Then promote to
> Production with one click.

---

## 7 · Wait for Google review

- **Typical:** 1-3 days for first submission
- **Maximum:** 7 days
- **Status:** Play Console → All apps → SafeSpend → Publishing overview

You'll get an email when it's approved. The app then appears in Play
Search within ~1 hour, and is installable via the share link Google
provides (`https://play.google.com/store/apps/details?id=com.safespend.app`).

---

## 8 · After publishing: pushing updates

The beauty of TWA: **PWA updates are instant**. You only need to upload a
new AAB if you change:
- App name, icon, package ID, version code
- TWA configuration (orientation, theme color, etc.)

For everything else (bug fixes, new features, content):
1. Edit `index.html` / commit / push
2. Re-deploy to your web host (drag to Netlify again, or `firebase deploy`)
3. Users get the update automatically on next app launch

To bump the AAB version:
```bash
# Edit twa-manifest.json: bump appVersionCode by 1, update appVersionName
bubblewrap update     # picks up the new version
bubblewrap build      # generates new AAB
# Upload to Play Console → Production → Create new release
```

---

## 📸 Screenshot capture guide

Capture these 8 screens at **1080×1920 portrait** (use phone screenshot,
or browser DevTools → Device toolbar → "Galaxy S20"). Add overlay text
in Canva or Figma.

| # | Screen | Overlay text |
|---|---|---|
| 1 | Splash mid-animation | "Track. Save. Thrive." |
| 2 | Home with Health Score gauge | "Know your money instantly" |
| 3 | Add Expense with auto-cat hint | "Log expenses in seconds" |
| 4 | Wallet balance + 4 actions | "Send & receive Mobile Money" |
| 5 | Analytics charts | "See where it goes" |
| 6 | Business dashboard with profit | "Built for entrepreneurs" |
| 7 | Refer & Earn with code chip | "Earn while you save" |
| 8 | Dark mode (any screen) | "Easy on the eyes" |

Use https://previewed.app or https://mockuphone.com to add a Pixel/Galaxy
device frame for premium presentation.

---

## 🔐 Security best practices (for production)

1. **Move Firebase API key to environment variables** — currently it's
   hardcoded in `index.html`. While Firebase Web API keys are *technically*
   safe to expose (security relies on Firestore rules + auth, not key
   secrecy), best practice is to load from a config endpoint.

2. **Restrict the API key to your domain** in Google Cloud Console:
   - Go to https://console.cloud.google.com/apis/credentials
   - Edit your Firebase Web API key
   - Application restrictions → HTTP referrers → add `YOUR-DOMAIN.com/*`
   - This prevents someone from copying your key and using it elsewhere

3. **Real Mobile Money / Bank API integration** when you go live:
   - All `processMomoTransaction`, `processBankTransfer`, etc. mocks
     MUST be replaced with Cloud Function calls
   - Provider secret keys (Paystack, Flutterwave, MTN MoMo) NEVER go in
     client code — only in Cloud Functions environment config
   - Set up webhook endpoints to confirm async payments

4. **Firestore rules** — already production-grade in your `firestore.rules`.
   Re-verify after each schema change. Test with the Rules Playground.

5. **Data Safety declaration on Play Console** must be accurate:
   - Email + display name + profile photo: collected via Google Sign-In
   - Transaction data: stored in Firestore, owner-only access, encrypted in transit (HTTPS) and at rest (Firebase default)
   - NOT collected: precise location, contacts, photos, microphone

6. **Optional enhancements:**
   - Enable Firebase App Check (blocks unauthorized API access)
   - Enable Firestore TTL for old transactions (auto-cleanup)
   - Set up daily Firestore backups (Firebase Console → Backups)

---

## ✅ Pre-launch checklist

Before you click "Start rollout to Production":

- [ ] PWA hosted on stable HTTPS URL
- [ ] `assetlinks.json` deployed at `/.well-known/assetlinks.json` with real SHA-256
- [ ] Firebase Authorized Domains includes your hosted URL
- [ ] Firestore rules published (latest from `firestore.rules`)
- [ ] Tested AAB install on real Android device — Google Sign-In works
- [ ] All 8 screenshots prepared
- [ ] Privacy policy URL working
- [ ] App icon (512×512) and feature graphic (1024×500) ready
- [ ] Keystore + passwords backed up to TWO locations
- [ ] Content rating questionnaire completed
- [ ] Data safety form completed accurately
- [ ] Internal testing track tested with real install link

---

## 📞 If something goes wrong

| Symptom | Fix |
|---|---|
| App opens with Chrome address bar visible | `assetlinks.json` not matching — re-check SHA-256 fingerprint and re-deploy |
| Google Sign-In fails after install | Add app's hosted URL to Firebase → Authentication → Authorized domains |
| Splash screen flashes white before logo | Increase `splashScreenFadeOutDuration` in `twa-manifest.json` to 500 |
| Play Console rejects AAB | Check version code is higher than previous release |
| "Bubblewrap build failed: missing JDK" | `bubblewrap doctor` — let it auto-install |
| App icon looks cropped on some devices | Use the maskable icon variant — already configured in your manifest |

---

## 🎯 What ships with this guide

Files in your project ready to use:
- **`manifest.json`** — Play-Store-compliant PWA manifest with shortcuts and 5 icon variants
- **`twa-manifest.json`** — Bubblewrap config template (replace `YOUR-DOMAIN.com` then run `bubblewrap init`)
- **`.well-known/assetlinks.json`** — Asset Links template (paste real SHA-256 after Bubblewrap init)
- **`index.html`** — Updated `<head>` with full Android + iOS install metadata, Open Graph, Twitter Card

Good luck with the launch! 🚀
