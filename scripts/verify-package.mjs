// Verify the published tarball contains exactly the declared files, carries no
// runtime dependencies, and runs no install lifecycle scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

// Identity must agree between the manifest and its lockfile.
assert.equal(lock.name, pkg.name, "package-lock.json name must match package.json");
assert.equal(lock.version, pkg.version, "package-lock.json version must match package.json");

// A Pi extension ships source only: no runtime deps and no lifecycle scripts.
assert.equal(pkg.dependencies, undefined, "the package must not declare runtime dependencies");
assert.equal(pkg.optionalDependencies, undefined, "the package must not declare optional dependencies");
for (const hook of ["preinstall", "install", "postinstall"]) {
  assert.equal(pkg.scripts?.[hook], undefined, `the package must not define a ${hook} script`);
}

// Resolve npm portably: Windows cannot spawn the npm shim directly, so route
// through Node with the invoking npm_execpath when one is present.
const npmExec = process.env.npm_execpath;
const [cmd, prefix] = npmExec ? [process.execPath, [npmExec]] : ["npm", []];
const packed = JSON.parse(execFileSync(cmd, [...prefix, "pack", "--dry-run", "--json"], { encoding: "utf8" }));

const shipped = packed[0].files.map((entry) => entry.path).sort();
const declared = [...pkg.files, "package.json"].sort();
assert.deepEqual(shipped, declared, "tarball contents must match the declared files list");
assert.deepEqual(packed[0].bundled ?? [], [], "the package must not bundle dependencies");

console.log(`verify-package: ${pkg.name}@${pkg.version} ships ${shipped.length} files`);
