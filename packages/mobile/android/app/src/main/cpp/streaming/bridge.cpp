// SPDX-License-Identifier: GPL-3.0-only
#include <jni.h>
#include <unistd.h>
#include <cerrno>
#include <sys/stat.h>
#include <sstream>
#include "securereel/core.hpp"
using namespace securereel;
namespace {
void exception(JNIEnv* e) { if(e->ExceptionCheck()){e->ExceptionClear();throw std::runtime_error("platform operation failed");} }
struct Digest final: Hasher {
 JNIEnv* env; jobject digest; jmethodID updateMethod,finishMethod;
 Digest(JNIEnv* e,const std::string& algorithm):env(e) {
  auto type=e->FindClass("java/security/MessageDigest");auto create=e->GetStaticMethodID(type,"getInstance","(Ljava/lang/String;)Ljava/security/MessageDigest;");
  auto name=e->NewStringUTF(algorithm.c_str());digest=e->CallStaticObjectMethod(type,create,name);e->DeleteLocalRef(name);exception(e);
  updateMethod=e->GetMethodID(type,"update","([B)V");finishMethod=e->GetMethodID(type,"digest","()[B");e->DeleteLocalRef(type);
 }
 ~Digest(){env->DeleteLocalRef(digest);}
 void update(const uint8_t* bytes,size_t count)override{auto array=env->NewByteArray(static_cast<jsize>(count));env->SetByteArrayRegion(array,0,count,reinterpret_cast<const jbyte*>(bytes));env->CallVoidMethod(digest,updateMethod,array);env->DeleteLocalRef(array);exception(env);}
 std::string finish()override{auto array=(jbyteArray)env->CallObjectMethod(digest,finishMethod);exception(env);auto count=env->GetArrayLength(array);std::vector<jbyte> bytes(count);env->GetByteArrayRegion(array,0,count,bytes.data());env->DeleteLocalRef(array);std::string hex;for(auto b:bytes){hex.push_back("0123456789abcdef"[(b&255)>>4]);hex.push_back("0123456789abcdef"[b&15]);}return hex;}
};
struct FdReader final: Reader {
 int fd;JNIEnv* env;jobject gate;jmethodID await;struct stat initial{};
 FdReader(int input,JNIEnv* e,jobject g):fd(dup(input)),env(e),gate(g){if(fd<0)throw std::runtime_error("unavailable descriptor");if(lseek(fd,0,SEEK_SET)<0){close(fd);throw std::runtime_error("provider is not seekable");}if(fstat(fd,&initial)<0){close(fd);throw std::runtime_error("descriptor unavailable");}auto c=e->GetObjectClass(g);await=e->GetMethodID(c,"awaitChunk","()Z");e->DeleteLocalRef(c);}
 ~FdReader(){close(fd);}
 void validateUnchanged()override{struct stat now;if(fstat(fd,&now)<0)throw std::runtime_error("descriptor unavailable");
#ifdef __APPLE__
 auto changed=now.st_mtimespec.tv_sec!=initial.st_mtimespec.tv_sec||now.st_mtimespec.tv_nsec!=initial.st_mtimespec.tv_nsec||now.st_ctimespec.tv_sec!=initial.st_ctimespec.tv_sec||now.st_ctimespec.tv_nsec!=initial.st_ctimespec.tv_nsec;
#else
 auto changed=now.st_mtim.tv_sec!=initial.st_mtim.tv_sec||now.st_mtim.tv_nsec!=initial.st_mtim.tv_nsec||now.st_ctim.tv_sec!=initial.st_ctim.tv_sec||now.st_ctim.tv_nsec!=initial.st_ctim.tv_nsec;
#endif
 if(now.st_size!=initial.st_size||changed)throw std::runtime_error("file changed while reading");}

