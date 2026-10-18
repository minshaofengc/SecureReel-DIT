#include "securereel/core.hpp"
#include <iostream>
#include <stdexcept>
#include <cstring>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
using namespace securereel;
void expect(bool b,const char* m){if(!b)throw std::runtime_error(m);}
struct MemReader:Reader {std::string data;size_t at=0;explicit MemReader(std::string d):data(std::move(d)){}size_t read(uint8_t* p,size_t n)override{n=std::min(n,data.size()-at);memcpy(p,data.data()+at,n);at+=n;return n;}};
struct MemStorage:Storage {
 std::string data;bool exists=false,fail=false,corrupt=false;int writes=0;Cancellation* cancel=nullptr;
 struct Pending:Stage,Writer {MemStorage& s;std::string data;bool done=false;explicit Pending(MemStorage& v):s(v){}Writer& writer()override{return *this;}size_t write(const uint8_t*p,size_t n)override{if(s.fail)throw std::runtime_error("disk failed");n=std::min(n,size_t(3));data.append((const char*)p,n);s.writes++;if(s.cancel)s.cancel->requested=true;return n;}void finish()override{done=true;}std::unique_ptr<Reader> readback()override{expect(done,"read before close");return std::make_unique<MemReader>(data+(s.corrupt?"bad":""));}void commitNoReplace()override{if(s.exists)throw Collision("exists");s.data=data;s.exists=true;}};
 std::unique_ptr<Reader> openRead(const std::string&)override{if(!exists)throw std::runtime_error("missing");return std::make_unique<MemReader>(data);}
 std::unique_ptr<Stage> stage(const std::string&)override{if(exists)throw Collision("exists");return std::make_unique<Pending>(*this);}
};
void streamingTests(const HasherFactory& f){
 MemStorage source,a,b;source.data=std::string(10000,'x');source.exists=true;Options o;o.chunkSize=17;Cancellation c;
 auto r=processFile(source,"DCIM/file",{&a,&b},o,f,c);expect(r.sourceHash=="aa416c82d3a4130f","long reference xxhash64");expect(r.targets.size()==2,"missing target results");expect(r.targets[0].status==Status::verified&&r.targets[1].status==Status::verified,"two verified targets");expect(a.data==source.data&&b.data==source.data,"short writes lose bytes");
 MemStorage bad,good;bad.fail=true;r=processFile(source,"file",{&bad,&good},o,f,c);expect(r.targets[0].status==Status::failed&&r.targets[1].status==Status::verified,"failed target isolation");
 MemStorage corrupt;corrupt.corrupt=true;r=processFile(source,"file",{&corrupt},o,f,c);expect(r.targets[0].status==Status::mismatch&&!corrupt.exists,"corrupt readback committed");
 r=processFile(source,"file",{&a},o,f,c);expect(r.targets[0].status==Status::collision&&a.data==source.data,"collision overwrite");
 MemStorage resumed;o.recoveryHashes={r.sourceHash,""};int intents=0;o.beforeCommit=[&](size_t target,const std::string& hash,uint64_t bytes){expect(target==1&&hash==r.sourceHash&&bytes==source.data.size()&&!resumed.exists,"commit intent must precede publication");intents++;};
 r=processFile(source,"file",{&a,&resumed},o,f,c);expect(r.targets[0].status==Status::verified&&r.targets[1].status==Status::verified&&intents==1,"durable authorized output recovery failed");o.recoveryHashes.clear();o.beforeCommit={};
 o.verifyOnly=true;int writes=a.writes;r=processFile(source,"file",{&a,&bad},o,f,c);expect(r.targets[0].status==Status::verified&&r.targets[1].status==Status::failed&&a.writes==writes&&bad.writes==0,"verify writes");
 o.verifyOnly=false;MemStorage preCancelled;Cancellation pre;pre.requested=true;r=processFile(source,"file",{&preCancelled},o,f,pre);expect(r.cancelled&&r.targets[0].status==Status::cancelled&&!preCancelled.exists,"pre-start cancellation status");
 bool bounded=false;o.chunkSize=9*1024*1024;try{processFile(source,"file",{&a},o,f,c);}catch(const std::invalid_argument&){bounded=true;}expect(bounded,"unbounded buffer accepted");o.chunkSize=17;
 MemStorage empty,emptyTarget;empty.exists=true;r=processFile(empty,"empty",{&emptyTarget},o,f,c);expect(r.targets[0].status==Status::verified&&emptyTarget.exists&&emptyTarget.data.empty(),"empty copy");
 MemStorage shortened;o.expectedBytes=source.data.size()+1;r=processFile(source,"shortened",{&shortened},o,f,c);expect(r.sourceFailed&&!shortened.exists,"source shrank since inventory but was published");o.expectedBytes.reset();
 MemStorage cancelled;cancelled.cancel=&c;r=processFile(source,"file",{&cancelled},o,f,c);expect(r.cancelled&&!cancelled.exists&&r.targets[0].status==Status::cancelled,"cancellation committed");
}
void probeTests(){
 char temp[]="/tmp/securereel-probe-XXXXXX";auto root=mkdtemp(temp);expect(root!=nullptr,"probe temp root");
 std::ofstream(std::string(root)+"/existing")<<"untouched";
 expect(supportsNoReplaceCommit(std::string(root)),"safe filesystem capability probe");
 int fd=open(root,O_RDONLY|O_DIRECTORY);expect(fd>=0,"probe root descriptor");expect(supportsNoReplaceCommit(fd),"descriptor capability probe");close(fd);
 size_t count=0;for(auto& e:std::filesystem::directory_iterator(root)){count++;expect(e.path().filename()=="existing","probe orphan file");}expect(count==1,"probe removed existing file");
 std::ifstream existing(std::string(root)+"/existing");std::string data;std::getline(existing,data);expect(data=="untouched","probe changed existing content");
 expect(!supportsNoReplaceCommit(-1),"invalid root probe admitted");expect(!supportsNoReplaceCommit(std::string(root)+"/missing"),"missing root probe admitted");
 chmod(root,0500);expect(!supportsNoReplaceCommit(std::string(root)),"unwritable target admitted");chmod(root,0700);
 std::filesystem::remove_all(root);
}
void posixTests(const HasherFactory& f){
 char temp[]="/tmp/securereel-native-XXXXXX";auto root=mkdtemp(temp);expect(root!=nullptr,"temp root");
 std::filesystem::create_directory(std::string(root)+"/source");std::filesystem::create_directory(std::string(root)+"/target");
 std::ofstream(std::string(root)+"/source/file")<<"literal footage";
 {struct MutatingHash:Hasher {std::unique_ptr<Hasher> inner;std::string path;bool changed=false;MutatingHash(std::unique_ptr<Hasher> h,std::string p):inner(std::move(h)),path(std::move(p)){}void update(const uint8_t* p,size_t n)override{inner->update(p,n);if(!changed){changed=true;std::ofstream(path)<<std::string(15,'z');}}std::string finish()override{return inner->finish();}};
  auto mutate=[&](const std::string& a)->std::unique_ptr<Hasher>{return std::make_unique<MutatingHash>(f(a),std::string(root)+"/source/file");};
  PosixStorage source(std::string(root)+"/source"),target(std::string(root)+"/target");Cancellation c;Options o;auto r=processFile(source,"file",{&target},o,mutate,c);expect(r.sourceFailed&&!std::filesystem::exists(std::string(root)+"/target/file"),"same-length source mutation published final output");
 }
 std::ofstream(std::string(root)+"/source/file")<<"literal footage";
 {PosixStorage source(std::string(root)+"/source"),target(std::string(root)+"/target");Cancellation c;Options o;auto r=processFile(source,"file",{&target},o,f,c);expect(r.targets[0].status==Status::verified,"POSIX verified commit");
 std::ifstream file(std::string(root)+"/target/file");std::string contents;std::getline(file,contents);expect(contents=="literal footage","POSIX data");
 r=processFile(source,"file",{&target},o,f,c);expect(r.targets[0].status==Status::collision,"POSIX no overwrite");
 std::filesystem::create_directory(std::string(root)+"/source/DCIM");std::ofstream(std::string(root)+"/source/DCIM/clip")<<"footage";std::ofstream(std::string(root)+"/target/DCIM")<<"existing parent file";
 r=processFile(source,"DCIM/clip",{&target},o,f,c);expect(r.targets[0].status==Status::collision,"parent name conflict classified as disk failure");
 std::ofstream(std::string(root)+"/source/other")<<"other footage";r=processFile(source,"other",{&target},o,f,c);expect(r.targets[0].status==Status::verified,"healthy target stopped after naming conflict");
 symlink((std::string(root)+"/source").c_str(),(std::string(root)+"/target/escape").c_str());bool blocked=false;try{target.openRead("escape/file");}catch(const std::exception&){blocked=true;}expect(blocked,"POSIX symlink escape");
 auto stage=target.stage("race");stage->writer().write((const uint8_t*)"new",3);stage->writer().finish();std::ofstream(std::string(root)+"/target/race")<<"existing";blocked=false;try{stage->commitNoReplace();}catch(const Collision&){blocked=true;}expect(blocked,"commit race overwrite");
 }
 for(auto& e:std::filesystem::directory_iterator(std::string(root)+"/target"))expect(e.path().filename().string().find(".securereel-")!=0,"orphan staging file");
 std::filesystem::remove_all(root);
}
int main(){try {
 auto factory=appleHasherFactory();
 const std::pair<const char*,const char*> vectors[]={
 {"xxhash64","ef46db3751d8e999"},{"xxh3","2d06800538d394c2"},{"xxh128","99aa06d3014798d86001c324468d497f"},
 {"md5","d41d8cd98f00b204e9800998ecf8427e"},{"sha1","da39a3ee5e6b4b0d3255bfef95601890afd80709"},{"sha256","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
 {"asc-c4","c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT"}};
 for(auto v:vectors)expect(factory(v.first)->finish()==v.second,"empty literal hash vector");
 const std::pair<const char*,const char*> abc[]={ {"xxhash64","44bc2cf5ad770999"},{"xxh3","78af5f94892f3950"},{"xxh128","06b05ab6733a618578af5f94892f3950"},{"md5","900150983cd24fb0d6963f7d28e17f72"},{"sha1","a9993e364706816aba3e25717850c26c9cd0d89d"},{"sha256","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}};
 const std::pair<const char*,const char*> longVectors[]={{"xxhash64","aa416c82d3a4130f"},{"xxh3","cb763e2ccd065fab"},{"xxh128","0bbccd47483750b1cb763e2ccd065fab"}};
 std::string longData(10000,'x');for(auto v:longVectors){auto h=factory(v.first);for(size_t at=0;at<longData.size();at+=17)h->update((const uint8_t*)longData.data()+at,std::min(size_t(17),longData.size()-at));expect(h->finish()==v.second,"long split reference vector");}
 for(auto v:abc){auto h=factory(v.first);h->update((const uint8_t*)"a",1);h->update((const uint8_t*)"bc",2);expect(h->finish()==v.second,"split abc literal vector");}
 expect(factory("sha256")->finish()==vectors[5].second,"fresh contexts");
 auto split=factory("asc-c4");split->update((const uint8_t*)"f",1);split->update((const uint8_t*)"oo",2);
 expect(split->finish()=="c45xZeXwMSpqXjpDumcHMA6mhoAmGHkUo7r9WmN2UgSEQzj9KjgseaQdkEJ11fGb5S1WEENcV3q8RFWwEeVpC7Fjk2","split C4 foo vector");
 for(const auto& path:std::vector<std::string>{"../media","/root","a/../b","a/./b","a//b","a\\b","C:media","a/",std::string("a\0b",3)}){bool rejected=false;try{validateRelative(path);}catch(const std::invalid_argument&){rejected=true;}expect(rejected,"invalid path accepted");}
 streamingTests(factory);posixTests(factory);probeTests();
 std::cout<<"PASS hash vectors, traversal and streaming\n";
 }catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;} }
