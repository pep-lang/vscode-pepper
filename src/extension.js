// Pepper language support: launches pepper-lsp over stdio and wires it up as
// the language server for .pep files.
const path = require("path");
const fs = require("fs");
const { LanguageClient } = require("vscode-languageclient/node");
const { bundledServer } = require("./serverPath");

/** @type {LanguageClient | null} */
let client = null;

/** @param {import('vscode').ExtensionContext} context */
async function activate(context) {
  const vscode = require("vscode");
  const config = workspaceGetConfig();
  const serverPath = resolveServerPath(config);
  if (!serverPath) {
    showLspMissing(config);
    return; // highlighting still works without the server
  }
  const shadowDir = path.join(context.globalStorageUri.fsPath, "server");

  const start = async () => {
    // Run a copy, never the binary itself: Windows locks a running exe, which
    // would stop `cargo build` or a reinstall of this extension replacing it.
    const command = shadowCopy(serverPath, shadowDir);
    // pepper-lsp is a native binary, so launch it as a command over stdio.
    client = new LanguageClient(
      "pepper",
      "Pepper Language Server",
      { run: { command }, debug: { command } },
      {
        documentSelector: [{ language: "pep" }],
        synchronize: { fileEvents: [] },
        // Read once per server start; changing the setting restarts it.
        initializationOptions: {
          inlayHints: {
            implicitConversions: vscode.workspace
              .getConfiguration("pepper")
              .get("inlayHints.implicitConversions", true),
          },
        },
      }
    );
    await client.start();
  };
  const restart = async () => {
    if (client) await client.stop();
    await start();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("pepper.restartServer", restart),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pepper.inlayHints.implicitConversions")) restart();
    }),
    watchServer(serverPath, () =>
      restart().then(
        () => vscode.window.setStatusBarMessage("Pepper: language server restarted", 3000),
        (e) => vscode.window.showErrorMessage(`Pepper: server restart failed: ${e}`)
      )
    )
  );
  await start();
}

function deactivate() {
  return client?.stop();
}

/**
 * Restart when the server binary is rebuilt or reinstalled. Polls rather than
 * using fs.watch, which loses the file when cargo or an install replaces it;
 * the debounce lets a build finish writing before the new binary is copied.
 */
function watchServer(serverPath, onChange) {
  let timer = null;
  const listener = (cur, prev) => {
    if (cur.size === 0 || cur.mtimeMs === prev.mtimeMs) return; // gone or unchanged
    clearTimeout(timer);
    timer = setTimeout(onChange, 1500);
  };
  fs.watchFile(serverPath, { interval: 1000 }, listener);
  return { dispose: () => { clearTimeout(timer); fs.unwatchFile(serverPath, listener); } };
}

/**
 * Copies the server into `dir` under a name keyed by its mtime and size, and
 * returns the copy's path. Stale copies are removed best-effort: one still
 * running is locked on Windows and is removed on a later start instead.
 */
function shadowCopy(serverPath, dir) {
  const st = fs.statSync(serverPath);
  const ext = path.extname(serverPath);
  const name = `pepper-lsp-${Math.floor(st.mtimeMs)}-${st.size}${ext}`;
  const copy = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f !== name) fs.rm(path.join(dir, f), { force: true }, () => {});
  }
  if (!fs.existsSync(copy)) {
    fs.copyFileSync(serverPath, copy);
    fs.chmodSync(copy, 0o755);
  }
  return copy;
}

/** @returns {{ lspPath?: string }} */
function workspaceGetConfig() {
  try {
    const vscode = require("vscode");
    return vscode.workspace.getConfiguration("pepper");
  } catch {
    return {};
  }
}

/**
 * Server resolution order:
 * 1. `pepper.lspPath`, if set and it exists — dev override (e.g. a debug build).
 * 2. The bundled server for this platform/arch:
 *    `server/<platform>-<arch>/pepper-lsp[.exe]` next to this extension, placed
 *    there by the CI packaging step (one binary per supported platform).
 */
function resolveServerPath(config) {
  const p = config.lspPath;
  if (p) {
    const found = candidatesFor(p).find((c) => fs.existsSync(c));
    if (found) return found;
  }
  const bundled = bundledServer(path.join(__dirname, ".."));
  if (bundled && fs.existsSync(bundled)) return bundled;
  return null;
}

/** Candidate paths for a configured `pepper.lspPath` value. */
function candidatesFor(p) {
  const candidates = [];
  if (path.isAbsolute(p)) {
    candidates.push(p);
  } else {
    // Relative: try the workspace folders first, then this extension's repo root.
    try {
      const vscode = require("vscode");
      const folders = vscode.workspace.workspaceFolders;
      for (const f of folders ?? []) {
        candidates.push(path.join(f.uri.fsPath, p));
      }
    } catch {}
    // Fallback: the repo root (this file lives at tools/vscode-pepper/src).
    candidates.push(path.join(__dirname, "..", "..", "..", p));
  }
  if (process.platform === "win32" && !p.endsWith(".exe")) {
    for (const c of [...candidates]) candidates.push(c + ".exe");
  }
  return candidates;
}

function showLspMissing(config) {
  try {
    const vscode = require("vscode");
    vscode.window.showWarningMessage(
      `Pepper language server not found${config.lspPath ? ` at '${config.lspPath}'` : ""}. Install the packaged extension (it bundles the server) or build it with 'cargo build -p pepper-lsp' and set 'pepper.lspPath'. Syntax highlighting still works.`
    );
  } catch {}
}

module.exports = { activate, deactivate };
