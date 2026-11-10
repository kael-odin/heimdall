import { parse, serialize } from 'parse5';

const ACTIVE_ELEMENTS = new Set(['script', 'object', 'embed', 'applet', 'frame', 'frameset']);
const URL_ATTRIBUTES = new Set([
  'href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'data', 'poster', 'background',
]);
const FORM_OVERRIDE_ATTRIBUTES = new Set(['formaction', 'formmethod', 'formtarget']);

function activeUrl(value, tag, attribute) {
  const compact = String(value).replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (/^(?:javascript|vbscript):/.test(compact)) return true;
  if (/^data:(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)(?:[;,]|$)/.test(compact)) {
    return !['src', 'srcset'].includes(attribute) || !['img', 'source'].includes(tag);
  }
  return false;
}

function cleanChildren(parent) {
  if (!parent?.childNodes) return;
  parent.childNodes = parent.childNodes.filter((node) => {
    const tag = node.tagName?.toLowerCase();
    if (ACTIVE_ELEMENTS.has(tag)) return false;
    if (tag === 'meta' && node.attrs?.some(a => a.name === 'http-equiv' && a.value.trim().toLowerCase() === 'refresh')) {
      return false;
    }
    return true;
  });
  for (const node of parent.childNodes) {
    if (node.attrs) {
      const tag = node.tagName?.toLowerCase() ?? '';
      const hasFormOwner = node.attrs.some(attr => !attr.prefix && attr.name.toLowerCase() === 'form');
      node.attrs = node.attrs.filter((attr) => {
        const name = (attr.prefix ? attr.prefix + ':' : '') + attr.name.toLowerCase();
        if (/^on[a-z]/i.test(name) || name === 'srcdoc' || (tag === 'iframe' && name === 'sandbox')) return false;
        if (FORM_OVERRIDE_ATTRIBUTES.has(name)
          || (tag === 'form' && ['action', 'method', 'target'].includes(name))) return false;
        return !URL_ATTRIBUTES.has(name) || !activeUrl(attr.value, tag, name);
      });
      if (tag === 'iframe') node.attrs.push({ name: 'sandbox', value: '' });
      if ((tag === 'form' || hasFormOwner)
        && !node.attrs.some(attr => !attr.prefix && attr.name.toLowerCase() === 'inert')) {
        node.attrs.push({ name: 'inert', value: '' });
      }
      if (tag === 'form') {
        node.attrs.push({ name: 'action', value: 'about:blank' }, { name: 'method', value: 'dialog' });
      }
    }
    cleanChildren(node);
    cleanChildren(node.content);
  }
}

/** Remove source-site script and native form entry points while retaining static layout. */
export function sanitizeStaticHtml(html) {
  const document = parse(String(html));
  cleanChildren(document);
  return serialize(document);
}

/** Recognize chooser files created by Heimdall, including older three-width entries. */
export function isStaticCloneChooserHtml(html) {
  return /<script\b[^>]*>\s*location\.replace\s*\(\s*innerWidth\s*<=\s*600\s*\?/i.test(html)
    && /index-(?:375|768|1440)\.html/i.test(html);
}

/** The only script permitted in a multi-viewport static clone. */
export function staticCloneChooserHtml(availableWidths) {
  if (!Array.isArray(availableWidths)) throw new Error('clone chooser requires available viewport widths');
  const widths = [...new Set(availableWidths)];
  if (!widths.length || widths.some(width => ![375, 768, 1440].includes(width))) {
    throw new Error('clone chooser requires known, available viewport widths');
  }
  const pick = (...preference) => preference.find(width => widths.includes(width));
  const mobile = `"index-${pick(375, 768, 1440)}.html"`;
  const tablet = `"index-${pick(768, 1440, 375)}.html"`;
  const desktop = `"index-${pick(1440, 768, 375)}.html"`;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Heimdall clone</title><script>location.replace(innerWidth<=600?' + mobile + ':innerWidth<=1100?' + tablet + ':' + desktop + ');</script>'
    + '<noscript><meta http-equiv="refresh" content="0;url=index-' + pick(1440, 768, 375) + '.html"></noscript></head><body></body></html>';
}
