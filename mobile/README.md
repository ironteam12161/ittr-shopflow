# ITTR ShopFlow phone app

The phone app is a native Android/iOS shell ([Capacitor](https://capacitorjs.com)) that opens the live ShopFlow site
(`https://web-production-44bc4.up.railway.app`) full screen. Every website update shows up in the app right away,
so the app only needs a new build when something in this folder changes (name, icon, permissions, site address).

What the app adds over the browser:
- Its own icon, and it opens with no browser bar.
- Mechanics stay logged in when the app is closed. The website does this only inside the app (the user agent ends with
  `ITTRShopFlowApp`); in a normal browser the login still ends with the tab.
- Camera (barcode scanner, finding photos, invoice photos) and microphone (voice notes) permissions.
- A "No connection" screen with **Try again** when the phone is offline.

## Getting the app to mechanics (Android)
Send them **`https://web-production-44bc4.up.railway.app/app`**. That page has the download button and the install
steps. The button downloads the latest build from the `android-latest` GitHub release.

## Builds
`.github/workflows/android-app.yml` builds the APK on GitHub (the Android SDK is not needed locally):
- A pull request that changes `mobile/` attaches the APK to the workflow run (**Actions → run → Artifacts**).
- A merge to `main` that changes `mobile/`, or **Actions → ITTR Android App → Run workflow**, also publishes it as the
  `android-latest` release, which the `/app` page links to.

### Signing key (one time)
Updates install over the old app only if every build is signed with the same key. Add these two repository secrets
(**Settings → Secrets and variables → Actions → New repository secret**):

| Secret | Value |
|---|---|
| `ITTR_KEYSTORE_BASE64` | contents of `ITTR_KEYSTORE_BASE64.txt` (the keystore, base64) |
| `ITTR_KEYSTORE_PASSWORD` | contents of `ITTR_KEYSTORE_PASSWORD.txt` |

Keep `shopflow-release.jks` and its password somewhere safe (not in this repository — it is public). Without the
secrets the workflow still builds, but signs with a throw-away key, so each new build has to be installed after
uninstalling the old one.

## iPhone
The `ios/` project is ready, but Apple only allows installing apps through the Apple Developer Program ($99/year,
via TestFlight or the App Store), and the build needs a Mac (or a macOS GitHub runner) with Xcode. Until then iPhone
users use Safari → Share → **Add to Home Screen**, which opens ShopFlow full screen with the shop icon.

## Changing things
- Site address, app name or id: `capacitor.config.json`, then `npx cap sync`.
- Icon / splash: replace `assets/icon-only.png`, `assets/icon-foreground.png`, `assets/splash.png`, then
  `npx capacitor-assets generate --android --ios --iconBackgroundColor '#111827' --splashBackgroundColor '#111827'`.
- Permissions: `android/app/src/main/AndroidManifest.xml` (and `ios/App/App/Info.plist` for iPhone).
