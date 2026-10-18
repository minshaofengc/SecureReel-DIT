// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge;
import java.net.URI;
public final class SafetyPolicy {
  private SafetyPolicy() {}
  public static long requiredForPool(long bytes,int copies) {
    if(bytes<0 || copies<1 || bytes>9007199254740991L/copies)throw new IllegalArgumentException("Invalid inventory size");
    return bytes*copies;
  }
  public static void requireCapacity(long required,long available) {
    if(available<0)throw new IllegalArgumentException("目标剩余容量未知，无法开始拷贝");
  }
  public static void confirmation(String current,String accepted,boolean acceptRisks,boolean risks) {
    if(risks&&(!acceptRisks||!current.equals(accepted)))throw new IllegalArgumentException("存储风险或位置已改变，请重新预检并明确确认");
  }
  public static boolean probeCopyTarget(boolean requested,String role,boolean sharesSource,boolean verifying,java.util.function.BooleanSupplier probe) {
    return requested && role.equals("target") && !sharesSource && !verifying && probe.getAsBoolean();
  }
  public static void relative(String p) {
    if(p == null || p.length()>4096 || p.indexOf('\\')>=0 || p.indexOf('\0')>=0) throw new IllegalArgumentException("Invalid relative name");
    for(String c:p.split("/",-1)) if(c.isEmpty()||c.equals(".")||c.equals("..")||c.contains(":")) throw new IllegalArgumentException("Invalid relative name");
  }
  public static String endpoint(String value) {
    try {
      URI u=new URI(value); String h=u.getHost();
      if(!"https".equals(u.getScheme())||h==null||u.getUserInfo()!=null||u.getQuery()!=null||u.getFragment()!=null||!(u.getPath().isEmpty()||u.getPath().equals("/"))||u.getPort()==0||u.getPort()>65535) throw new IllegalArgumentException();
      String[] octets=h.split("\\.",-1); if(octets.length!=4) throw new IllegalArgumentException();
      int[] n=new int[4]; for(int i=0;i<4;i++){if(!octets[i].matches("0|[1-9][0-9]{0,2}")) throw new IllegalArgumentException(); n[i]=Integer.parseInt(octets[i]);if(n[i]>255)throw new IllegalArgumentException();}
      if(!(n[0]==10 || (n[0]==172 && n[1]>=16&&n[1]<=31) || (n[0]==192 && n[1]==168))) throw new IllegalArgumentException();
      return "https://"+h+(u.getPort()==-1?"":":"+u.getPort());
    } catch(Exception e) { throw new IllegalArgumentException("A private LAN HTTPS address is required"); }
  }
  public static void route(String p) {
    if(p==null||p.length()>512||!p.startsWith("/api/v1/")||!p.matches("/[A-Za-z0-9/_-]+")||p.contains("//"))throw new IllegalArgumentException("Invalid API route");
  }
  public static boolean shouldLaunch(String state,String action,boolean scheduled) {
    if(scheduled && (action.equals("start")||action.equals("resume")))return false;
    if(action.equals("start")&&state.equals("queued"))return true;
    if(action.equals("resume")&&state.equals("interrupted"))return true;
    throw new IllegalArgumentException("Task cannot start in this state");
  }
  public static boolean fileSuccessful(boolean sourceFailed,String[] statuses) {
    if(sourceFailed||statuses.length==0)return false;
    for(String status:statuses)if(!status.equals("verified"))return false;
    return true;
  }
  public static String finalState(boolean sourceFailed,boolean cancelled,int failed,boolean anyVerified) {
    if(sourceFailed)return "failed";
    if(cancelled)return "cancelled";
    if(failed>0)return anyVerified?"completed-with-errors":"failed";
    return "completed";
  }
  public static boolean terminal(String s) {return s.equals("completed")||s.equals("completed-with-errors")||s.equals("failed")||s.equals("cancelled");}
}
