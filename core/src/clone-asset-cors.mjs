const CORS_RENDERING_MIME = /^(?:font\/|image\/|text\/css;)|^application\/vnd\.ms-fontobject$/;

/**
 * A sandboxed clone has an opaque origin, so its fonts, CSS masks and images
 * are CORS requests. Only rendering assets inside a clone directory are
 * cross-origin readable; HTML, scripts and JSON remain unreadable.
 */
export function isCloneRenderingAsset(workspaceRelativePath, mime) {
  const path = String(workspaceRelativePath ?? '').replaceAll('\\', '/');
  return /^[^/]+\/pages\/[^/]+\/clone\/.+/i.test(path) && CORS_RENDERING_MIME.test(String(mime ?? ''));
}
