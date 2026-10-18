#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
set -eu
cd "$(dirname "$0")"
: "${JAVA_HOME:?Set JAVA_HOME to JDK 21}"
task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
"$JAVA_HOME/bin/javac" -d "$task_tmp/classes" app/src/main/java/com/securereelmobile/nativebridge/SafetyPolicy.java app/src/test/java/com/securereelmobile/nativebridge/SafetyPolicyTest.java app/src/test/java/com/securereelmobile/nativebridge/NativeStreamingTest.java
"$JAVA_HOME/bin/java" -cp "$task_tmp/classes" com.securereelmobile.nativebridge.SafetyPolicyTest
case "$(uname -s)" in
  Darwin) task_jni_os=darwin; task_suffix=dylib ;;
  Linux) task_jni_os=linux; task_suffix=so ;;
  *) exit 1 ;;
esac
c++ -std=c++17 -shared -fPIC -Wno-deprecated-declarations -DSECUREREEL_JNI_HOST_TEST -I"$JAVA_HOME/include" -I"$JAVA_HOME/include/$task_jni_os" -I../../mobile-core/include app/src/main/cpp/streaming/bridge.cpp ../../mobile-core/src/core.cpp ../../mobile-core/src/hashing.cpp ../../mobile-core/src/posix.cpp -o "$task_tmp/libsecurereel.$task_suffix"
"$JAVA_HOME/bin/java" -cp "$task_tmp/classes" com.securereelmobile.nativebridge.NativeStreamingTest "$task_tmp/libsecurereel.$task_suffix"
