# Contributing to SecureReel DIT

Thanks for taking a look. This document covers what you need to build, test and
package the project, and the few rules that are not negotiable.

SecureReel DIT is a free, open-source **DIT (Digital Imaging Technician)** tool:
multi-target camera media offload, hash verification, ASC MHL manifests, and
immutable PDF/JSON/HTML reports. Target users are independent filmmakers, DITs
and data wranglers.

Licensed under **GPL-3.0-only**. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.

---

## Requirements

- **Node.js ≥ 22.13** and npm. (The app stores data with the built-in
  `node:sqlite` module, which needs the experimental flag before 22.13.)
- **macOS 13+** or **Windows 10/11 (x64)** to run the app.
- No native toolchain is required — the project has zero native modules and only
  two runtime dependencies (`hash-wasm`, `zod`).

## Getting started

```bash
# 1. Bundled FFmpeg/ffprobe (~392 MB) are not in git. Fetch them once.
sh scripts/fetch-ffmpeg.sh

# 2. Install
npm install

# 3. Run in development
npm run dev
```

If `npm install` leaves `node_modules/electron/dist` empty (common on slow or
proxied networks), fetch the runtime explicitly:

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js
```

## Checks

| Command | What it does |
| --- | --- |
| `npm run type-check` | TypeScript, main/preload and renderer projects |
| `npm run lint` | ESLint |
| `npm run test` | Vitest (unit + integration) |
| `npm run format` | Prettier write |
| `npm run verify` | Everything above, plus the pipeline and app smoke runs |

`npm run verify:pipeline` exercises the real engine end to end against a
throwaway database; `npm run verify:app` boots the packaged-style app headlessly
and writes a screenshot to `.verify-output/`.

### XSD validation

The ASC MHL manifest tests validate output against the official XSD using
Python + `lxml`. That interpreter is **not** hardcoded — point the suite at one
if you have it, otherwise those cases skip instead of silently passing:

```bash
SECUREREEL_XSD_PYTHON=/path/to/python npm test
```

## Packaging

```bash
npm run dist:mac   # dmg + zip, universal (Intel + Apple silicon)
npm run dist:win   # NSIS installer, portable exe and zip
npm run check:win-assets   # hard gate, run before shipping a Windows build
```

Windows packages can be built from macOS — no Wine and no Windows machine
required. That relies on the pinned `electron-builder` version; if a build log
ever mentions `wine`, treat it as a signal that something changed and re-check.

`check:win-assets` exists because `electron-builder` merely *warns* when a
`from` directory is missing, and would otherwise ship a package with no FFmpeg.
It also checks that the binaries really are PE executables (`MZ` header).

## Architecture at a glance

Four layers, strictly separated:

| Path | Responsibility |
| --- | --- |
| `src/shared/` | Pure types, constants, Zod schemas, formatting. No Node, no DOM — so it is unit-testable and usable from both sides. |
| `src/main/` | Copy engine, database, reports, external tool adapters. |
| `src/preload/` | The only IPC bridge. Exposes a narrow, explicit API. |
| `src/renderer/` | React UI. Runs sandboxed with `contextIsolation`, no Node integration. |

Rules that follow from this:

- **Hashing runs in the main process.** Never move it into the renderer.
- **All external commands go through `src/main/exec.ts`** — argument arrays,
  `shell: false`, timeouts and output caps. Do not spawn commands elsewhere.
- **Platform differences belong in `src/main/platform.ts`** (and
  `src/renderer/src/platform.ts`), as pure functions. Do not scatter
  `process.platform` checks; keeping them in one place is what makes the
  Windows branches testable on macOS.

## Compliance red lines

These are not style preferences. Violating any of them makes the project
undistributable.

1. **Never implement HDE encoding.** Do not write the algorithm.
   - On macOS, read `.arx` and HDE `.mxf` through the CODEX Device Manager
     virtual file system. (Those files showing as 0 bytes in Finder is expected.)
   - For ALEXA 35 / 35 Xtreme / ALEXA 265, shell out to the official ARRIRAW HDE
     Transcoder CLI (`arrirawhde`).
2. **Never reverse-engineer** CODEX Device Manager or the ARRIRAW HDE Transcoder.
3. **Never bundle** any proprietary CODEX or ARRI binary in a distribution.
4. **Degrade gracefully.** If the official tooling is missing, fall back to plain
   ARRIRAW copy + hash verification, explain why, and prompt the user — never
   fail silently, and never pretend the capability exists.
5. Code comments and docs must state that HDE encoding is provided by ARRI/CODEX
   official free tools.

## Product guarantees

Changes must not weaken these:

- Never overwrite a same-named file on a target drive. Never delete source media.
  Never upload telemetry.
- Report revisions are immutable: `R001`, `R002`, … each in its own directory.
- A file is only considered settled on a target once it has been read back and
  verified. **Do not remove the read-back for speed.**
- One failing target is isolated; healthy targets keep running. A **name
  collision is not media failure** — only I/O faults quarantine a drive, and
  verify-only mode never does.
- Verify-only mode reads and compares; it writes and deletes nothing.

## Code style

- Named exports.
- `async`/`await` over bare promises.
- Validate all user input and every external command argument with Zod.
- No `console.log` in production code — use the structured logger.
- Error messages must not leak internal details.

## Review checklist

- Any inline HDE encoding attempt → must call the external tool instead.
- Any unvalidated external command → must be parameterised, to prevent injection.
- Missing input validation.
- Synchronous I/O on the main thread.

## Language

The UI ships in Simplified Chinese and English. Report templates are intentionally
Chinese-only: they are formal delivery records for Chinese-language film crews.
Repository documentation is written in English.
