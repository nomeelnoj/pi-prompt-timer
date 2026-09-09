// Pack a real tarball, install it into a throwaway project alongside the pinned
// Pi peers, load the packed TypeScript through jiti, and assert the extension
// registers its handlers, command, and shortcut.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const jitiUrl = import.meta.resolve("jiti");

// Resolve npm portably: Windows cannot spawn the npm shim directly, so route
// through Node with the invoking npm_execpath when one is present.
const npmExec = process.env.npm_execpath;
const [npmCmd, npmPrefix] = npmExec ? [process.execPath, [npmExec]] : ["npm", []];
const npm = (args, opts) => execFileSync(npmCmd, [...npmPrefix, ...args], { encoding: "utf8", ...opts });

// Peers are installed at their pinned development versions so the packed source
// can resolve its imports in isolation.
const peers = Object.keys(pkg.peerDependencies).map((name) => `${name}@${pkg.devDependencies[name]}`);

const work = mkdtempSync(path.join(tmpdir(), "pi-prompt-timer-smoke-"));
try {
  const [{ filename }] = JSON.parse(npm(["pack", "--json", "--pack-destination", work], { cwd: root }));
  npm(["init", "--yes"], { cwd: work, stdio: "ignore" });
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-save", path.join(work, filename), ...peers], { cwd: work });

  const installed = path.join(work, "node_modules", ...pkg.name.split("/"));
  const entry = path.join(installed, pkg.pi.extensions[0]);

  const harness = `
    import assert from "node:assert/strict";
    import { createJiti } from ${JSON.stringify(jitiUrl)};

    const ext = await createJiti(import.meta.url, { moduleCache: false }).import(${JSON.stringify(entry)});
    const events = [];
    const commands = [];
    const shortcuts = [];
    ext.default({
      on: (event) => events.push(event),
      registerCommand: (name) => commands.push(name),
      registerShortcut: (shortcut) => shortcuts.push(shortcut),
    });

    const requiredEvents = [
      "input", "agent_start", "message_end", "ui_prompt_start",
      "ui_prompt_end", "agent_settled", "session_start", "session_shutdown",
    ];
    for (const event of requiredEvents) {
      assert.ok(events.includes(event), \`missing event handler: \${event}\`);
    }
    assert.ok(commands.includes("timer"), "missing /timer command");
    assert.ok(shortcuts.includes("ctrl+alt+t"), "missing ctrl+alt+t shortcut");
    console.log(\`\${requiredEvents.length} handlers, /timer, ctrl+alt+t\`);
  `;
  const harnessPath = path.join(work, "smoke.mjs");
  writeFileSync(harnessPath, harness);
  const summary = execFileSync(process.execPath, [harnessPath], { cwd: work, encoding: "utf8" }).trim();

  console.log(`smoke-package: ${pkg.name}@${pkg.version}: ${summary}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
