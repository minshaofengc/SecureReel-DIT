// SPDX-License-Identifier: GPL-3.0-only
#include "securereel/core.hpp"
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <cstdio>
#include <algorithm>
#include <cstring>
#ifdef __linux__
#include <sys/syscall.h>
#include <linux/fs.h>
#endif
namespace securereel { namespace {
[[noreturn]] void ioError(){if(errno==EEXIST)throw Collision("destination exists");throw std::runtime_error("storage I/O failure");}
struct Fd {int value;explicit Fd(int v):value(v){if(v<0)ioError();}~Fd(){if(value>=0)close(value);}Fd(const Fd&)=delete;};
void regular(int fd){struct stat s;if(fstat(fd,&s)<0)ioError();if(!S_ISREG(s.st_mode))throw std::runtime_error("not a regular file");}
class FileReader:public Reader {
 Fd fd_;struct stat initial_{};
 public:explicit FileReader(int fd):fd_(fd){regular(fd);if(fstat(fd,&initial_)<0)ioError();}
 size_t read(uint8_t* p,size_t n)override{ssize_t count;do{count=::read(fd_.value,p,n);}while(count<0&&errno==EINTR);if(count<0)ioError();return size_t(count);}
 void validateUnchanged()override{struct stat now;if(fstat(fd_.value,&now)<0)ioError();
#ifdef __APPLE__
 auto modified=now.st_mtimespec.tv_sec!=initial_.st_mtimespec.tv_sec||now.st_mtimespec.tv_nsec!=initial_.st_mtimespec.tv_nsec||now.st_ctimespec.tv_sec!=initial_.st_ctimespec.tv_sec||now.st_ctimespec.tv_nsec!=initial_.st_ctimespec.tv_nsec;
#else
 auto modified=now.st_mtim.tv_sec!=initial_.st_mtim.tv_sec||now.st_mtim.tv_nsec!=initial_.st_mtim.tv_nsec||now.st_ctim.tv_sec!=initial_.st_ctim.tv_sec||now.st_ctim.tv_nsec!=initial_.st_ctim.tv_nsec;
#endif
 if(now.st_size!=initial_.st_size||now.st_ino!=initial_.st_ino||now.st_dev!=initial_.st_dev||modified)throw std::runtime_error("file changed while reading");}
};
class FileWriter:public Writer {Fd fd_;bool finished_=false;public:explicit FileWriter(int fd):fd_(fd){}size_t write(const uint8_t*p,size_t n)override{if(finished_)throw std::runtime_error("closed writer");ssize_t count;do{count=::write(fd_.value,p,n);}while(count<0&&errno==EINTR);if(count<0)ioError();return size_t(count);}void finish()override{if(finished_)return;if(fsync(fd_.value)<0)ioError();int fd=fd_.value;fd_.value=-1;finished_=true;if(close(fd)<0)ioError();}bool finished()const{return finished_;}};
// Traverse every directory with O_NOFOLLOW and keep the parent descriptor held.
int parent(int root,const std::string& path,bool create,std::string& leaf){validateRelative(path);Fd current(dup(root));size_t start=0;while(true){size_t end=path.find('/',start);if(end==std::string::npos){leaf=path.substr(start);int fd=current.value;current.value=-1;return fd;}auto part=path.substr(start,end-start);if(create&&mkdirat(current.value,part.c_str(),0700)<0&&errno!=EEXIST)ioError();int next=openat(current.value,part.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(next<0){if(create&&(errno==ENOTDIR||errno==ELOOP))throw Collision("destination parent exists with incompatible type");ioError();}close(current.value);current.value=next;start=end+1;}}
// This helper never performs a replacing rename. Unsupported kernels may use
// hard links, which themselves atomically refuse an existing destination.
int noReplaceMove(int root,const char* from,const char* to) {
#ifdef __APPLE__
 return renameatx_np(root,from,root,to,RENAME_EXCL);
#elif defined(__linux__)
#ifdef SYS_renameat2
 if(syscall(SYS_renameat2,root,from,root,to,RENAME_NOREPLACE)==0)return 0;
 if(errno!=ENOSYS&&errno!=EINVAL)return -1;
#endif
 if(linkat(root,from,root,to,0)<0)return -1;
 // The final object is already verified and exclusively committed. Its owned
 // staging name is removed again by the stage destructor if this unlink fails.
 unlinkat(root,from,0);
 return 0;
#else
 if(linkat(root,from,root,to,0)<0)return -1;
 unlinkat(root,from,0);
 return 0;
#endif
}
struct ProbeFile {
 int root;Fd fd;std::vector<std::string> names;
 ProbeFile(int r,int descriptor,std::string name):root(r),fd(descriptor),names{std::move(name)}{}
 bool clean() noexcept {struct stat owned;if(fstat(fd.value,&owned)<0)return false;bool cleaned=true;for(const auto& name:names){struct stat current;if(fstatat(root,name.c_str(),&current,AT_SYMLINK_NOFOLLOW)<0){if(errno!=ENOENT)cleaned=false;continue;}if(current.st_dev!=owned.st_dev||current.st_ino!=owned.st_ino){cleaned=false;continue;}if(unlinkat(root,name.c_str(),0)<0)cleaned=false;}return cleaned;}
 ~ProbeFile(){clean();}
};
std::unique_ptr<ProbeFile> newProbe(int root) {
 static std::atomic<uint64_t> sequence{0};
 for(int attempt=0;attempt<128;attempt++){
  auto name=".securereel-probe-"+std::to_string(getpid())+"-"+std::to_string(sequence.fetch_add(1));
  int fd=openat(root,name.c_str(),O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd>=0){try{return std::make_unique<ProbeFile>(root,fd,name);}catch(...){close(fd);unlinkat(root,name.c_str(),0);throw;}}
  if(errno!=EEXIST)ioError();
 }
 throw std::runtime_error("probe allocation failed");
}
void probeWrite(ProbeFile& file,const char* marker){size_t n=strlen(marker),at=0;while(at<n){ssize_t count=write(file.fd.value,marker+at,n-at);if(count<0&&errno==EINTR)continue;if(count<=0)ioError();at+=size_t(count);}if(fsync(file.fd.value)<0)ioError();}
bool probeContent(int root,const std::string& name,const char* marker){Fd fd(openat(root,name.c_str(),O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));regular(fd.value);uint8_t buffer[32];ssize_t count;do{count=read(fd.value,buffer,sizeof(buffer));}while(count<0&&errno==EINTR);return count==ssize_t(strlen(marker))&&memcmp(buffer,marker,size_t(count))==0;}
class FileStage:public Stage {
 Fd parent_;std::string leaf_,temporary_;std::unique_ptr<FileWriter> writer_;bool committed_=false;struct stat identity_{};
 public:FileStage(int parentFd,std::string leaf):parent_(parentFd),leaf_(std::move(leaf)){
  struct stat s;if(fstatat(parent_.value,leaf_.c_str(),&s,AT_SYMLINK_NOFOLLOW)==0)throw Collision("destination exists");if(errno!=ENOENT)ioError();
  static std::atomic<uint64_t> sequence{0};int fd=-1;
  for(int i=0;i<100;i++){temporary_=".securereel-"+std::to_string(getpid())+"-"+std::to_string(sequence.fetch_add(1))+".partial";fd=openat(parent_.value,temporary_.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(fd>=0)break;if(errno!=EEXIST)ioError();}
  if(fd<0)ioError();if(fstat(fd,&identity_)<0){close(fd);unlinkat(parent_.value,temporary_.c_str(),0);ioError();}try{writer_=std::make_unique<FileWriter>(fd);}catch(...){close(fd);unlinkat(parent_.value,temporary_.c_str(),0);throw;}
 }
 ~FileStage()override{writer_.reset();struct stat current;if(fstatat(parent_.value,temporary_.c_str(),&current,AT_SYMLINK_NOFOLLOW)==0&&current.st_dev==identity_.st_dev&&current.st_ino==identity_.st_ino)unlinkat(parent_.value,temporary_.c_str(),0);}
 Writer& writer()override{return *writer_;}
 std::unique_ptr<Reader> readback()override{if(!writer_->finished())throw std::runtime_error("staging writer is open");return std::make_unique<FileReader>(openat(parent_.value,temporary_.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK));}
 void commitNoReplace()override{if(!writer_->finished()||committed_)throw std::runtime_error("invalid commit state");
  if(noReplaceMove(parent_.value,temporary_.c_str(),leaf_.c_str())<0)ioError();
  committed_=true;
 }
};
}
PosixStorage::PosixStorage(const std::string& root):root_(open(root.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)){if(root_<0)ioError();}
PosixStorage::PosixStorage(int root):root_(fcntl(root,F_DUPFD_CLOEXEC,0)){if(root_<0)ioError();struct stat s;if(fstat(root_,&s)<0||!S_ISDIR(s.st_mode)){close(root_);root_=-1;throw std::invalid_argument("root descriptor must be directory");}}
bool supportsNoReplaceCommit(int targetRoot) noexcept {
 try {
  Fd root(fcntl(targetRoot,F_DUPFD_CLOEXEC,0));struct stat directory;if(fstat(root.value,&directory)<0||!S_ISDIR(directory.st_mode))return false;
  auto source=newProbe(root.value),existing=newProbe(root.value),destination=newProbe(root.value);
  probeWrite(*source,"source-marker");probeWrite(*existing,"preserved-marker");
  const auto from=source->names.front(),to=existing->names.front(),vacant=destination->names.front();
  if(noReplaceMove(root.value,from.c_str(),to.c_str())==0||errno!=EEXIST)return false;
  if(!probeContent(root.value,from,"source-marker")||!probeContent(root.value,to,"preserved-marker"))return false;
  if(unlinkat(root.value,vacant.c_str(),0)<0)return false;
  source->names.push_back(vacant); // Cleanup follows owned inode, never filename alone.
  if(noReplaceMove(root.value,from.c_str(),vacant.c_str())<0)return false;
  struct stat old;if(fstatat(root.value,from.c_str(),&old,AT_SYMLINK_NOFOLLOW)==0||errno!=ENOENT)return false;
  bool verified=probeContent(root.value,vacant,"source-marker")&&probeContent(root.value,to,"preserved-marker");
  bool cleanedSource=source->clean(),cleanedExisting=existing->clean();
  // The reserved destination was removed before the move; its original inode
  // no longer owns this pathname. The source guard cleans the moved inode.
  return verified&&cleanedSource&&cleanedExisting;
 }catch(...){return false;}
}
bool supportsNoReplaceCommit(const std::string& targetPath) noexcept {
 try{Fd root(open(targetPath.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));return supportsNoReplaceCommit(root.value);}catch(...){return false;}
}
PosixStorage::~PosixStorage(){if(root_>=0)close(root_);}
std::unique_ptr<Reader> PosixStorage::openRead(const std::string& path){std::string leaf;Fd p(parent(root_,path,false,leaf));return std::make_unique<FileReader>(openat(p.value,leaf.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK));}
std::unique_ptr<Stage> PosixStorage::stage(const std::string& path){std::string leaf;int fd=parent(root_,path,true,leaf);return std::make_unique<FileStage>(fd,leaf);}
}
