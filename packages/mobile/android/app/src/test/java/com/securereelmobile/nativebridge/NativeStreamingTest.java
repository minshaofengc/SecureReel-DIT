// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge;
import java.nio.file.*;
import java.security.MessageDigest;
public final class NativeStreamingTest {
  private static native String verifyFile(int source,int[] targets,String algorithm,Gate gate);
  private static native String copyFile(String source,String[] targets,String relative,String algorithm,Gate gate);
  private static native String copyFileExpected(String source,String[] targets,String relative,String algorithm,long expectedBytes,Gate gate);
  private static native int open(String path);
  private static native void close(int fd);
  public static class Gate { public String[] intents={"",""};public String recoveryHash(int target){return intents[target];}public void prepareCommit(int target,String hash,long bytes){intents[target]=hash;}public boolean cancelled; public boolean awaitChunk(){return !cancelled;} }
  private static void check(boolean okay,String message){if(!okay)throw new AssertionError(message);}
  public static void main(String[] args)throws Exception {
    System.load(args[0]);Path dir=Files.createTempDirectory("securereel-jni-");Path src=dir.resolve("source");Path target=dir.resolve("target");Path corrupt=dir.resolve("corrupt");
    byte[] bytes=new byte[3*1024*1024+17];for(int i=0;i<bytes.length;i++)bytes[i]=(byte)(i%251);
    Files.write(src,bytes);Files.write(target,bytes);Files.write(corrupt,new byte[]{1,2,3});int s=open(src.toString()),t=open(target.toString()),c=open(corrupt.toString());
    try {
      for(String algorithm:new String[]{"md5","sha1","sha256","xxhash64","xxh3","xxh128","asc-c4"}){
        String result=verifyFile(s,new int[]{t,c},algorithm,new Gate());
        check(result.contains("\"status\":\"verified\""),algorithm+" target verified");check(result.contains("\"status\":\"mismatch\""),algorithm+" corruption detected");check(result.contains("\"sourceFailed\":false"),"source readable");
        if(algorithm.equals("md5")||algorithm.equals("sha1")||algorithm.equals("sha256")){
          String platform=algorithm.equals("md5")?"MD5":algorithm.equals("sha1")?"SHA-1":"SHA-256";String hash=java.util.HexFormat.of().formatHex(MessageDigest.getInstance(platform).digest(bytes));
          check(result.contains("\"sourceHash\":\""+hash+"\""),"independent digest");
        }
      }
      String missing=verifyFile(s,new int[]{-1,t},"sha256",new Gate());check(missing.contains("\"status\":\"failed\""),"missing target");check(missing.contains("\"status\":\"verified\""),"independent good target");
      Gate gate=new Gate();gate.cancelled=true;check(verifyFile(s,new int[]{t},"sha256",gate).contains("\"cancelled\":true"),"chunk cancellation");
      check(verifyFile(-1,new int[]{t},"sha256",new Gate()).contains("\"sourceFailed\":true"),"source failure priority");
      check(java.util.Arrays.equals(Files.readAllBytes(src),bytes),"source unchanged");check(java.util.Arrays.equals(Files.readAllBytes(target),bytes),"target unchanged");
      Path sourceRoot=Files.createDirectory(dir.resolve("sourceRoot"));Path targetRoot=Files.createDirectory(dir.resolve("targetRoot"));Path otherRoot=Files.createDirectory(dir.resolve("otherRoot"));
      Files.write(sourceRoot.resolve("clip.mxf"),bytes);
      Gate committed=new Gate();
      String copied=copyFile(sourceRoot.toString(),new String[]{targetRoot.toString(),otherRoot.toString()},"clip.mxf","sha256",committed);
      check(copied.indexOf("verified")!=copied.lastIndexOf("verified"),"two direct targets verified");
      check(java.util.Arrays.equals(Files.readAllBytes(targetRoot.resolve("clip.mxf")),bytes),"copy readback");
      String recovered=copyFile(sourceRoot.toString(),new String[]{targetRoot.toString(),otherRoot.toString()},"clip.mxf","sha256",committed);
      check(recovered.indexOf("verified")!=recovered.lastIndexOf("verified"),"recover independently verified published targets after lost checkpoint");
      Files.write(sourceRoot.resolve("shortened.mxf"),new byte[]{1});
      String shortSource=copyFileExpected(sourceRoot.toString(),new String[]{targetRoot.toString(),otherRoot.toString()},"shortened.mxf","sha256",bytes.length,new Gate());
      check(shortSource.contains("\"sourceFailed\":true")&&!Files.exists(targetRoot.resolve("shortened.mxf"))&&!Files.exists(otherRoot.resolve("shortened.mxf")),"inventoried source truncation must not publish");
      Files.write(targetRoot.resolve("occupied.mxf"),new byte[]{9});Files.write(sourceRoot.resolve("occupied.mxf"),bytes);
      String collision=copyFile(sourceRoot.toString(),new String[]{targetRoot.toString()},"occupied.mxf","sha256",new Gate());check(collision.contains("collision"),"no-replace collision");check(Files.readAllBytes(targetRoot.resolve("occupied.mxf"))[0]==9,"occupied preserved");
      Files.write(sourceRoot.resolve("isolated.mxf"),bytes);
      String isolated=copyFile(sourceRoot.toString(),new String[]{dir.resolve("unplugged").toString(),otherRoot.toString()},"isolated.mxf","sha256",new Gate());
      check(isolated.contains("failed")&&isolated.contains("verified")&&isolated.contains("\"sourceFailed\":false"),"unavailable copy target isolated");
      String unicode="镜头🎬.mxf";Files.write(sourceRoot.resolve(unicode),bytes);
      check(copyFile(sourceRoot.toString(),new String[]{otherRoot.toString()},unicode,"sha256",new Gate()).contains("verified"),"Unicode filesystem encoding");check(java.util.Arrays.equals(Files.readAllBytes(otherRoot.resolve(unicode)),bytes),"Unicode copied contents");
      Gate cancelled=new Gate();cancelled.cancelled=true;
      check(copyFile(sourceRoot.toString(),new String[]{targetRoot.toString()},"clip.mxf","sha256",cancelled).contains("cancelled"),"copy cancellation");
      for(Path root:new Path[]{sourceRoot,targetRoot,otherRoot}){try(java.util.stream.Stream<Path> entries=Files.list(root)){for(Path path:entries.toList())Files.delete(path);}Files.delete(root);}
      System.out.println("Android JNI stream/digest/corruption/cancellation/direct-copy tests passed");
    } finally {close(s);close(t);close(c);try(java.util.stream.Stream<Path> paths=Files.walk(dir)){for(Path path:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.delete(path);}}
  }
}
