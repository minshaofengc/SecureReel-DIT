Pod::Spec.new do |s|
  s.name = 'SecureReelNative'
  s.version = '0.1.0'
  s.summary = 'Native verified storage and pinned LAN transport'
  s.homepage = 'https://github.com/minshaofengc/SecureReel-DIT'
  s.license = { :type => 'GPL-3.0-only', :file => '../../../../LICENSE' }
  s.author = 'SecureReel contributors'
  s.platform = :ios, '17.0'
  s.source = { :path => '.' }
  s.source_files = '*.{h,hpp,mm}', '../../../mobile-core/include/**/*.hpp', '../../../mobile-core/src/*.cpp'
  s.preserve_paths = '../../../mobile-core/vendor/*'
  s.frameworks = 'Foundation', 'UIKit', 'Security', 'WebKit', 'UniformTypeIdentifiers'
  s.libraries = 'sqlite3'
  s.pod_target_xcconfig = { 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17', 'HEADER_SEARCH_PATHS' => '$(PODS_TARGET_SRCROOT)/../../../mobile-core/include', 'GCC_WARN_ABOUT_DEPRECATED_FUNCTIONS' => 'NO' }
  install_modules_dependencies(s)
end
