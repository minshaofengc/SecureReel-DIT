#include "../SRPolicy.hpp"
#include <iostream>
#include <stdexcept>
void expect(bool b,const char* s){if(!b)throw std::runtime_error(s);}
int main(){try{
 for(auto s:{"completed","completed-with-errors","failed","cancelled"})expect(sr::terminal(s),"terminal report rejected");
 for(auto s:{"queued","running","paused","interrupted"})expect(!sr::terminal(s),"nonterminal report admitted");
 for(auto s:{"192.168.2.4","10.0.0.7","172.16.4.3","172.31.255.254"})expect(sr::privateIPv4(s),"private IPv4 rejected");
 for(auto s:{"8.8.8.8","127.0.0.1","172.32.0.1","192.168.256.1","010.0.0.1","10.0.0.1.evil","10.0.0.1/"})expect(!sr::privateIPv4(s),"nonprivate host admitted");
 expect(sr::allowedRoute("GET","/api/v1/snapshot"),"snapshot route");expect(sr::allowedRoute("POST","/api/v1/jobs"),"job create route");
 for(auto s:{"/api/v1/../admin","/api/v1/reports/a/b/json?url=evil","/api/v1/%2e%2e/admin","https://10.0.0.1/api/v1/snapshot"})expect(!sr::allowedRoute("GET",s),"unsafe route");
 std::cout<<"PASS native policy\n";
 }catch(const std::exception& e){std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}}
