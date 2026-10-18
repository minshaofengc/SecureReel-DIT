#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Offline JVM check using the Kotlin compiler and JSON runtime already cached by Gradle.
set -eu
mobile_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
gradle_cache=${GRADLE_USER_HOME:-"$HOME/.gradle"}
compiler=$(rg --files "$gradle_cache/wrapper/dists" | rg '/lib/kotlin-compiler-embeddable-[^/]+\.jar$' | head -n 1)
compiler_lib=$(dirname "$compiler")
json=$(rg --files "$gradle_cache/caches" | rg '/org.json/json/[^/]+/[^/]+/json-[^/]+\.jar$' | head -n 1)
stdlib=$(rg --files "$compiler_lib" | rg '/kotlin-stdlib-[^/]+\.jar$' | head -n 1)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT HUP INT TERM
java_bin=${JAVA_HOME:+"$JAVA_HOME/bin/"}java
"$java_bin" -cp "$compiler_lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath "$json:$stdlib" -d "$output" "$mobile_root/android/app/src/main/java/com/securereelmobile/nativebridge/ProjectData.kt" "$mobile_root/android/app/src/testHost/ProjectDataTest.kt"
"$java_bin" -cp "$output:$json:$stdlib" com.securereelmobile.nativebridge.ProjectDataTestKt
