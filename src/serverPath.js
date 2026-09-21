// Bundled-server resolution. Pure function of the host platform/arch — no
// vscode dependency, so it can be exercised in a plain node test.
const path = require("path");

/** The bundled server binary for this platform/arch, or null on an unknown one. */
function bundledServer(extensionDir) {
  const dir = bundledDir();
  if (!dir) return null;
  const name = process.platform === "win32" ? "pepper-lsp.exe" : "pepper-lsp";
  return path.join(extensionDir, "server", dir, name);
}

/** The platform/arch directory the CI packaging step populates. */
function bundledDir() {
  switch (process.platform) {
    case "win32":
      return process.arch === "arm64" ? "win32-arm64" : process.arch === "x64" ? "win32-x64" : null;
    case "darwin":
      return process.arch === "arm64" ? "darwin-arm64" : process.arch === "x64" ? "darwin-x64" : null;
    case "linux":
      return process.arch === "arm64" ? "linux-arm64" : process.arch === "x64" ? "linux-x64" : null;
    default:
      return null;
  }
}

module.exports = { bundledServer, bundledDir };
