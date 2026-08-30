import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidOpenTextDocumentParams,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  CompletionParams,
  CompletionItem,
  HoverParams,
  DefinitionParams,
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
  SignatureHelpParams,
  ReferenceParams,
  DocumentHighlightParams,
  SemanticTokensParams,
  SemanticTokensRangeParams,
  InlayHintParams,
  FoldingRangeParams,
  CodeLensParams,
  PublishDiagnosticsParams,
  TextEdit,
  MessageType,
  CancellationToken,
  ResponseError,
  LSPErrorCodes,
} from 'vscode-languageserver/node';

import * as path from 'path';
import * as net from 'net';
import * as child_process from 'child_process';
import { toJs, toDjs } from './uri';
import { DocumentStore } from './documents';
import { check as djsCheck, format as djsFormat } from './djs';

// ─── Connection to the editor ────────────────────────────────────────────────

const editor = createConnection(ProposedFeatures.all);
const docs   = new DocumentStore();

// ─── Connection to typescript-language-server ────────────────────────────────

/**
 * Spawns typescript-language-server and returns a thin async RPC wrapper.
 *
 * We communicate over stdio using the same LSP wire format, so we can
 * reuse the same message framing as the editor connection.
 */
function spawnTsServer() {
  // Resolve the binary from our own node_modules instead of the caller's
  // PATH — the extension host process may not inherit the user's shell PATH.
  const bin = require.resolve('typescript-language-server/lib/cli.mjs');
  const proc = child_process.spawn(
    process.execPath,
    [bin, '--stdio'],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );

  let buffer = '';
  const pending = new Map<
    number | string,
    {
      resolve: (result: unknown) => void;
      reject: (reason: Error) => void;
      cancelSub?: { dispose(): void };
    }
  >();
  let nextId = 1;

  proc.on('error', (err) => {
    editor.console.error(`Failed to spawn typescript-language-server: ${err.message}`);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  });

  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      editor.console.error(`typescript-language-server exited with code ${code} (signal ${signal})`);
    }
  });

  // Parse LSP messages from tsserver stdout
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match  = header.match(/Content-Length: (\d+)/i);
      if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

      const length  = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;

      const body = buffer.slice(bodyStart, bodyStart + length);
      buffer = buffer.slice(bodyStart + length);

      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }

      // A message with `method` is a request/notification FROM tsserver, even
      // if its id happens to collide with one of our own pending request ids
      // (both sides run independent id counters). Only treat as a response
      // when there is no method.
      if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
        // Response to one of our requests
        const { resolve, reject, cancelSub } = pending.get(msg.id)!;
        pending.delete(msg.id);
        cancelSub?.dispose();
        if (msg.error) {
          reject(new Error(msg.error.message ?? 'tsserver request failed'));
        } else {
          resolve(msg.result);
        }
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        // Discard tsserver's JS diagnostics — djs diagnostics are published
        // directly from the didOpen / didChange handlers below.
      } else if (msg.method) {
        // Other server→client notifications/requests: forward as-is
        // (rewriting any .js URIs back to .djs)
        const rewritten = toDjs(msg);
        if (msg.id !== undefined) {
          // tsserver is making a request to the client (e.g. workspace/configuration,
          // client/registerCapability) and is blocked waiting for our reply — the
          // response MUST be relayed back to tsserver, not just forwarded to the editor.
          editor.sendRequest(msg.method, rewritten.params).then(
            (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
            (error) => send({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: error?.message ?? String(error) },
            })
          );
        } else {
          editor.sendNotification(msg.method, rewritten.params);
        }
      }
    }
  });

  /** Send a request to tsserver and await its response */
  function request<T = unknown>(
    method: string,
    params: unknown,
    token?: CancellationToken
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const entry: {
        resolve: (r: unknown) => void;
        reject: (e: Error) => void;
        cancelSub?: { dispose(): void };
      } = { resolve: resolve as (r: unknown) => void, reject };

      if (token) {
        // Relay editor cancellations to tsserver so it stops working on
        // stale requests (e.g. superseded completions while typing fast).
        entry.cancelSub = token.onCancellationRequested(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          notify('$/cancelRequest', { id });
          reject(new ResponseError(LSPErrorCodes.RequestCancelled, `${method} cancelled`));
        });
      }

      pending.set(id, entry);
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification to tsserver (no response expected) */
  function notify(method: string, params: unknown): void {
    send({ jsonrpc: '2.0', method, params });
  }

  function send(msg: unknown): void {
    const body = JSON.stringify(msg);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  return { request, notify, proc };
}

