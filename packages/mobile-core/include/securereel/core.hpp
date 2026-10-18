// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
namespace securereel {
class Collision : public std::runtime_error { public: using std::runtime_error::runtime_error; };
class Cancelled : public std::runtime_error { public: Cancelled():std::runtime_error("cancelled"){} };
struct Cancellation { std::atomic<bool> requested{false}; void check() const { if(requested.load()) throw Cancelled(); } };
struct Reader { virtual ~Reader()=default; virtual size_t read(uint8_t*,size_t)=0; virtual void validateUnchanged() {} };
struct Writer { virtual ~Writer()=default; virtual size_t write(const uint8_t*,size_t)=0; virtual void finish()=0; };
// Staging must be exclusive, private and owned by this object. Destruction cleans up
// only its own uncommitted object. commitNoReplace must atomically fail on collision.
struct Stage { virtual ~Stage()=default; virtual Writer& writer()=0; virtual std::unique_ptr<Reader> readback()=0; virtual void commitNoReplace()=0; };
struct Storage { virtual ~Storage()=default; virtual std::unique_ptr<Reader> openRead(const std::string& relative)=0; virtual std::unique_ptr<Stage> stage(const std::string& relative)=0; };
struct Hasher { virtual ~Hasher()=default; virtual void update(const uint8_t*,size_t)=0; virtual std::string finish()=0; };
using HasherFactory=std::function<std::unique_ptr<Hasher>(const std::string&)>;
enum class Status { verified, collision, failed, cancelled, mismatch };
struct TargetResult { Status status=Status::failed; uint64_t bytes=0; std::string hash; };
struct FileResult { std::string sourceHash; uint64_t bytes=0; std::vector<TargetResult> targets; bool sourceFailed=false; bool cancelled=false; };
struct Options { std::string algorithm="xxhash64"; size_t chunkSize=1024*1024; bool verifyOnly=false; std::optional<uint64_t> expectedBytes;
 std::vector<std::string> recoveryHashes;
 std::function<void(size_t,const std::string&,uint64_t)> beforeCommit;
};
void validateRelative(const std::string&);
FileResult processFile(Storage& source,const std::string& relative,const std::vector<Storage*>& targets,const Options&,const HasherFactory&,const Cancellation&);
// Digest factory handles md5, sha1, sha256 and sha512; output must be lowercase hex.
// Apple implementation uses CommonCrypto; Android supplies platform digest contexts.
HasherFactory makeHasherFactory(HasherFactory platformDigest);
HasherFactory appleHasherFactory();
// Write-capability proof for an explicitly authorized TARGET only. Never probe a
// source or verify-only resource. Creates exclusive owned temporary files,
// proves collision preservation and successful atomic no-replace commit, cleans
// only owned probes. False means copy must be blocked; no path/error is exposed.
bool supportsNoReplaceCommit(int authorizedTargetRootFd) noexcept;
bool supportsNoReplaceCommit(const std::string& authorizedTargetRootPath) noexcept;
class PosixStorage : public Storage {
 int root_=-1;
 public: explicit PosixStorage(const std::string& root); explicit PosixStorage(int authorizedRootFd); ~PosixStorage() override;
 PosixStorage(const PosixStorage&)=delete; PosixStorage& operator=(const PosixStorage&)=delete;
 std::unique_ptr<Reader> openRead(const std::string&) override;
 std::unique_ptr<Stage> stage(const std::string&) override;
};
}
