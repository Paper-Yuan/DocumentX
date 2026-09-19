/**
 * Payload integrity checks for the Windows installer.
 *
 * The installer ships a copy of the Node backend, so a module that is referenced but not
 * copied produces a build that only fails after the user installs and launches it
 * (MODULE_NOT_FOUND). These helpers make that class of mistake detectable at build time, and
 * are kept separate from build_installer.js so they can be unit tested without running a
 * full build.
 */
const fs = require('fs');
const path = require('path');

/**
 * Collect every local module a JavaScript file depends on via require('./...').
 * Bare specifiers are Node builtins and are always available, so only relative ones matter.
 */
function localRequiresOf(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const found = new Set();
  const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

/** Resolve a relative require() target the way Node would: file, then directory index. */
function resolveLocalModule(fromFilePath, specifier) {
  const base = path.resolve(path.dirname(fromFilePath), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.json`,
    path.join(base, 'index.js')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Backend modules that must be bundled: every .js file at the hub root. Discovered rather
 * than hardcoded so adding a module cannot silently leave it out of the installer.
 */
function backendModulesOf(hubDir) {
  return fs.readdirSync(hubDir)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

/**
 * Check that every require() target in the staging directory is present.
 * @returns {{jsFiles: string[], missing: string[]}}
 */
function verifyStagedPayload(stagingDir) {
  const jsFiles = fs.readdirSync(stagingDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(stagingDir, name));

  const missing = [];
  for (const file of jsFiles) {
    for (const specifier of localRequiresOf(file)) {
      if (!resolveLocalModule(file, specifier)) {
        missing.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
  }
  return { jsFiles: jsFiles.map((f) => path.basename(f)).sort(), missing };
}

/**
 * Verify a source directory directly, without staging. Used by tests and as a pre-flight
 * check: it answers "would the installer have everything this backend needs?".
 */
function verifyBackendSource(hubDir) {
  const modules = backendModulesOf(hubDir);
  const missing = [];
  for (const name of modules) {
    for (const specifier of localRequiresOf(path.join(hubDir, name))) {
      if (!resolveLocalModule(path.join(hubDir, name), specifier)) {
        missing.push(`${name} -> ${specifier}`);
      }
    }
  }
  return { modules, missing };
}

/**
 * Read the product version from its single source of truth, APP_VERSION in server.js.
 * Every other surface (Tauri bundle, Android, installer C# components) must agree with it.
 */
function productVersionOf(serverJsPath) {
  const source = fs.readFileSync(serverJsPath, 'utf8');
  const match = source.match(/APP_VERSION\s*=\s*'([^']+)'/);
  if (!match) throw new Error(`APP_VERSION not found in ${serverJsPath}`);
  return match[1];
}

/** Every version literal a C# component declares: assembly attributes and the Uninstall entry. */
function declaredVersionsIn(csSource) {
  const versions = [];
  const patterns = [
    /Assembly(?:File|Informational)?Version\(\s*"([^"]+)"\s*\)/g,
    /"DisplayVersion"\s*,\s*"([^"]+)"/g
  ];
  for (const pattern of patterns) {
    for (const match of csSource.matchAll(pattern)) versions.push(match[1]);
  }
  return versions;
}

/** Compare on the first three components: assembly attributes carry a fourth build field. */
function normalizeVersion(value) {
  return String(value).trim().split('.').slice(0, 3).join('.');
}

/**
 * The installer's C# components hardcode their version separately from APP_VERSION, and they
 * previously drifted (still 1.0.1 while everything else moved on), which surfaced only in the
 * Windows file properties and Programs-and-Features entry. Failing the build here keeps that
 * from shipping again.
 *
 * @returns {{productVersion: string, mismatches: string[]}}
 */
function verifySourceVersions({ serverJsPath, csFiles }) {
  const productVersion = productVersionOf(serverJsPath);
  const mismatches = [];
  for (const file of csFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const declared = declaredVersionsIn(source);
    if (declared.length === 0) {
      mismatches.push(`${path.basename(file)}: declares no version`);
      continue;
    }
    for (const value of declared) {
      if (normalizeVersion(value) !== productVersion) {
        mismatches.push(`${path.basename(file)}: declares ${value}, expected ${productVersion}`);
      }
    }
  }
  return { productVersion, mismatches };
}

module.exports = {
  localRequiresOf,
  resolveLocalModule,
  backendModulesOf,
  verifyStagedPayload,
  verifyBackendSource,
  productVersionOf,
  declaredVersionsIn,
  verifySourceVersions
};
