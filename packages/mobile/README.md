# SecureReel DIT Mobile

Android is the active beta target. iOS/iPadOS adapters are preserved work in progress and are not buildable release targets yet.

## Android beta

- Android 12 (API 31) or newer. The first test package targets ARM64.
- Native bounded-memory copying to one or two independent storage volumes, with seven hash algorithms. A final filename appears only after the staging file is closed and independently reread.
- Source inventory length and file metadata changes are checked before publication. Existing files and incompatible parent names are collisions; they are never replaced.
- Explicit folder grants use Android's system picker. Copy additionally requires explicit All files access and an eligible local external-storage provider. Press **检测拷贝支持** in copy mode to test target-only atomic no-overwrite support. Merely selecting/refreshing roots and verify-only jobs do not probe by writing.
- Unsupported/cloud document providers permit read-only verification when seekable; they do not provide copying. Separate source/target volumes are required for copying.
- SQLite stores jobs, captured files, results and commit intents. After an interruption, resume independently rereads outputs with matching durable intent and source hash. Arbitrary pre-existing files remain collisions.
- Terminal jobs generate immutable HTML, JSON, PDF and the selected manifest in the application archive. Sharing requires a user action. Report copies to target disks are not implemented yet.
- Android background execution limits still apply. Interrupted jobs require explicit recovery; a foreground service does not promise unlimited background time.

## Desktop companion

Use the desktop Settings page to enable the LAN service and approve exact source/target folders. In mobile **电脑监控 → 设置**, scan its short-lived QR and confirm the computer identity. Manual setup JSON is available as a collapsed fallback. The native client checks the exact TLS certificate fingerprint before sending credentials. Pairing tokens are encrypted with Android Keystore. No cloud service is used.

Desktop jobs run on the desktop; independent jobs run on Android. Snapshots replace cached progress after reconnect. Creation/control and project-copy retries retain durable request identities, including after restart. Reconcile an uncertain request against the desktop task/project list before explicitly abandoning the phone retry record.

QR display and on-device scanning are implemented; physical optical acceptance remains separate. Full desktop protocol and security details are in `../../src/main/mobile-companion/README.md`.

## Build and verification

Install Node.js 22.11+ and JDK 17, then install mobile dependencies in this directory. Configure Android SDK/NDK/CMake from `android/build.gradle` and `android/local.properties` (local file, not committed).

```sh
npm ci
npm run type-check
npm run lint
npm run test:domain
npm test
JAVA_HOME=/path/to/jdk17 npm run test:host
cd android
./gradlew :app:assembleBeta -PreactNativeArchitectures=arm64-v8a
```

`beta` bundles JavaScript and uses the conventional Android debug test certificate with a separate `.beta` application ID. It runs without a Metro server. `release` is unsigned until the owner configures a private release key. The debug build requires Metro and is for development only.

The root desktop suite is verified separately with `npm run verify`. Native core host tests are in `../mobile-core/test-host.sh`. Host tests do not substitute for Android instrumentation or physical USB/SD/exFAT tests.

## Distribution status

This is a local development beta, not a store submission. The current source license is GPL-3.0-only; retained source and dependency notices apply. Ownership and release-rights clearance must be completed before external distribution. No CODEX/ARRI proprietary executables, HDE encoder, desktop FFmpeg, cloud upload or telemetry are included in the mobile package.

Physical storage removal, Android foreground-service timeout, large-card endurance, device-specific USB/provider behavior and phone/tablet visual acceptance remain required before production use with unique footage.

## Android 2.0.8 beta

Distinct on-phone offload and desktop monitor modes retain separate drafts. Mother projects include crew roles, lens details and task snapshots; copies between devices create new projects. Settings and offline help persist locally. Pairing scans a short-lived QR and asks for desktop identity confirmation; pinned TLS and durable mutation receipts remain mandatory. Native notifications, partial CPU wake locks and resumable interruption improve background reliability without bypassing Android service limits.

The launcher uses the existing desktop cabinet PNG. In 2.0.8, both macOS and Windows desktop candidates integrate the companion service on top of the 2.0.7 engine; published 2.0.7 desktop installers remain unchanged. Physical USB media, OEM background restrictions and Windows device execution still require dedicated acceptance evidence.

The project page opens the list before the editor. Crew and lens summaries lead to searchable lists and one-item editors; removal history remains with the unsaved mother draft until save. Mother drafts are session-only and scoped to local storage or the paired computer identity. Replacing a dirty draft, including restoring an uncertain request, requires an explicit in-app choice.

One appearance choice applies to local pages and desktop-monitor pages, including the connection settings. Copy defaults, permissions, and local storage preferences remain isolated to on-phone work. Theme changes take effect immediately and native saves execute in order. Monitor settings expose connection/device/diagnostic options. Offline help has a topic directory, contextual links and skippable three-step onboarding. Press/page/progress feedback respects reduced motion. The custom scanner keeps phones portrait and tablets in the entering orientation, removes the laser overlay and offers a torch where available. Camera permission is requested only when scanning.
