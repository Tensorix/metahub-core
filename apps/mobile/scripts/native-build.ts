/** CNG Release builds. Run from a disposable checkout: prebuild --clean replaces native trees. */
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { applicationBuildEnvironment, assertApplicationBuild } from './native-build-policy';
import { captureBuildSources } from './native-build-provenance';

// Fail before creating output files or invoking CNG. Diagnostics use a separate manual build.
assertApplicationBuild(process.env);

const platform = process.argv[2];
if (platform !== 'android' && platform !== 'ios') throw new Error('Usage: bun apps/mobile/scripts/native-build.ts android|ios');
if (platform === 'ios' && process.platform !== 'darwin') throw new Error('iOS builds require macOS and Xcode');
const root = resolve(import.meta.dir, '../../..');
const app = join(root, 'apps/mobile');
const out = join(app, 'dist/native', platform);
await mkdir(out, { recursive: true });
const logFile = Bun.file(join(out, 'build.log')).writer();

async function command(args: string[], cwd = app, quiet = false): Promise<string> {
  logFile.write(`\n$ ${args.join(' ')}\n`);
  const child = Bun.spawn(args, {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...applicationBuildEnvironment(process.env), CI: '1', EXPO_NO_TELEMETRY: '1' },
  });
  let output = '';
  async function drain(stream: ReadableStream<Uint8Array>, capture: boolean) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value: bytes } = await reader.read();
        if (done) break;
        if (!quiet) { logFile.write(bytes); process.stdout.write(bytes); }
        if (capture) output += decoder.decode(bytes, { stream: true });
      }
      if (capture) output += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  await Promise.all([drain(child.stdout, true), drain(child.stderr, false)]);
  if (await child.exited !== 0) throw new Error(`${args[0]} failed with exit ${child.exitCode}; see build.log`);
  return output.trim();
}
async function hash(path: string) {
  const file = Bun.file(path);
  if (!await file.exists()) return null;
  return new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
}
const tools: Record<string, string> = {};
const manifest: Record<string, unknown> = {
  format: 1, platform, configuration: 'Release', buildMode: 'application', artifactClass: 'normal-release-candidate', status: 'failed',
  bun: Bun.version, host: { platform: process.platform, arch: process.arch },
  // Hosted runner image identifiers make image drift visible alongside tool versions.
  runner: { os: process.env.RUNNER_OS ?? null, image: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  artifacts: {}, inputs: {}, tools,
};
try {
  manifest.commit = await command(['git', 'rev-parse', 'HEAD'], root);
  manifest.dirty = Boolean(await command(['git', 'status', '--porcelain', '--untracked-files=all'], root));
  const pkg = await Bun.file(join(app, 'package.json')).json();
  manifest.requestedDependencies = { expo: pkg.dependencies.expo, reactNative: pkg.dependencies['react-native'] };
  manifest.dependencies = {
    expo: (await Bun.file(join(app, 'node_modules/expo/package.json')).json()).version,
    reactNative: (await Bun.file(join(app, 'node_modules/react-native/package.json')).json()).version,
  };
  const inputs: Record<string, string | null> = {};
  for (const path of ['bun.lock', 'package.json', 'apps/mobile/bun.lock', 'apps/mobile/package.json',
    'apps/mobile/app.json', 'apps/mobile/metro.config.js', 'apps/mobile/scripts/native-build.ts',
    'apps/mobile/scripts/native-build-policy.ts']) {
    inputs[path] = await hash(join(root, path));
  }
  manifest.inputs = inputs;
  const config = await command(['bun', '--no-env-file', 'x', '--no-install', 'expo', 'config', '--type', 'public', '--json'], app, true);
  manifest.resolvedConfigSha256 = new Bun.CryptoHasher('sha256').update(config).digest('hex');
  // Config output can include user-provided extra values; only its hash goes in the manifest.
  const expoConfig = JSON.parse(config);
  if (expoConfig.name !== 'Metahub') throw new Error('Update native-build.ts workspace/scheme names when app name changes');
  manifest.sdkVersion = expoConfig.sdkVersion;
  await command(['bun', '--no-env-file', 'run', 'build:editor']);
  await command(['bun', '--no-env-file', 'x', '--no-install', 'expo', 'prebuild', '--clean', '--no-install', '--platform', platform]);
  // CNG/editor generation can change source inputs. Capture what the native compiler consumes.
  const source = await captureBuildSources(root);
  Object.assign(manifest, source);
  manifest.dirty = Boolean(await command(['git', 'status', '--porcelain', '--untracked-files=all'], root));
  if (platform === 'android') {
    tools.java = await command(['java', '--version']);
    if (!/^openjdk 21[. ]|^java 21[. ]/m.test(tools.java)) throw new Error('Android Release requires Java 21');
    tools.gradle = await command(['./gradlew', '--version'], join(app, 'android'));
    await command(['./gradlew', ':app:assembleRelease', '--no-daemon', '--console=plain'], join(app, 'android'));
    const source = join(app, 'android/app/build/outputs/apk/release/app-release.apk');
    const artifact = join(out, 'metahub-release.apk');
    await copyFile(source, artifact);
    manifest.artifacts = { 'metahub-release.apk': { sha256: await hash(artifact), bytes: Bun.file(artifact).size } };
    inputs['android/gradle/wrapper/gradle-wrapper.properties'] = await hash(join(app, 'android/gradle/wrapper/gradle-wrapper.properties'));
    inputs['android/gradle.properties'] = await hash(join(app, 'android/gradle.properties'));
    // APK records package version, min/target SDK and application ID from the actual build.
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required');
    const aaptCandidates = await Array.fromAsync(new Bun.Glob('build-tools/*/aapt').scan({ cwd: sdk, absolute: true }));
    const aapt = aaptCandidates.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (!aapt) throw new Error('Android SDK aapt is required');
    await Bun.write(join(out, 'android-package.txt'), await command([aapt, 'dump', 'badging', artifact]));
  } else {
    tools.xcode = await command(['xcodebuild', '-version']);
    tools.sdk = await command(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version']);
    tools.cocoapods = await command(['pod', '--version']);
    // An earlier artifact's native dependency resolution can be replayed explicitly.
    if (process.env.MOBILE_POD_LOCK) {
      await copyFile(resolve(process.env.MOBILE_POD_LOCK), join(app, 'ios/Podfile.lock'));
    }
    await command(process.env.MOBILE_POD_LOCK ? ['pod', 'install', '--deployment'] : ['pod', 'install'], join(app, 'ios'));
    inputs['ios/Podfile.lock'] = await hash(join(app, 'ios/Podfile.lock'));
    await copyFile(join(app, 'ios/Podfile.lock'), join(out, 'Podfile.lock'));
    await command(['xcodebuild', '-workspace', 'ios/Metahub.xcworkspace', '-scheme', 'Metahub',
      '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', join(out, 'DerivedData'), 'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES', 'build']);
    const builtApp = join(out, 'DerivedData/Build/Products/Release-iphonesimulator/Metahub.app');
    const artifact = join(out, 'metahub-simulator-release.zip');
    await command(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', builtApp, artifact]);
    manifest.artifacts = { 'metahub-simulator-release.zip': { sha256: await hash(artifact), bytes: Bun.file(artifact).size } };
    // Archive only the installable app, not gigabytes of compiler intermediates.
    await rm(join(out, 'DerivedData'), { recursive: true, force: true });
  }
  if ((await captureBuildSources(root)).sourceSha256 !== source.sourceSha256) {
    throw new Error('Build sources changed during native compilation; rebuild a fixed snapshot');
  }
  manifest.tools = tools;
  manifest.status = 'success';
} catch (error) {
  manifest.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (platform === 'ios') await rm(join(out, 'DerivedData'), { recursive: true, force: true });
  await Bun.write(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await logFile.end();
}
