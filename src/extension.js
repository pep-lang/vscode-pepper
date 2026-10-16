// Pepper language support: launches pep-lsp over stdio and wires it up as
// the language server for .pep files.
const path = require("path");
const fs = require("fs");
const { LanguageClient } = require("vscode-languageclient/node");
const { bundledServer } = require("./serverPath");
const { suggestedInstall, isOlder, installerCommand } = require("./toolchain");

/** @type {LanguageClient | null} */
let client = null;

/** @param {import('vscode').ExtensionContext} context */
async function activate(context) {
  const vscode = require("vscode");
  const config = workspaceGetConfig();
  const server = resolveServer(config, context);
  const serverPath = server?.path;
  if (!serverPath) {
    showLspMissing(config);
    return; // highlighting still works without the server
  }
  const shadowDir = path.join(context.globalStorageUri.fsPath, "server");
  // One channel for every server this window starts, so a restart appends
  // to the same output instead of adding another "Pepper Language Server".
  const outputChannel = vscode.window.createOutputChannel("Pepper Language Server");
  context.subscriptions.push(outputChannel);

  const start = async () => {
    // Run a copy, never the binary itself: Windows locks a running exe, which
    // would stop a rebuild (`pep-build ... -o pep-lsp`) or a reinstall of this extension replacing it.
    const command = shadowCopy(serverPath, shadowDir);
    // pep-lsp is a native binary, so launch it as a command over stdio.
    client = new LanguageClient(
      "pepper",
      "Pepper Language Server",
      { run: { command, options: server.options }, debug: { command, options: server.options } },
      {
        documentSelector: [{ language: "pep" }],
        outputChannel,
        synchronize: { fileEvents: [] },
        // Read once per server start; changing the setting restarts it.
        initializationOptions: {
          inlayHints: {
            implicitConversions: vscode.workspace
              .getConfiguration("pepper")
              .get("inlayHints.implicitConversions", true),
            parameterNames: vscode.workspace
              .getConfiguration("pepper")
              .get("inlayHints.parameterNames", true),
          },
          buildOptions: vscode.workspace
            .getConfiguration("pepper")
            .get("buildOptions", []),
        },
      }
    );
    try {
      await client.start();
    } catch (e) {
      await client.dispose().catch(() => {});
      client = null;
      throw e;
    }
  };
  // Restarts run one at a time: a rebuild and a settings change can ask
  // together, and two overlapping restarts would leave two servers running.
  let restarting = Promise.resolve();
  const restart = (reason) =>
    (restarting = restarting.catch(() => {}).then(async () => {
      outputChannel.appendLine(`[Info  - ${new Date().toLocaleTimeString()}] Restarting: ${reason}.`);
      const old = client;
      client = null;
      // A server that already exited (it crashed, or a reinstall replaced
      // it) fails to stop; start the new one anyway.
      if (old) await old.stop().catch(() => {});
      await startWithRetry(start);
    }));

  context.subscriptions.push(
    vscode.commands.registerCommand("pepper.restartServer", () => restart("requested")),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pepper.inlayHints") || e.affectsConfiguration("pepper.buildOptions")) {
        restart("settings changed");
      }
    }),
    watchServer(serverPath, () =>
      restart("the server binary changed").then(
        () => vscode.window.setStatusBarMessage("Pepper: language server restarted", 3000),
        (e) => vscode.window.showErrorMessage(`Pepper: server restart failed: ${e}`)
      )
    )
  );
  await startWithRetry(start);
}

/**
 * Runs `start`, retrying a few times: right after a reinstall the new binary
 * can still be settling on disk, and launching it then fails ("spawn
 * UNKNOWN" on Windows).
 */
async function startWithRetry(start) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function deactivate() {
  // The server may already be gone; stopping it then is not an error.
  return client?.stop().catch(() => {});
}

