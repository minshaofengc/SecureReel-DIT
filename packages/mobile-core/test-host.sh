#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/securereel-core.XXXXXX")
trap '/bin/rm -rf "$BUILD"' EXIT HUP INT TERM
"${CXX:-clang++}" -std=c++17 -Wall -Wextra -Werror -Wno-deprecated-declarations \
  -I"$ROOT/include" "$ROOT/src/core.cpp" "$ROOT/src/hashing.cpp" "$ROOT/src/posix.cpp" \
  "$ROOT/tests/core_test.cpp" -o "$BUILD/core-test"
"$BUILD/core-test"
