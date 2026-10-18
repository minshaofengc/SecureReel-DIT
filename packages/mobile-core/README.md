# SecureReel mobile native core

C++17 streaming file transfer with one or two independently verified targets.
The default algorithm is xxhash64. Supported algorithms are xxhash64, xxh3,
xxh128, md5, sha1, sha256 and asc-c4. The source is read once, followed by a
separate read of every destination staging object. A destination final name is
created only after its byte count and hash match the source.

`include/securereel/core.hpp` defines the platform storage and digest contracts.
Reader and writer calls may return short counts. Readers return zero at EOF;
writers must throw on a write failure and must never return zero. Readers and
writers throw on permission revocation and media removal. `finish` flushes and
closes the staging writer. `readback` opens a fresh reader. `commitNoReplace`
must create the final name atomically without replacing any object. Unsupported
provider semantics must reject `stage`, rather than emulate a check then rename.
Stage destruction removes only that stage's private, uncommitted object.

Call `processFile` on a native worker, never the UI thread. File data remains in
native memory. Buffer size is bounded to 8 MiB; the default is 1 MiB. Platform
jobs must persist terminal per-file results, isolate failed target resources for
later files, and serialize immutable reports only once the job is terminal.
A collision or content mismatch is distinct from an I/O failure. Verify-only
uses `openRead` exclusively and never invokes staging. Do not classify a target
verified if its result is absent or the source failed.

Cancellation is cooperative at every read/write and before every commit. An
already committed verified target remains verified when a later target is
cancelled. Device I/O calls must themselves have suitable revocation handling;
this core cannot interrupt a blocked provider operation. A failed source leaves
all uncommitted targets unverified. No source deletion API exists.

Supply the inventoried source length as `Options.expectedBytes`. Readers implement
`validateUnchanged` to detect size/mtime/ctime changes; the source descriptor stays
open and is checked before each publication, including after durable journal I/O.
Android forwards the captured length for both copy and verification.

`Options.beforeCommit` must durably record the target index, source hash, length,
relative path and authorized root before publication. `recoveryHashes` may only
come from that journal for the same job/file/root. Existing authorized outputs
are independently reread and compared against both the current source and the
recorded hash; they are never overwritten. Without that authorization, an
existing destination remains a collision. Platform recovery must not infer
ownership from a filename or merely from identical contents.

`PosixStorage` holds an authorized directory descriptor, rejects symlink path
components, stages with exclusive creation, flushes file data, and uses atomic
no-replace rename on Apple platforms. Linux uses `renameat2(RENAME_NOREPLACE)` via the native syscall, enabling
filesystems such as exFAT when the kernel supports safe exclusive renames.
Only `ENOSYS` or `EINVAL` permits an exclusive hard-link fallback; no replacing
rename or copy fallback exists. Other POSIX hosts use exclusive hard-link
creation and removal of the owned staging name. Filesystems that do not support
these operations cannot safely copy through this adapter. Before enabling copy on an authorized target, call `supportsNoReplaceCommit`
with its directory descriptor or authorized path. This write probe creates only
exclusive owned temporary files, verifies collision preservation and a successful
exclusive move, and removes only its own inode identities. False blocks copy.
The probe must never run on a source or during read-only verification. A passed
probe demonstrates current target capability, not permanent permission or media
availability; the real commit still enforces no replacement on every file.

Power-loss recovery,
job checkpoints, capacity probing and volume identity checks belong to the
platform job/storage layer. Directory entry durability is filesystem dependent.

`makeHasherFactory` accepts native platform digest contexts for md5, sha1,
sha256 and sha512. These must return lowercase hexadecimal. It adds official
xxHash and original C4 Base58 formatting over SHA-512; no cryptographic primitive
is implemented here. Apple uses CommonCrypto. Android must supply native/JNI
MessageDigest contexts; do not send file bytes through the React Native bridge.

Run host tests on macOS: `sh packages/mobile-core/test-host.sh`. A CMake target
is provided for platform projects and optional host tests. Host tests exercise
literal hash vectors, chunk splitting, empty files, short writes, two targets,
corruption, cancellation, failure isolation, read-only verification, collisions,
commit races, symlink escapes and owned-stage cleanup. This is not evidence of
USB-C device acceptance or Android/iOS native application builds.

New project code follows the repository GPL-3.0-only license. Third-party
attribution is in `vendor/README.md` and `vendor/xxHash-LICENSE`.

Linux/Android syscall compilation and actual USB/exFAT behavior require Android
NDK and device verification. The macOS host suite exercises the same capability
probe contract with Apple atomic exclusive rename.
