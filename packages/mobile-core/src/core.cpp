// SPDX-License-Identifier: GPL-3.0-only
#include "securereel/core.hpp"
namespace securereel {
void validateRelative(const std::string& p) {
 if(p.empty()||p[0]=='/'||p.find('\\')!=std::string::npos||p.find('\0')!=std::string::npos||p.size()>4096)throw std::invalid_argument("invalid relative path");
 size_t start=0;while(start<=p.size()){auto end=p.find('/',start);auto c=p.substr(start,end==std::string::npos?end:end-start);if(c.empty()||c=="."||c==".."||c.find(':')!=std::string::npos)throw std::invalid_argument("invalid path component");if(end==std::string::npos)break;start=end+1;}
}
FileResult processFile(Storage& source,const std::string& relative,const std::vector<Storage*>& targets,const Options& o,const HasherFactory& factory,const Cancellation& cancel) {
 validateRelative(relative);
 if(targets.empty()||targets.size()>2||o.chunkSize==0||o.chunkSize>8*1024*1024)throw std::invalid_argument("invalid streaming options");
 for(auto t:targets)if(!t)throw std::invalid_argument("missing target");
 if(!o.recoveryHashes.empty()&&o.recoveryHashes.size()!=targets.size())throw std::invalid_argument("invalid recovery authorization");
 auto sourceHash=factory(o.algorithm);
 std::vector<uint8_t> buffer(o.chunkSize);FileResult result;result.targets.resize(targets.size());
 std::vector<std::unique_ptr<Stage>> stages(targets.size());
 std::vector<bool> recover(targets.size(),false);
 std::unique_ptr<Reader> sourceReader;
 auto hashReader=[&](Reader& reader,Hasher& hash,uint64_t& bytes){while(true){cancel.check();auto n=reader.read(buffer.data(),buffer.size());if(n>buffer.size())throw std::runtime_error("invalid read count");if(n==0)break;hash.update(buffer.data(),n);bytes+=n;}reader.validateUnchanged();};
 try {
  cancel.check();sourceReader=source.openRead(relative);
  if(!o.verifyOnly)for(size_t i=0;i<targets.size();i++){try{stages[i]=targets[i]->stage(relative);}catch(const Collision&){result.targets[i].status=Status::collision;recover[i]=!o.recoveryHashes.empty()&&!o.recoveryHashes[i].empty();}catch(const std::exception&){result.targets[i].status=Status::failed;}}
  while(true){cancel.check();auto n=sourceReader->read(buffer.data(),buffer.size());if(n>buffer.size())throw std::runtime_error("invalid read count");if(n==0)break;sourceHash->update(buffer.data(),n);result.bytes+=n;
   if(!o.verifyOnly)for(size_t i=0;i<stages.size();i++)if(stages[i]){try{size_t at=0;while(at<n){cancel.check();auto count=stages[i]->writer().write(buffer.data()+at,n-at);if(!count||count>n-at)throw std::runtime_error("invalid write count");at+=count;result.targets[i].bytes+=count;}}catch(const Cancelled&){throw;}catch(const std::exception&){stages[i].reset();result.targets[i].status=Status::failed;}}
  }
  sourceReader->validateUnchanged();
  if(o.expectedBytes && result.bytes!=*o.expectedBytes)throw std::runtime_error("source changed since inventory");
  result.sourceHash=sourceHash->finish();
 }catch(const Cancelled&){result.cancelled=true;}catch(const std::exception&){result.sourceFailed=true;}
 if(result.sourceFailed||result.cancelled){for(size_t i=0;i<result.targets.size();i++)if(stages[i]||o.verifyOnly||result.cancelled)result.targets[i].status=result.cancelled?Status::cancelled:Status::failed;return result;}
 for(size_t i=0;i<targets.size();i++){
  if(!o.verifyOnly&&!stages[i]&&!recover[i])continue;
  try {
   cancel.check();std::unique_ptr<Reader> reader;
   if(o.verifyOnly||recover[i])reader=targets[i]->openRead(relative);else {stages[i]->writer().finish();reader=stages[i]->readback();}
   auto hash=factory(o.algorithm);uint64_t bytes=0;hashReader(*reader,*hash,bytes);reader.reset();
   result.targets[i].hash=hash->finish();result.targets[i].bytes=bytes;
   if(bytes!=result.bytes||result.targets[i].hash!=result.sourceHash){result.targets[i].status=Status::mismatch;continue;}
   if(recover[i]&&result.sourceHash!=o.recoveryHashes[i]){result.targets[i].status=Status::collision;continue;}
   cancel.check();
   try {sourceReader->validateUnchanged();}catch(const std::exception&){result.sourceFailed=true;return result;}
   if(!o.verifyOnly&&!recover[i]){if(o.beforeCommit)o.beforeCommit(i,result.sourceHash,result.bytes);
    try {sourceReader->validateUnchanged();}catch(const std::exception&){result.sourceFailed=true;return result;}
    stages[i]->commitNoReplace();}result.targets[i].status=Status::verified;
  }catch(const Collision&){result.targets[i].status=Status::collision;}catch(const Cancelled&){result.cancelled=true;result.targets[i].status=Status::cancelled;}catch(const std::exception&){result.targets[i].status=Status::failed;}
 }
 return result;
}
}