/**
 * Restart when the server binary is rebuilt or reinstalled. Polls rather than
 * using fs.watch, which loses the file when a rebuild or an install replaces it;
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
  const name = `pep-lsp-${Math.floor(st.mtimeMs)}-${st.size}${ext}`;
  const copy = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f !== name) fs.rm(path.join(dir, f), { force: true }, () => {});
  }
  if (!fs.existsSync(copy)) {
    // Copy under a temporary name and rename once complete, so a copy cut
    // short (the source still being written) is never reused as the server.
    const partial = `${copy}.${process.pid}.tmp`;
    fs.copyFileSync(serverPath, partial);
    if (fs.statSync(partial).size !== st.size) {
      fs.rmSync(partial, { force: true });
      throw new Error(`${serverPath} changed while it was being copied`);
    }
    fs.chmodSync(partial, 0o755);
    fs.renameSync(partial, copy);
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
 * 2. The `pep-lsp` of the toolchain the first workspace folder uses, when
 *    `pepper install` manages a Pepper home (see toolchainServer).
 * 3. The bundled server for this platform/arch:
 *    `server/<platform>-<arch>/pep-lsp[.exe]` next to this extension, placed
 *    there by the CI packaging step (one binary per supported platform).
 *
 * Returns `{ path, options }`, where `options` are the spawn options the
 * server runs with, or null when there is none.
 */
function resolveServer(config, context) {
  const p = config.lspPath;
  if (p) {
    const found = candidatesFor(p).find((c) => fs.existsSync(c));
    if (found) return { path: found, options: {} };
  }
  const fromToolchain = toolchainServer(context);
  if (fromToolchain) return fromToolchain;
  const bundled = bundledServer(path.join(__dirname, ".."));
  if (bundled && fs.existsSync(bundled)) return { path: bundled, options: {} };
  return null;
}

/**
 * The `pep-lsp` of the toolchain the first workspace folder uses, asked of
 * `pepper install which` there so the editor picks the toolchain the way
 * `pepper` does (`PEPPER_TOOLCHAIN`, then the project's pep.toml, then the
 * default). Null when there is no Pepper home, or it names no usable
 * toolchain (a warning says why and the bundled server runs instead).
 *
 * Offers to install what is missing: Pepper itself when there is no home,
 * the toolchain `pepper install which` suggests when the one chosen is not
 * installed, and an update when the default is older than this extension.
 *
 * The server runs from a copy outside the toolchain (see shadowCopy), so it
 * is pointed at the toolchain's runtime with PEPPER_RUNTIME.
 */
