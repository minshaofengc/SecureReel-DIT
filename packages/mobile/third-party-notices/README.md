# Mobile dependency notices

Direct runtime components: React19.2.3 (MIT), React Native0.87.1 (MIT), react-native-safe-area-context5.9.0 (MIT), Zod4.6.5 (MIT), and official xxHash0.8.3 (BSD-2-Clause). Original license texts are retained alongside this file. xxHash source provenance is recorded in `../../mobile-core/vendor/README.md`.

The application source is GPL-3.0-only; see `../LICENSE`. No HDE implementation, CODEX/ARRI proprietary binary, or desktop FFmpeg is bundled. Babel namespace-transform7.29.7 is an MIT build-time component.

These direct-component notices are not a complete release SBOM. React Native's Android/Maven/Hermes/native transitive notices and required corresponding sources must be inventoried against the actual release package before external distribution. Local beta test signing is not a production release signature.

Official compatibility evidence: [safe-area5.8 API removal and5.8.1 RN0.87 fixes](https://github.com/AppAndFlow/react-native-safe-area-context/releases), [safe-area5.9 AGP9](https://github.com/AppAndFlow/react-native-safe-area-context/releases/tag/v5.9.0), [Babel namespace transform](https://babeljs.io/docs/babel-plugin-transform-export-namespace-from).

Android QR scanner: JourneyApps zxing-android-embedded 4.3.0 and ZXing core 3.4.1; Apache-2.0. Full upstream COPYING/LICENSE preserved in JourneyApps-LICENSE.txt and ZXing-LICENSE.txt. No account, telemetry or camera upload is used.
