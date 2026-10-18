// SPDX-License-Identifier: GPL-3.0-only
#include "securereel/core.hpp"
#define XXH_INLINE_ALL
#include "../vendor/xxhash.h"
#include <array>
#include <iomanip>
#include <sstream>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#endif
namespace securereel {
namespace {
std::string hex(const uint8_t* data,size_t n){std::ostringstream s;for(size_t i=0;i<n;i++)s<<std::hex<<std::setfill('0')<<std::setw(2)<<unsigned(data[i]);return s.str();}
class XxHasher:public Hasher {
 std::string algorithm_; XXH64_state_t s64_{}; XXH3_state_t s3_{};
 public: explicit XxHasher(std::string a):algorithm_(std::move(a)){XXH64_reset(&s64_,0);XXH3_128bits_reset(&s3_);}
 void update(const uint8_t* p,size_t n) override {if(algorithm_=="xxhash64")XXH64_update(&s64_,p,n);else if(algorithm_=="xxh3")XXH3_64bits_update(&s3_,p,n);else XXH3_128bits_update(&s3_,p,n);}
 std::string finish() override {if(algorithm_=="xxh128"){XXH128_canonical_t c;XXH128_canonicalFromHash(&c,XXH3_128bits_digest(&s3_));return hex(c.digest,16);}XXH64_canonical_t c;XXH64_canonicalFromHash(&c,algorithm_=="xxhash64"?XXH64_digest(&s64_):XXH3_64bits_digest(&s3_));return hex(c.digest,8);}
};
class C4Hasher:public Hasher {
 std::unique_ptr<Hasher> digest_;
 public:explicit C4Hasher(std::unique_ptr<Hasher> d):digest_(std::move(d)){}
 void update(const uint8_t* p,size_t n) override{digest_->update(p,n);}
 std::string finish() override {
  auto h=digest_->finish();if(h.size()!=128)throw std::runtime_error("invalid sha512 output");
  std::array<unsigned,64> bytes{};for(size_t i=0;i<64;i++){for(size_t j=0;j<2;j++){char c=h[i*2+j];if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw std::runtime_error("invalid digest hex");bytes[i]=bytes[i]*16+unsigned(c<='9'?c-'0':c-'a'+10);}}
  const char* alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  std::string result(90,'1');result[0]='c';result[1]='4';size_t cursor=90;
  while(true){unsigned remainder=0;bool nonzero=false;for(auto& b:bytes){unsigned v=remainder*256+b;b=v/58;remainder=v%58;nonzero|=b!=0;}result[--cursor]=alphabet[remainder];if(!nonzero)break;}
  return result;
 }
};
#ifdef __APPLE__
class AppleDigest:public Hasher {
 std::string a_; CC_MD5_CTX md5_{};CC_SHA1_CTX sha1_{};CC_SHA256_CTX sha256_{};CC_SHA512_CTX sha512_{};
 public:explicit AppleDigest(std::string a):a_(std::move(a)){if(a_=="md5")CC_MD5_Init(&md5_);else if(a_=="sha1")CC_SHA1_Init(&sha1_);else if(a_=="sha256")CC_SHA256_Init(&sha256_);else if(a_=="sha512")CC_SHA512_Init(&sha512_);else throw std::invalid_argument("unsupported digest");}
 void update(const uint8_t* p,size_t n) override {while(n){CC_LONG count=CC_LONG(std::min(n,size_t(UINT32_MAX)));if(a_=="md5")CC_MD5_Update(&md5_,p,count);else if(a_=="sha1")CC_SHA1_Update(&sha1_,p,count);else if(a_=="sha256")CC_SHA256_Update(&sha256_,p,count);else CC_SHA512_Update(&sha512_,p,count);p+=count;n-=count;}}
 std::string finish() override{uint8_t d[64];size_t n;if(a_=="md5"){CC_MD5_Final(d,&md5_);n=16;}else if(a_=="sha1"){CC_SHA1_Final(d,&sha1_);n=20;}else if(a_=="sha256"){CC_SHA256_Final(d,&sha256_);n=32;}else{CC_SHA512_Final(d,&sha512_);n=64;}return hex(d,n);}
};
#endif
}
HasherFactory makeHasherFactory(HasherFactory p){return [p](const std::string& a)->std::unique_ptr<Hasher>{if(a=="xxhash64"||a=="xxh3"||a=="xxh128")return std::make_unique<XxHasher>(a);if(a=="asc-c4")return std::make_unique<C4Hasher>(p("sha512"));if(a=="md5"||a=="sha1"||a=="sha256")return p(a);throw std::invalid_argument("unsupported algorithm");};}
HasherFactory appleHasherFactory(){
#ifdef __APPLE__
 return makeHasherFactory([](const std::string& a){return std::make_unique<AppleDigest>(a);});
#else
 throw std::runtime_error("Apple digest unavailable");
#endif
}
}