function toolchainServer(context) {
  const home = pepperHome();
  const exe = process.platform === "win32" ? ".exe" : "";
  const pepper = home ? path.join(home, "bin", "pepper" + exe) : null;
  if (!pepper || !fs.existsSync(pepper)) {
    const installer = installerCommand(process.platform);
    offerInstall(context, "Pepper: no Pepper toolchain is installed; the bundled language server runs.", "Install Pepper", installer.command, installer.args);
    return null;
  }
  let cwd = undefined;
  try {
    cwd = require("vscode").workspace.workspaceFolders?.[0]?.uri.fsPath;
  } catch {}
  const ran = require("child_process").spawnSync(pepper, ["install", "which"], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  if (ran.status !== 0) {
    const why = (ran.stderr || String(ran.error ?? "")).trim();
    const message = `Pepper: using the bundled language server: 'pepper install which' failed: ${why}`;
    const install = suggestedInstall(why);
    if (!install) {
      showWarning(message);
      return null;
    }
    offerInstall(context, message, "Install", pepper, install);
    return null;
  }
  const [chosen, compilerLine] = ran.stdout.split(/\r?\n/);
  const compiler = compilerLine?.trim();
  if (!compiler) return null;
  // Only the default is updated: a toolchain a project pins or
  // PEPPER_TOOLCHAIN names is that choice's to change.
  const wanted = require("../package.json").version;
  const version = chosen.split(" ")[0];
  if (chosen.endsWith("(the default)") && isOlder(version, wanted)) {
    offerInstall(context, `Pepper: the default toolchain, ${version}, is older than this extension (${wanted}).`, "Update", pepper, ["install", "update"]);
  }
  const bin = path.dirname(compiler);
  const server = path.join(bin, "pep-lsp" + exe);
  if (!fs.existsSync(server)) {
    showWarning(`Pepper: using the bundled language server: the toolchain has no ${server}.`);
    return null;
  }
  const env = { ...process.env, PEPPER_RUNTIME: path.join(path.dirname(bin), "runtime") };
  return { path: server, options: { env } };
}

/**
 * The Pepper home `pepper install` manages: `PEPPER_HOME`, else
 * `%LOCALAPPDATA%\pepper` on Windows or `~/.pepper`, when it has a
 * `toolchains` folder.
 */
function pepperHome() {
  let home = process.env.PEPPER_HOME;
  if (!home) {
    const local = process.platform === "win32" ? process.env.LOCALAPPDATA : null;
    home = local ? path.join(local, "pepper") : path.join(require("os").homedir(), ".pepper");
  }
  if (!fs.existsSync(path.join(home, "toolchains"))) return null;
  return home;
}

/**
 * Offers `action`, which runs `command` with `args` as a task, so its
 * progress and any error show in a terminal; once it succeeds, offers to
 * reload the window, which picks the new toolchain up. "Don't Ask Again"
 * stops this offer for this command line.
 */
async function offerInstall(context, message, action, command, args) {
  let vscode;
  try {
    vscode = require("vscode");
  } catch {
    return;
  }
  const key = `pepper.declined:${[path.basename(command), ...args].join(" ")}`;
  if (context?.globalState.get(key)) return;
  const never = "Don't Ask Again";
  const choice = await vscode.window.showWarningMessage(message, action, never);
  if (choice === never) return context?.globalState.update(key, true);
  if (choice !== action) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const task = new vscode.Task(
    { type: "pepper" },
    folder ?? vscode.TaskScope.Global,
    args[0] === "install" ? `pepper ${args.join(" ")}` : action,
    "pepper",
    new vscode.ProcessExecution(command, args, folder ? { cwd: folder.uri.fsPath } : {})
  );
  const running = await vscode.tasks.executeTask(task);
  const ended = vscode.tasks.onDidEndTaskProcess(async (e) => {
    if (e.execution !== running) return;
    ended.dispose();
    if (e.exitCode !== 0) {
      vscode.window.showErrorMessage(`Pepper: '${task.name}' failed (exit ${e.exitCode}); its terminal shows why.`);
      return;
    }
    const reload = "Reload Window";
    if ((await vscode.window.showInformationMessage("Pepper: the toolchain is installed.", reload)) === reload) {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  });
  context?.subscriptions.push(ended);
}

function showWarning(message) {
  try {
    require("vscode").window.showWarningMessage(message);
  } catch {}
}

/**
 * Candidate paths for a configured `pepper.lspPath` value. A path to the
 * server's old name, `pepper-lsp`, tries the current `pep-lsp` beside it
 * first, so a setting made before the rename keeps finding fresh builds.
 */
function candidatesFor(p) {
  const base = path.basename(p);
  if (base.startsWith("pepper-lsp")) {
    const renamed = path.join(path.dirname(p), "pep-lsp" + base.slice("pepper-lsp".length));
    return [...candidatesForPath(renamed), ...candidatesForPath(p)];
  }
  return candidatesForPath(p);
}

function candidatesForPath(p) {
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
      `Pepper language server not found${config.lspPath ? ` at '${config.lspPath}'` : ""}. Install the packaged extension (it bundles the server) or build it with 'pep-build -O tools/pep-lsp/main.pep -o pep-lsp' and set 'pepper.lspPath'. Syntax highlighting still works.`
    );
  } catch {}
}

module.exports = { activate, deactivate };
