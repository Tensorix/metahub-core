const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// The app imports the repo's isomorphic SDK (src/sdk/client.ts) by relative
// path; Metro only bundles what it watches, so widen to the shared src/.
config.watchFolders = [path.join(repoRoot, "src")];
// The repo root has its own node_modules (bun install at root). Pin bare
// specifiers to the app's copy so a second React can never sneak in.
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];

module.exports = config;
