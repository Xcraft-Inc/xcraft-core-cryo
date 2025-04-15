const {join} = require('node:path');
const {arch, platform} = require('node:process');
const {statSync} = require('node:fs');

const supportedPlatforms = [
  ['macos', 'aarch64'],
  ['linux', 'aarch64'],
  ['windows', 'x86_64'],
  ['linux', 'x86_64'],
  ['macos', 'x86_64'],
];

const invalidPlatformErrorMessage = (basePackageName) =>
  `Unsupported platform for ${basePackageName}, on a ${platform}-${arch} machine. Supported platforms are (${supportedPlatforms
    .map(([p, a]) => `${p}-${a}`)
    .join(
      ','
    )}). Consult the ${basePackageName} NPM package README for details.`;

const extensionNotFoundErrorMessage = (basePackageName, packageName) =>
  `Loadble extension for ${basePackageName} not found. Was the ${packageName} package installed?`;

function validPlatform(platform, arch) {
  return (
    supportedPlatforms.find(([p, a]) => platform == p && arch === a) !== null
  );
}

function extensionSuffix(platform) {
  if (platform === 'win32') return 'dll';
  if (platform === 'darwin') return 'dylib';
  return 'so';
}

function platformPackageName(basePackageName, platform, arch) {
  const os = platform === 'win32' ? 'windows' : platform;
  return `${basePackageName}-${os}-${arch}`;
}

function getLoadablePath(basePackageName, entryPointBaseName) {
  if (!validPlatform(platform, arch)) {
    throw new Error(invalidPlatformErrorMessage(basePackageName));
  }

  const packageName = platformPackageName(basePackageName, platform, arch);
  const loadablePath = join(
    __dirname,
    '../../../../node_modules',
    packageName,
    `${entryPointBaseName}.${extensionSuffix(platform)}`
  ).replace('app.asar', 'app.asar.unpacked');

  if (!statSync(loadablePath, {throwIfNoEntry: false})) {
    throw new Error(
      extensionNotFoundErrorMessage(basePackageName, packageName)
    );
  }

  return loadablePath;
}

function load(db) {
  db.loadExtension(getLoadablePath('sqlite-vec', 'vec0'));
  db.loadExtension(getLoadablePath('sqlite-lembed', 'lembed0'));
}

module.exports = {getLoadablePath, load};
