/**
 * URI rewriting utilities.
 *
 * The proxy presents .djs files to tsserver as .js files.
 * These helpers translate in both directions so no URI leaks through.
 */

export const DJS = '.djs';
export const JS  = '.js';

/** foo.djs → foo.js */
export function djsToJs(uri: string): string {
  return uri.endsWith(DJS) ? uri.slice(0, -DJS.length) + JS : uri;
}

/** foo.js → foo.djs (only when the .js came from a .djs rewrite) */
export function jsToDjs(uri: string): string {
  return uri.endsWith(JS) ? uri.slice(0, -JS.length) + DJS : uri;
}

/**
 * Deep-rewrite every string value that ends with `from` into `to`.
 * Works generically over any LSP params object so we don't have to
 * enumerate every method's shape.
 */
export function rewriteUris(obj: unknown, from: string, to: string): unknown {
  if (typeof obj === 'string') {
    return obj.endsWith(from) ? obj.slice(0, -from.length) + to : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((x) => rewriteUris(x, from, to));
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, rewriteUris(v, from, to)])
    );
  }
  return obj;
}

/** Convenience: rewrite outgoing params (.djs → .js) */
export function toJs<T>(params: T): T {
  return rewriteUris(params, DJS, JS) as T;
}

/** Convenience: rewrite incoming responses (.js → .djs) */
export function toDjs<T>(params: T): T {
  return rewriteUris(params, JS, DJS) as T;
}
