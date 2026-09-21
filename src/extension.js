// Pepper language support: launches pepper-lsp over stdio and wires it up as
// the language server for .pep files.
const path = require("path");
const fs = require("fs");
const { LanguageClient } = require("vscode-languageclient/node");
const { bundledServer } = require("./serverPath");

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  const config = workspaceGetConfig();
  const serverModule = resolveServerPath(config);
  if (!serverModule) {
    showLspMissing(config);
    return; // highlighting still works without the server
  }

  // pepper-lsp is a native binary, so launch it as a command over stdio.
  const serverOptions = {
    run: { command: serverModule },
    debug: { command: serverModule },
  };

  const clientOptions = {
    documentSelector: [{ language: "pep" }],
    synchronize: { fileEvents: [] },
  };

  const client = new LanguageClient(
    "pepper",
    "Pepper Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client.start());
}

function deactivate() {}

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
