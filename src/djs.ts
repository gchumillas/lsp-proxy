import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { spawn } from 'child_process';

// Shape emitted by `djs -check`
interface DjsPosition { line: number; column: number; }
interface DjsError {
  range: { start: DjsPosition; end: DjsPosition };
  message: string;
  code: string;
}

function toDiagnostic(e: DjsError): Diagnostic {
  const range: Range = {
    start: { line: e.range.start.line, character: e.range.start.column },
    end:   { line: e.range.end.line,   character: e.range.end.column   },
  };
  return { range, severity: DiagnosticSeverity.Error, source: 'djs', message: e.message, code: e.code };
}

/**
 * Format source text with djs.
 * Returns the formatted string, or null if djs reports a syntax error.
 */
export async function format(_uri: string, source: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('djs', ['-format', '-stdin']);
    let stdout = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 ? stdout : null));

    proc.stdin.write(source);
    proc.stdin.end();
  });
}

/**
 * Run djs diagnostics on the given source text.
 * Returns LSP Diagnostics ready to publish.
 */
export async function check(_uri: string, source: string): Promise<Diagnostic[]> {
  return new Promise((resolve) => {
    const proc = spawn('djs', ['-check', '-stdin']);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', () => resolve([]));

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve([{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          severity: DiagnosticSeverity.Error,
          source: 'djs',
          message: `djs: ${stderr.trim()}`,
        }]);
        return;
      }
      try {
        const result = JSON.parse(stdout) as { errors: DjsError[] };
        resolve(result.errors.map(toDiagnostic));
      } catch {
        resolve([]);
      }
    });

    proc.stdin.write(source);
    proc.stdin.end();
  });
}
