/**
 * Minimal in-memory store for open .djs documents.
 *
 * tsserver needs to receive didOpen / didChange events with .js URIs
 * and the current buffer content. We keep a copy here so we can
 * re-emit those events whenever needed.
 */

import { TextDocumentContentChangeEvent } from 'vscode-languageserver';

interface Doc {
  uri: string;       // original .djs URI
  languageId: string;
  version: number;
  text: string;
}

export class DocumentStore {
  private docs = new Map<string, Doc>();

  open(uri: string, languageId: string, version: number, text: string): void {
    this.docs.set(uri, { uri, languageId, version, text });
  }

  change(
    uri: string,
    version: number,
    changes: TextDocumentContentChangeEvent[]
  ): void {
    const doc = this.docs.get(uri);
    if (!doc) return;

    // LSP can send incremental or full-content changes.
    // We only handle full-content for now (simplest, always correct).
    for (const change of changes) {
      if (!('range' in change)) {
        doc.text = change.text;
      }
      // TODO: apply incremental changes if needed
    }
    doc.version = version;
  }

  close(uri: string): void {
    this.docs.delete(uri);
  }

  get(uri: string): Doc | undefined {
    return this.docs.get(uri);
  }

  getText(uri: string): string | undefined {
    return this.docs.get(uri)?.text;
  }
}
