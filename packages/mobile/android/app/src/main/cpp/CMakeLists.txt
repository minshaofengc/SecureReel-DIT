# SPDX-License-Identifier: GPL-3.0-only
cmake_minimum_required(VERSION 3.22)
project(appmodules LANGUAGES CXX)
# Preserve React Native's generated TurboModule/Fabric and autolinking bootstrap.
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/../../../../../../mobile-core ${CMAKE_CURRENT_BINARY_DIR}/core)
add_library(securereel_android SHARED streaming/bridge.cpp)
target_compile_features(securereel_android PRIVATE cxx_std_17)
target_link_libraries(securereel_android securereel_mobile_core)
