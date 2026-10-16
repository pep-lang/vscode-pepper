// Toolchain helpers with no vscode dependency, so a plain node test can
// exercise them (`npm test`).

const INSTALL_SCRIPTS = "https://raw.githubusercontent.com/justinboswell/pepper/main/scripts";

/**
 * The `pepper install ...` command an error from `pepper install which`
 * suggests (`install it with 'pepper install add 0.3'`), as the arguments
 * after `pepper`; null when it suggests none.
 */
function suggestedInstall(message) {
  const found = /'pepper (install (?:add|update)[^']*)'/.exec(message);
  return found ? found[1].trim().split(/\s+/) : null;
}

/** True when version `a` (`0.9.2`) is older than `b`; a prerelease counts as its release. */
function isOlder(a, b) {
  const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

/** The program and arguments that run the install script on `platform`. */
function installerCommand(platform) {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_SCRIPTS}/install.ps1 | iex`],
    };
  }
  return { command: "/bin/sh", args: ["-c", `curl -fsSL ${INSTALL_SCRIPTS}/install.sh | sh`] };
}

module.exports = { suggestedInstall, isOlder, installerCommand };
