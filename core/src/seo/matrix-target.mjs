import { WORKSPACE } from '../paths.mjs';
import { readSiteIdentity, siteIdForOrigin } from '../site-origin.mjs';
import { asUrl } from '../url-canon.mjs';

/** Resolve a workspace site ID or URL to the exact origin used by SEO audit. */
export function resolveMatrixTarget(input, { workspace = WORKSPACE } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('matrix target is empty');

  const identity = readSiteIdentity(workspace, raw);
  if (identity) return { origin: identity.origin, siteId: identity.siteId };
  if (/--origin-[0-9a-f]{16}$/i.test(raw)) throw new Error(`unknown site ID: ${raw}`);

  const url = asUrl(raw);
  if (!url) throw new Error(`invalid matrix target: ${raw}`);
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`invalid HTTP(S) matrix target: ${raw}`);
  }
  return { origin: parsed.origin, siteId: siteIdForOrigin(workspace, parsed.origin) };
}