const ts = spawnTsServer();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Forward a request to tsserver, rewrite params .djs→.js, rewrite response .js→.djs */
async function forward<T = unknown>(
  method: string,
  params: unknown,
  token?: CancellationToken
): Promise<T> {
  const result = await ts.request<T>(method, toJs(params), token);
  return toDjs(result) as T;
}

/** Try to forward a request; if tsserver says the method is unhandled, return a fallback value. */
async function forwardOr<T = unknown>(
  method: string,
  params: unknown,
  fallback: T,
  token?: CancellationToken
): Promise<T> {
  try {
    return await forward<T>(method, params, token);
  } catch (err: any) {
    // Propagate cancellations so the editor knows the result is void.
    if (err instanceof ResponseError && err.code === LSPErrorCodes.RequestCancelled) {
      throw err;
    }
    // Best-effort feature: swallow both "unhandled method" and internal
    // tsserver crashes (e.g. refactor analysis bugs) rather than surfacing them.
    editor.console.warn(`${method} failed, using fallback: ${err?.message ?? err}`);
    return fallback;
  }
}

/** Forward a notification to tsserver (no response) */
function forwardNotify(method: string, params: unknown): void {
  ts.notify(method, toJs(params));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

editor.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  // tsserver expects processId to be a number or null, not undefined
  const initParams: InitializeParams = {
    ...params,
    processId: params.processId ?? null,
    initializationOptions: {
      ...(params.initializationOptions ?? {}),
      // Auto-import suggestions scan every export in node_modules on the
      // first global completion (~5s, uncancellable, single-threaded), which
      // starves any completion typed right behind it. Not useful for .djs.
      preferences: {
        ...(params.initializationOptions?.preferences ?? {}),
        includeCompletionsForModuleExports: false,
        includeCompletionsForImportStatements: false,
        includePackageJsonAutoImports: 'off',
      },
      tsserver: {
        ...(params.initializationOptions?.tsserver ?? {}),
        // Point typescript-language-server at the TypeScript bundled with
        // lsp-proxy, regardless of the user's workspace root.
        path: path.join(__dirname, '..', 'node_modules', 'typescript', 'lib', 'tsserver.js'),
      },
    },
  };

  let result: InitializeResult | undefined;
  try {
    result = await forward<InitializeResult>('initialize', initParams);
  } catch (err) {
    editor.console.error(`tsserver initialize failed: ${err}`);
  }

  // Fallback: if tsserver failed or returned nothing, declare minimal capabilities
  // so the editor doesn't crash and diagnostics still work.
  if (!result) {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
      },
      serverInfo: {
        name: 'lsp-proxy',
      },
    };
  }

  // Ensure the editor knows we handle document sync
  result.capabilities.textDocumentSync = TextDocumentSyncKind.Full;

  return result;
});

editor.onInitialized(() => {
  forwardNotify('initialized', {});
});

editor.onShutdown(() => forward('shutdown', null));
editor.onExit(() => ts.notify('exit', null));

// ─── Document synchronization ────────────────────────────────────────────────
// These are the events tsserver needs to stay in sync with the editor buffer.
// We store the content locally (for djs) and forward to tsserver with .js URIs.

