# lsp-proxy

LSP proxy for `.djs` files. Delegates everything to `typescript-language-server`
(autocompletion, hover, go-to-definition, formatting) and intercepts diagnostics
to replace them with output from the `djs` compiler.

## Architecture

```
VS Code
  │
  │  LSP (stdio / IPC)
  ▼
lsp-proxy  (src/server.ts)
  ├── textDocument/completion       ──► typescript-language-server
  ├── textDocument/hover            ──► typescript-language-server
  ├── textDocument/definition       ──► typescript-language-server
  ├── textDocument/formatting       ──► typescript-language-server  ← swap for djs fmt
  └── textDocument/publishDiagnostics ──► djs check (src/djs.ts)
```

`.djs` URIs are rewritten to `.js` before being sent to tsserver, and rewritten
back to `.djs` in every response. The editor never knows the difference.

## Project structure

```
lsp-proxy/
  src/
    server.ts       Main proxy. Start here to understand the flow.
    uri.ts          URI rewriting (.djs ↔ .js).
    documents.ts    In-memory document store (keeps editor buffer content).
    djs.ts          djs provider stub. Wire WASM here.
  vscode-extension/
    src/
      extension.ts  VS Code extension that starts the server.
    package.json    Extension manifest (registers .djs language).
```

## Surgical interception points

Every forwarded feature is a single `forward()` call. To route a feature
to `djs` instead of tsserver, replace that call.

### Diagnostics (already intercepted)

In `server.ts`, look for `── DIAGNOSTIC INTERCEPTION POINT ──`.
Currently calls `djsCheck()` from `src/djs.ts`, which is a stub.
Wire your WASM there:

```typescript
// src/djs.ts
export async function check(uri: string, source: string): Promise<Diagnostic[]> {
  const raw = (globalThis as any).djsCheck(source);
  const errors: DjsError[] = JSON.parse(raw);
  return errors.map(toDiagnostic);
}
```

### Formatting (still delegated to tsserver)

In `server.ts`, look for `── FORMATTING INTERCEPTION POINT ──`.
Replace the `forward()` with a call to `djs fmt`:

```typescript
editor.onDocumentFormatting(async (params) => {
  const source = docs.getText(params.textDocument.uri) ?? '';
  return djsFmt(params.textDocument.uri, source, params.options);
});
```

## Setup

```bash
# 1. Build the server
npm install
npm run build

# 2. Install typescript-language-server (the upstream tsserver wrapper)
npm install -g typescript-language-server typescript

# 3. Build and install the VS Code extension
cd vscode-extension
npm install
npm run build
# Then press F5 in VS Code to launch the Extension Development Host
```

## WASM integration

When `djs` is compiled to WASM, load it once at server startup:

```typescript
// In server.ts, before editor.listen()
import * as fs from 'fs';
const wasmBuffer = fs.readFileSync(path.join(__dirname, 'djs.wasm'));
const go = new (globalThis as any).Go();
const { instance } = await WebAssembly.instantiate(wasmBuffer, go.importObject);
go.run(instance);
// djsCheck() is now available as a global
```
