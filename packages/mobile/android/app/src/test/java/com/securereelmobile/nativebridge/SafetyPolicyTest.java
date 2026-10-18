package com.securereelmobile.nativebridge;
public final class SafetyPolicyTest {
  static void rejects(Runnable r) { try { r.run(); } catch (IllegalArgumentException e) { return; } throw new AssertionError("unsafe input accepted"); }
  public static void main(String[] args) {
    if(SafetyPolicy.requiredForPool(60,2)!=120)throw new AssertionError("shared capacity not aggregated");
    SafetyPolicy.requireCapacity(120,100); // Known shortage requires separate explicit consent, not an absolute block.
    long gb=1024L*1024L*1024L;
    SafetyPolicy.requireCapacity(60*gb,70*gb);
    SafetyPolicy.requireCapacity(60*gb,50*gb); // 20GB already written: original demand is conservative, acknowledgement allows resume.
    rejects(() -> SafetyPolicy.requireCapacity(1,-1));
    rejects(() -> SafetyPolicy.confirmation("new","old",true,true));
    rejects(() -> SafetyPolicy.confirmation("new","new",false,true));
    SafetyPolicy.confirmation("new","new",true,true);
    final int[] writes={0};
    java.util.function.BooleanSupplier probe=()->{writes[0]++;return true;};
    if(SafetyPolicy.probeCopyTarget(false,"target",false,false,probe) || SafetyPolicy.probeCopyTarget(true,"source",false,false,probe) || SafetyPolicy.probeCopyTarget(true,"target",false,true,probe) || writes[0]!=0)throw new AssertionError("read-only workflow performed capability writes");
    if(!SafetyPolicy.probeCopyTarget(true,"target",false,false,probe)||writes[0]!=1)throw new AssertionError("explicit copy target probe unavailable");
    SafetyPolicy.relative("DCIM/A001.mxf");
    for (String p : new String[]{"../x","/x","a//b","a\\b","a:b","a/./b","a\u0000b"}) rejects(() -> SafetyPolicy.relative(p));
    SafetyPolicy.endpoint("https://192.168.1.2:8443");
    for(String u : new String[]{"http://192.168.1.2","https://example.com","https://127.0.0.1","https://192.168.1.2/a","https://u@192.168.1.2","https://192.168.1.2#x","https://8.8.8.8"}) rejects(() -> SafetyPolicy.endpoint(u));
    SafetyPolicy.route("/api/v1/jobs");
    for(String p : new String[]{"/api/v1/../secret","/api/v1/%2e%2e/x","//evil","/api/v1/x?y","/api/v1/x\\y"}) rejects(() -> SafetyPolicy.route(p));
    if(SafetyPolicy.terminal("interrupted") || SafetyPolicy.terminal("paused") || !SafetyPolicy.terminal("completed-with-errors")) throw new AssertionError("report gate");
    if(!SafetyPolicy.fileSuccessful(false,new String[]{"verified","verified"}) || SafetyPolicy.fileSuccessful(false,new String[]{"verified","failed"}) || SafetyPolicy.fileSuccessful(false,new String[]{"verified","mismatch"}) || SafetyPolicy.fileSuccessful(true,new String[]{"verified"}))throw new AssertionError("success-only counters");
    if(!SafetyPolicy.finalState(false,false,1,true).equals("completed-with-errors") || !SafetyPolicy.finalState(false,false,1,false).equals("failed") || !SafetyPolicy.finalState(true,true,1,true).equals("failed"))throw new AssertionError("source precedence and partial targets");
    if(!SafetyPolicy.shouldLaunch("queued","start",false) || SafetyPolicy.shouldLaunch("queued","start",true) || SafetyPolicy.shouldLaunch("running","start",true) || !SafetyPolicy.shouldLaunch("interrupted","resume",false))throw new AssertionError("explicit idempotent start");
    rejects(() -> SafetyPolicy.shouldLaunch("queued","resume",false));
    System.out.println("Android safety policy passed");
  }
}