editor.onDidOpenTextDocument((params: DidOpenTextDocumentParams) => {
  docs.open(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    params.textDocument.text
  );

  // Tell tsserver this is a .js file
  forwardNotify('textDocument/didOpen', {
    textDocument: {
      ...params.textDocument,
      uri: toJs(params.textDocument.uri),
      languageId: 'javascript',  // treat as JS
    },
  });

  djsCheck(params.textDocument.uri, params.textDocument.text).then((diagnostics) => {
    editor.sendNotification('textDocument/publishDiagnostics', {
      uri: params.textDocument.uri,
      diagnostics,
    });
  });
});

editor.onDidChangeTextDocument((params: DidChangeTextDocumentParams) => {
  docs.change(
    params.textDocument.uri,
    params.textDocument.version,
    params.contentChanges
  );
  forwardNotify('textDocument/didChange', toJs(params));  // rewrite .djs → .js

  const source = docs.getText(params.textDocument.uri);
  if (source !== undefined) {
    djsCheck(params.textDocument.uri, source).then((diagnostics) => {
      editor.sendNotification('textDocument/publishDiagnostics', {
        uri: params.textDocument.uri,
        diagnostics,
      });
    });
  }
});

editor.onDidCloseTextDocument((params: DidCloseTextDocumentParams) => {
  docs.close(params.textDocument.uri);
  forwardNotify('textDocument/didClose', params);
});

// ─── Language features ───────────────────────────────────────────────────────
// Each handler below is a forward() call. To intercept one and route it
// to djs, replace the forward() with your own implementation.

editor.onCompletion((params: CompletionParams, token) =>
  forward('textDocument/completion', params, token)
);

editor.onCompletionResolve((item: CompletionItem, token) =>
  forwardOr('completionItem/resolve', item, item, token)
);

editor.onHover((params: HoverParams, token) =>
  forward('textDocument/hover', params, token)
);

editor.onDefinition((params: DefinitionParams, token) =>
  forward('textDocument/definition', params, token)
);

editor.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[] | null> => {
  const uri = params.textDocument.uri;
  const source = docs.getText(uri) ?? '';
  const formatted = await djsFormat(uri, source);
  if (formatted === null) return null;

  const lines = source.split('\n');
  return [{
    range: {
      start: { line: 0, character: 0 },
      end:   { line: lines.length - 1, character: lines[lines.length - 1].length },
    },
    newText: formatted,
  }];
});

editor.onDocumentRangeFormatting((params: DocumentRangeFormattingParams, token) =>
  forward('textDocument/rangeFormatting', params, token)
);

editor.onSignatureHelp((params: SignatureHelpParams, token) =>
  forwardOr('textDocument/signatureHelp', params, null, token)
);

editor.onReferences((params: ReferenceParams, token) =>
  forwardOr('textDocument/references', params, [], token)
);

editor.onDocumentHighlight((params: DocumentHighlightParams, token) =>
  forwardOr('textDocument/documentHighlight', params, [], token)
);

editor.languages.semanticTokens.on((params: SemanticTokensParams, token) =>
  forwardOr('textDocument/semanticTokens/full', params, { data: [] }, token)
);

editor.languages.semanticTokens.onRange((params: SemanticTokensRangeParams, token) =>
  forwardOr('textDocument/semanticTokens/range', params, { data: [] }, token)
);

editor.languages.inlayHint.on((params: InlayHintParams, token) =>
  forwardOr('textDocument/inlayHint', params, [], token)
);

// ─── Optional features that tsserver may reject for non-TS files ─────────────
// Return empty results so the editor doesn't spam the output with -32601 errors.

editor.onDocumentSymbol((params, token) =>
  forwardOr('textDocument/documentSymbol', params, [], token)
);

// codeAction forwarding disabled: TS 5.9.3 crashes tsserver on incomplete code
editor.onCodeAction((_params) => []);

editor.onFoldingRanges((params: FoldingRangeParams, token) =>
  forwardOr('textDocument/foldingRange', params, [], token)
);

editor.onCodeLens((params: CodeLensParams, token) =>
  forwardOr('textDocument/codeLens', params, [], token)
);

// ─── Start ───────────────────────────────────────────────────────────────────

editor.listen();
