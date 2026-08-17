# Native push notifications — Firebase setup (step by step)

The app is already wired for native Android push. To turn it on you create one
free **Firebase** project, register the two apps in it, and drop in two files:

- **`google-services.json`** (one per brand) → added to the APK build as a GitHub
  secret. This lets the app *receive* push.
- **A service-account key** (one JSON) → added to the server (Railway) as an env
  var. This lets the server *send* push.

You only do this once. Follow it in order.

---

## Part A — Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Add project** → name it e.g. `Warehouse Hub` → Continue.
3. Google Analytics is optional — you can turn it **off** → Create project → wait,
   then Continue.

## Part B — Register the two Android apps

Do this **twice** — once per brand — in the same project:

1. On the project overview, click the **Android** icon ("Add app").
2. **Android package name** — type the brand's package id exactly:
   - Razoryn: `uk.co.razoryn.warehouse`
   - Calibre: `uk.co.calibreautoparts.warehouse`
3. App nickname: `Razoryn Warehouse` / `Calibre Warehouse`. Leave the debug SHA-1
   blank (not needed for FCM). Click **Register app**.
4. Click **Download google-services.json**. Save it — you'll get one file per
   brand. **Keep them straight** (they differ per package name).
5. Skip the remaining "add SDK" steps (already handled by the app) → Continue → 
   Next → Continue to console.
6. Repeat 1–5 for the second brand.

## Part C — Add the google-services.json files to the APK build (GitHub secrets)

The build reads each brand's file from a repo secret (base64-encoded).

1. Base64-encode each file. On Mac/Linux:
   ```
   base64 -i google-services-razoryn.json | tr -d '\n' > razoryn.b64
   base64 -i google-services-calibre.json | tr -d '\n' > calibre.b64
   ```
   (On Windows use `certutil -encode`, or any base64 tool — the value must be a
   single line.)
2. In GitHub → the repo → **Settings → Secrets and variables → Actions → New
   repository secret**. Add:
   - Name `GOOGLE_SERVICES_JSON_RAZORYN`, value = contents of `razoryn.b64`.
   - Name `GOOGLE_SERVICES_JSON_CALIBRE`, value = contents of `calibre.b64`.

The **Build Android app** workflow automatically decodes the right secret per
brand and applies the Google Services Gradle plugin. (Without the secret it still
builds — just without native push.)

## Part D — Add the sender key to the server (Railway)

1. In Firebase console → the **gear icon** (top-left) → **Project settings** →
   **Service accounts** tab.
2. Click **Generate new private key** → **Generate key**. A JSON file downloads —
   this is the **service account** (it can send push for *both* brands because
   they're in the same project).
3. Turn it into a single line (so it fits an env var). On Mac/Linux:
   ```
   cat service-account.json | tr -d '\n'
   ```
4. In **Railway**, open **each** deployment (Razoryn and Calibre) →
   **Variables** → add:
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: the single-line JSON from step 3.
5. Redeploy each (Railway usually redeploys automatically on a variable change).

The server now sends every OS notification to the native app too (no-op until
this variable is set, so nothing breaks before then).

## Part E — Build & install the app, then test

1. In GitHub → **Actions → Build Android app → Run workflow** (pick the brand or
   `both`). Download the new APK artifact and install it on a device (see the main
   README). The new build contains the Firebase config, so the app can receive
   push.
2. Open the app and sign in. On first launch it asks for **notification
   permission** — allow it. The device now appears under **Activity → Registered
   app devices** with **Push: on**.
3. Trigger something that notifies (e.g. a new order/return) — the device should
   get an OS notification even with the app closed.

---

## Notes

- **One Firebase project, both brands** — register both package names in it and
  use the one service account for both servers. (You *can* use two separate
  projects if you prefer; then each server gets its own `FIREBASE_SERVICE_ACCOUNT`
  and each brand its own secret.)
- **What "native push" adds** over the existing web push: reliable delivery to the
  installed app on the handheld, shown by Android even when the app is closed, via
  Google's FCM — the standard for Android apps.
- **Nothing here is committed to the repo.** The keys live only in GitHub secrets
  and Railway variables. Never commit `google-services.json` or the service
  account key.
