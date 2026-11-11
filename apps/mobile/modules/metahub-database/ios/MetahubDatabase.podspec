Pod::Spec.new do |s|
  s.name = 'MetahubDatabase'
  s.version = '1.0.0'
  s.summary = 'Reusable local WebKit surfaces for shared databases'
  s.homepage = 'https://github.com/Tensorix/metahub-core'
  s.license = 'AGPL-3.0-only'
  s.author = 'Tensorix'
  s.source = { :git => "#{s.homepage}.git" }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WebKit'
  s.source_files = '*.swift'
end