 size_t read(uint8_t* bytes,size_t count)override{auto allowed=env->CallBooleanMethod(gate,await);exception(env);if(!allowed)throw Cancelled();ssize_t n;do{n=::read(fd,bytes,count);}while(n<0&&errno==EINTR);if(n<0)throw std::runtime_error("read failed");return static_cast<size_t>(n);}
};
struct ReadOnlyStorage final: Storage {
 int fd;JNIEnv* env;jobject gate; ReadOnlyStorage(int f,JNIEnv* e,jobject g):fd(f),env(e),gate(g){}
 std::unique_ptr<Reader> openRead(const std::string&)override{return std::make_unique<FdReader>(fd,env,gate);}
 std::unique_ptr<Stage> stage(const std::string&)override{throw std::runtime_error("Provider does not support verified no-replace commit");}
};
}
extern "C" JNIEXPORT jstring JNICALL Java_com_securereelmobile_nativebridge_JobEngine_verifyFile(JNIEnv* env,jobject,jint source,jintArray targets,jstring algorithm,jlong expectedBytes,jobject gate){
 try {
  auto raw=env->GetStringUTFChars(algorithm,nullptr);std::string algo(raw);env->ReleaseStringUTFChars(algorithm,raw);
  auto n=env->GetArrayLength(targets);std::vector<jint> descriptors(n);env->GetIntArrayRegion(targets,0,n,descriptors.data());
  ReadOnlyStorage input(source,env,gate);std::vector<std::unique_ptr<ReadOnlyStorage>> owned;std::vector<Storage*> outputs;
  for(auto fd:descriptors){owned.push_back(std::make_unique<ReadOnlyStorage>(fd,env,gate));outputs.push_back(owned.back().get());}
  auto factory=makeHasherFactory([env](const std::string& a)->std::unique_ptr<Hasher>{std::string platform;if(a=="md5")platform="MD5";else if(a=="sha1")platform="SHA-1";else if(a=="sha256")platform="SHA-256";else if(a=="sha512")platform="SHA-512";else throw std::invalid_argument("unsupported digest");return std::make_unique<Digest>(env,platform);});
  Options options;options.algorithm=algo;options.verifyOnly=true;if(expectedBytes>=0)options.expectedBytes=static_cast<uint64_t>(expectedBytes);Cancellation cancellation;
  auto result=processFile(input,"document",outputs,options,factory,cancellation);
  const char* names[]={"verified","collision","failed","cancelled","mismatch"};std::ostringstream json;
  json<<"{\"sourceHash\":\""<<result.sourceHash<<"\",\"bytes\":"<<result.bytes<<",\"sourceFailed\":"<<(result.sourceFailed?"true":"false")<<",\"cancelled\":"<<(result.cancelled?"true":"false")<<",\"targets\":[";
  for(size_t i=0;i<result.targets.size();i++){if(i)json<<',';auto& t=result.targets[i];json<<"{\"status\":\""<<names[static_cast<int>(t.status)]<<"\",\"hash\":\""<<t.hash<<"\",\"bytes\":"<<t.bytes<<'}';}json<<"]}";
  return env->NewStringUTF(json.str().c_str());
 }catch(const std::exception&){auto c=env->FindClass("java/lang/IllegalStateException");env->ThrowNew(c,"Native verification unavailable");return nullptr;}
}
#ifdef SECUREREEL_JNI_HOST_TEST
#include <fcntl.h>
extern "C" JNIEXPORT jstring JNICALL Java_com_securereelmobile_nativebridge_NativeStreamingTest_verifyFile(JNIEnv* e,jclass,jint s,jintArray t,jstring a,jobject g){return Java_com_securereelmobile_nativebridge_JobEngine_verifyFile(e,nullptr,s,t,a,-1,g);}
extern "C" JNIEXPORT jint JNICALL Java_com_securereelmobile_nativebridge_NativeStreamingTest_open(JNIEnv* e,jclass,jstring p){auto path=e->GetStringUTFChars(p,nullptr);int fd=::open(path,O_RDONLY);e->ReleaseStringUTFChars(p,path);return fd;}
extern "C" JNIEXPORT void JNICALL Java_com_securereelmobile_nativebridge_NativeStreamingTest_close(JNIEnv*,jclass,jint fd){::close(fd);}
#endif
namespace {
void chunkGate(JNIEnv* e,jobject g){auto c=e->GetObjectClass(g);auto method=e->GetMethodID(c,"awaitChunk","()Z");e->DeleteLocalRef(c);auto allowed=e->CallBooleanMethod(g,method);exception(e);if(!allowed)throw Cancelled();}
struct GatedReader final: Reader {std::unique_ptr<Reader> inner;JNIEnv* env;jobject gate;GatedReader(std::unique_ptr<Reader> r,JNIEnv* e,jobject g):inner(std::move(r)),env(e),gate(g){}size_t read(uint8_t* b,size_t n)override{chunkGate(env,gate);return inner->read(b,n);}void validateUnchanged()override{inner->validateUnchanged();}};
struct GatedWriter final: Writer {Writer& inner;JNIEnv* env;jobject gate;GatedWriter(Writer& w,JNIEnv* e,jobject g):inner(w),env(e),gate(g){}size_t write(const uint8_t* b,size_t n)override{chunkGate(env,gate);return inner.write(b,n);}void finish()override{chunkGate(env,gate);inner.finish();}};
struct GatedStage final: Stage {std::unique_ptr<Stage> inner;GatedWriter output;JNIEnv* env;jobject gate;GatedStage(std::unique_ptr<Stage> s,JNIEnv* e,jobject g):inner(std::move(s)),output(inner->writer(),e,g),env(e),gate(g){}Writer& writer()override{return output;}std::unique_ptr<Reader> readback()override{chunkGate(env,gate);return std::make_unique<GatedReader>(inner->readback(),env,gate);}void commitNoReplace()override{chunkGate(env,gate);inner->commitNoReplace();}};
struct GatedStorage final: Storage {std::string root;std::unique_ptr<PosixStorage> inner;JNIEnv* env;jobject gate;GatedStorage(std::string path,JNIEnv* e,jobject g):root(std::move(path)),env(e),gate(g){}PosixStorage& storage(){if(!inner)inner=std::make_unique<PosixStorage>(root);return *inner;}std::unique_ptr<Reader> openRead(const std::string& p)override{chunkGate(env,gate);return std::make_unique<GatedReader>(storage().openRead(p),env,gate);}std::unique_ptr<Stage> stage(const std::string& p)override{chunkGate(env,gate);return std::make_unique<GatedStage>(storage().stage(p),env,gate);}};
std::string fromJava(JNIEnv* e,jstring input){
 if(!input)throw std::invalid_argument("missing input");
 auto count=e->GetStringLength(input);auto raw=e->GetStringChars(input,nullptr);if(!raw)throw std::runtime_error("missing input");std::string value;
 try {for(jsize i=0;i<count;i++){uint32_t cp=raw[i];if(cp>=0xd800&&cp<=0xdbff){if(i+1>=count||raw[i+1]<0xdc00||raw[i+1]>0xdfff)throw std::invalid_argument("invalid Unicode");cp=0x10000+((cp-0xd800)<<10)+(raw[++i]-0xdc00);}else if(cp>=0xdc00&&cp<=0xdfff)throw std::invalid_argument("invalid Unicode");
  if(cp<0x80)value.push_back(char(cp));else if(cp<0x800){value.push_back(char(0xc0|(cp>>6)));value.push_back(char(0x80|(cp&63)));}else if(cp<0x10000){value.push_back(char(0xe0|(cp>>12)));value.push_back(char(0x80|((cp>>6)&63)));value.push_back(char(0x80|(cp&63)));}else{value.push_back(char(0xf0|(cp>>18)));value.push_back(char(0x80|((cp>>12)&63)));value.push_back(char(0x80|((cp>>6)&63)));value.push_back(char(0x80|(cp&63)));}
 }}catch(...){e->ReleaseStringChars(input,raw);throw;}
 e->ReleaseStringChars(input,raw);return value;
}
jstring resultJson(JNIEnv* env,const FileResult& result){const char* names[]={"verified","collision","failed","cancelled","mismatch"};std::ostringstream json;json<<"{\"sourceHash\":\""<<result.sourceHash<<"\",\"bytes\":"<<result.bytes<<",\"sourceFailed\":"<<(result.sourceFailed?"true":"false")<<",\"cancelled\":"<<(result.cancelled?"true":"false")<<",\"targets\":[";for(size_t i=0;i<result.targets.size();i++){if(i)json<<',';auto& t=result.targets[i];json<<"{\"status\":\""<<names[static_cast<int>(t.status)]<<"\",\"hash\":\""<<t.hash<<"\",\"bytes\":"<<t.bytes<<'}';}json<<"]}";return env->NewStringUTF(json.str().c_str());}
}
extern "C" JNIEXPORT jstring JNICALL Java_com_securereelmobile_nativebridge_JobEngine_copyFile(JNIEnv* env,jobject,jstring source,jobjectArray targets,jstring relative,jstring algorithm,jlong expectedBytes,jobject gate){
 try {
  GatedStorage input(fromJava(env,source),env,gate);auto n=env->GetArrayLength(targets);if(n<1||n>2)throw std::invalid_argument("target count");
  std::vector<std::unique_ptr<GatedStorage>> owned;std::vector<Storage*> outputs;for(int i=0;i<n;i++){auto path=(jstring)env->GetObjectArrayElement(targets,i);owned.push_back(std::make_unique<GatedStorage>(fromJava(env,path),env,gate));env->DeleteLocalRef(path);outputs.push_back(owned.back().get());}
  auto factory=makeHasherFactory([env](const std::string& a)->std::unique_ptr<Hasher>{std::string name;if(a=="md5")name="MD5";else if(a=="sha1")name="SHA-1";else if(a=="sha256")name="SHA-256";else if(a=="sha512")name="SHA-512";else throw std::invalid_argument("digest");return std::make_unique<Digest>(env,name);});
  Options options;options.algorithm=fromJava(env,algorithm);if(expectedBytes>=0)options.expectedBytes=static_cast<uint64_t>(expectedBytes);
  auto gateType=env->GetObjectClass(gate);auto recovery=env->GetMethodID(gateType,"recoveryHash","(I)Ljava/lang/String;");auto intent=env->GetMethodID(gateType,"prepareCommit","(ILjava/lang/String;J)V");env->DeleteLocalRef(gateType);exception(env);
  for(int i=0;i<n;i++){auto hash=(jstring)env->CallObjectMethod(gate,recovery,i);exception(env);options.recoveryHashes.push_back(fromJava(env,hash));env->DeleteLocalRef(hash);}
  options.beforeCommit=[env,gate,intent](size_t target,const std::string& hash,uint64_t bytes){auto value=env->NewStringUTF(hash.c_str());env->CallVoidMethod(gate,intent,static_cast<jint>(target),value,static_cast<jlong>(bytes));env->DeleteLocalRef(value);exception(env);};
  Cancellation cancellation;
  return resultJson(env,processFile(input,fromJava(env,relative),outputs,options,factory,cancellation));
 }catch(const std::exception&){auto c=env->FindClass("java/lang/IllegalStateException");env->ThrowNew(c,"Native copy unavailable");return nullptr;}
}
#ifdef SECUREREEL_JNI_HOST_TEST
extern "C" JNIEXPORT jstring JNICALL Java_com_securereelmobile_nativebridge_NativeStreamingTest_copyFileExpected(JNIEnv* e,jclass,jstring s,jobjectArray t,jstring r,jstring a,jlong bytes,jobject g){return Java_com_securereelmobile_nativebridge_JobEngine_copyFile(e,nullptr,s,t,r,a,bytes,g);}
extern "C" JNIEXPORT jstring JNICALL Java_com_securereelmobile_nativebridge_NativeStreamingTest_copyFile(JNIEnv* e,jclass,jstring s,jobjectArray t,jstring r,jstring a,jobject g){return Java_com_securereelmobile_nativebridge_JobEngine_copyFile(e,nullptr,s,t,r,a,-1,g);}
#endif
extern "C" JNIEXPORT jboolean JNICALL Java_com_securereelmobile_nativebridge_DirectStorage_probe(JNIEnv* env,jobject,jstring path){
 try { return supportsNoReplaceCommit(fromJava(env,path)) ? JNI_TRUE : JNI_FALSE; }catch(const std::exception&){return JNI_FALSE;}
}
#ifndef SECUREREEL_JNI_HOST_TEST
// Register exact Kotlin signatures at load time instead of allowing silent ABI
// mismatches to pass an invalid Gate reference into a streaming operation.
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm,void*) {
 JNIEnv* env=nullptr;if(vm->GetEnv(reinterpret_cast<void**>(&env),JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;
 const JNINativeMethod jobs[]={
  {const_cast<char*>("copyFile"),const_cast<char*>("(Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;JLcom/securereelmobile/nativebridge/JobEngine$Gate;)Ljava/lang/String;"),reinterpret_cast<void*>(Java_com_securereelmobile_nativebridge_JobEngine_copyFile)},
  {const_cast<char*>("verifyFile"),const_cast<char*>("(I[ILjava/lang/String;JLcom/securereelmobile/nativebridge/JobEngine$Gate;)Ljava/lang/String;"),reinterpret_cast<void*>(Java_com_securereelmobile_nativebridge_JobEngine_verifyFile)}
 };
 auto engine=env->FindClass("com/securereelmobile/nativebridge/JobEngine");if(!engine)return JNI_ERR;
 if(env->RegisterNatives(engine,jobs,2)!=JNI_OK){env->DeleteLocalRef(engine);return JNI_ERR;}env->DeleteLocalRef(engine);
 const JNINativeMethod storage[]={ {const_cast<char*>("probe"),const_cast<char*>("(Ljava/lang/String;)Z"),reinterpret_cast<void*>(Java_com_securereelmobile_nativebridge_DirectStorage_probe)} };
 auto direct=env->FindClass("com/securereelmobile/nativebridge/DirectStorage");if(!direct)return JNI_ERR;
 auto registered=env->RegisterNatives(direct,storage,1);env->DeleteLocalRef(direct);return registered==JNI_OK?JNI_VERSION_1_6:JNI_ERR;
}
#endif
