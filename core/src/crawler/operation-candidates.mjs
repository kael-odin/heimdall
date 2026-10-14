import { sanitizeObservedUrl } from './state-graph.mjs';

function boundedInteger(value, fallback, max, min = 0) {
  return Number.isInteger(value) && value >= min ? Math.min(value, max) : fallback;
}

/**
 * Read the current page's visible light DOM and propose operations for review.
 * This never clicks or navigates. Even a GET link can change source state, so a
 * caller must explicitly authorize and guard any later execution.
 *
 * Selectors are structural only. Labels, attributes, input values, hrefs and
 * query strings never leave the browser evaluation. The result is still best
 * kept in the private workspace because the source origin is observable.
 */
export async function discoverOperationCandidates(page, options = {}) {
  if (!page?.evaluate || !page?.url) throw new TypeError('a Playwright page is required');
  const maxCandidates = boundedInteger(options.maxCandidates, 32, 200);
  const maxInspected = boundedInteger(options.maxInspected, 5_000, 20_000, 1);
  const observed = await page.evaluate(({ maxCandidates, maxInspected }) => {
    const candidates = [];
    let inspected = 0;
    let recognized = 0;
    let omittedUnaddressable = 0;
    let framesObserved = 0;
    let openShadowRootsObserved = 0;

    function visible(element) {
      if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.pointerEvents === 'none') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    }

    function paginationContext(element) {
      const nav = element.closest('nav, [role="navigation"]');
      if (!nav) return false;
      return /pagination|pages?|分页|页码/i.test(nav.getAttribute('aria-label') ?? '');
    }

    function sameOriginLink(element) {
      if (!element.hasAttribute('href') || element.hasAttribute('download')
        || (element.getAttribute('target') ?? '').toLowerCase() === '_blank') return false;
      try {
        const url = new URL(element.getAttribute('href'), location.href);
        return ['http:', 'https:'].includes(url.protocol) && url.origin === location.origin;
      } catch { return false; }
    }

    function kindOf(element) {
      if (!visible(element) || element.matches(':disabled, [aria-disabled="true"]')
        || element.closest('form')) return null;
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role');
      if (tag === 'a') {
        const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        return sameOriginLink(element) && (rel.includes('next') || rel.includes('prev') || paginationContext(element))
          ? 'pagination' : null;
      }
      if (element.closest('a[href]')) return null;
      if (tag !== 'button' && role !== 'tab' && role !== 'button') return null;
      if (tag === 'button' && !['button', ''].includes((element.getAttribute('type') ?? '').toLowerCase())) return null;
      if (tag === 'button' && !(element.getAttribute('type') ?? '') && element.form) return null;
      if (paginationContext(element)) return 'pagination';
      if (role === 'tab') return 'tab';
      const popup = (element.getAttribute('aria-haspopup') ?? '').toLowerCase();
      if (popup === 'menu' || popup === 'true' || popup === 'listbox') return 'menu';
      if (element.hasAttribute('aria-expanded')) return 'disclosure';
      return null;
    }

    function structuralSelector(element) {
      const parts = [];
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (!node.parentElement) return null;
        const index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
        parts.unshift(`:nth-child(${index})`);
        if (parts.length > 60) return null;
      }
      if (!document.body?.contains(element)) return null;
      const selector = `body > ${parts.join(' > ')}`;
      return selector.length <= 512 ? selector : null;
    }

    const root = document.body ?? document.documentElement;
    if (!root) return { candidates, inspected, recognized, omittedUnaddressable,
      framesObserved, openShadowRootsObserved, scanTruncated: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root;
    while (node && inspected < maxInspected) {
      inspected++;
      if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') framesObserved++;
      if (node.shadowRoot) openShadowRootsObserved++;
      const kind = kindOf(node);
      if (kind) {
        recognized++;
        const selector = structuralSelector(node);
        if (!selector) omittedUnaddressable++;
        else if (candidates.length < maxCandidates) {
          candidates.push({ kind, action: { type: 'click', selector }, status: 'untested' });
        }
      }
      node = walker.nextNode();
    }
    return {
      candidates, inspected, recognized, omittedUnaddressable,
      framesObserved, openShadowRootsObserved,
      scanTruncated: node !== null,
    };
  }, { maxCandidates, maxInspected });

  const proposed = observed.candidates.length;
  const omittedByBudget = observed.recognized - observed.omittedUnaddressable - proposed;
  return {
    version: 1,
    source: sanitizeObservedUrl(page.url()),
    policy: { execution: 'none', reviewRequired: true, scope: 'visible-light-dom' },
    limits: { maxCandidates, maxInspected },
    candidates: observed.candidates.map((candidate, index) => ({ index, ...candidate })),
    summary: {
      inspected: observed.inspected,
      recognized: observed.recognized,
      proposed,
      omittedByBudget,
      omittedUnaddressable: observed.omittedUnaddressable,
      untestedBranchesLowerBound: observed.recognized,
      scanTruncated: observed.scanTruncated,
      framesObserved: observed.framesObserved,
      openShadowRootsObserved: observed.openShadowRootsObserved,
      unknownBranchesBeyondScope: observed.scanTruncated || observed.framesObserved > 0
        || observed.openShadowRootsObserved > 0,
    },
  };
}
