# Pepper for Visual Studio Code

Language support for [Pepper](https://github.com/pep-lang/pepper): syntax
highlighting and a language server, which reports compiler errors as you type
and provides hover information, completion, go to definition, inlay hints and
an outline of each file.

## Installing

Download `pepper-language.vsix` from the
[releases page](https://github.com/pep-lang/vscode-pepper/releases) and run
**Extensions: Install from VSIX...** from the command palette.

The extension uses the language server (`pep-lsp`) of the Pepper toolchain
installed for the workspace (`pepper install which`). Without one, it uses the
server bundled with it, for Windows x64, Linux x64 and macOS arm64, and offers
to install the toolchain.

## Settings

| Setting | What it does |
| --- | --- |
| `pepper.lspPath` | A language server you built yourself, used instead; the server restarts whenever that file changes |
| `pepper.inlayHints.implicitConversions` | Shows the constructor call an `[Implicit]` conversion inserts (default on) |
| `pepper.inlayHints.parameterNames` | Shows the parameter name before a literal passed by position (default on) |
| `pepper.buildOptions` | The `-D` build options the language server assumes, as `NAME` or `NAME=VALUE` |

**Pepper: Restart Language Server** restarts the server on demand.

## Developing

```bash
npm ci
npm test          # the toolchain helpers' tests
npm run bundle    # dist/extension.js
```

Open this folder in VS Code and run **Run Pepper Extension** (F5) to try it.
The language server itself lives in the Pepper repository, in `tools/pep-lsp`.

## Releasing

The **VSIX** workflow (`gh workflow run vsix.yml`) takes `pep-lsp` from the
release archives of a Pepper version (`-f pepper_version=0.10.0`; default:
the newest release), bundles it, and publishes the `.vsix` on the release
`v<version>`, the version in `package.json`. Bump that version first to
publish a new release; a dispatch on another branch keeps the `.vsix` as a run
artifact instead.

## License

Apache-2.0; see [LICENSE](LICENSE).
