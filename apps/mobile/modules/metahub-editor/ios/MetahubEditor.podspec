Pod::Spec.new do |s|
  s.name = 'MetahubEditor'
  s.version = '1.0.0'
  s.summary = 'One-shot local WebKit surfaces for the Metahub document editor'
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
