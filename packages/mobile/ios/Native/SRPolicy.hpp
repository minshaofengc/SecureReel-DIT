// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <string>
#include <vector>
namespace sr {
inline bool terminal(const std::string& s){return s=="completed"||s=="completed-with-errors"||s=="failed"||s=="cancelled";}
inline bool privateIPv4(const std::string& host){std::vector<unsigned> parts;size_t at=0;while(at<host.size()){size_t end=host.find('.',at);auto part=host.substr(at,end==std::string::npos?end:end-at);if(part.empty()||part.size()>3||(part.size()>1&&part[0]=='0'))return false;unsigned n=0;for(char c:part){if(c<'0'||c>'9')return false;n=n*10+unsigned(c-'0');}if(n>255)return false;parts.push_back(n);if(end==std::string::npos)break;at=end+1;if(at==host.size())return false;}if(parts.size()!=4)return false;return parts[0]==10||(parts[0]==172&&parts[1]>=16&&parts[1]<=31)||(parts[0]==192&&parts[1]==168);}
inline bool segment(const std::string& s){if(s.empty()||s.size()>128)return false;for(char c:s)if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'))return false;return true;}
inline bool allowedRoute(const std::string& method,const std::string& path){
 if(method=="GET"&&(path=="/api/v1/snapshot"||path=="/api/v1/roots"||path=="/api/v1/projects"))return true;
 if(method=="POST"&&(path=="/api/v1/jobs"||path=="/api/v1/projects"))return true;
 std::string prefix="/api/v1/jobs/";if(method=="POST"&&path.compare(0,prefix.size(),prefix)==0){auto rest=path.substr(prefix.size());auto slash=rest.find('/');return slash!=std::string::npos&&segment(rest.substr(0,slash))&&(rest.substr(slash)=="/start"||rest.substr(slash)=="/pause"||rest.substr(slash)=="/resume"||rest.substr(slash)=="/cancel");}
 prefix="/api/v1/reports/";if(method=="GET"&&path.compare(0,prefix.size(),prefix)==0){auto rest=path.substr(prefix.size());if(segment(rest))return true;auto a=rest.find('/');if(a==std::string::npos)return false;auto b=rest.find('/',a+1);if(b==std::string::npos)return false;auto kind=rest.substr(b+1);return segment(rest.substr(0,a))&&segment(rest.substr(a+1,b-a-1))&&(kind=="json"||kind=="html"||kind=="pdf");}return false;
}
}
