const KNOWN_RUNTIME_SERVICES = [
  {
    id: 'iconify',
    hosts: ['api.iconify.design', 'api.simplesvg.com', 'api.unisvg.com'],
    kind: 'icon-api',
    disposition: 'unsupported-runtime',
  },
  {
    id: 'carbonads',
    hosts: ['carbonads.com', 'carbonads.net'],
    kind: 'advertising',
    disposition: 'unsupported-runtime',
  },
  {
    id: 'youtube',
    hosts: ['youtube.com', 'youtube-nocookie.com'],
    kind: 'video-embed',
    disposition: 'unsupported-runtime',
  },
  {
    id: 'vite-sponsors',
    hosts: ['sponsors.vite.dev'],
    kind: 'sponsorship-widget',
    disposition: 'unsupported-runtime',
  },
  {
    id: 'github-avatars',
    hosts: ['github.com', 'www.github.com', 'avatars.githubusercontent.com'],
    kind: 'avatar-image',
    disposition: 'unsupported-runtime',
  },
];

function hostMatches(hostname, hosts) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return hosts.some(service => host === service || host.endsWith('.' + service));
}

export function runtimeServiceForHostname(hostname) {
  return KNOWN_RUNTIME_SERVICES.find(service => hostMatches(hostname, service.hosts)) ?? null;
}

export function runtimeServiceForUrl(value) {
  try {
    const { hostname } = new URL(String(value));
    return runtimeServiceForHostname(hostname) ?? dynamicServiceForHostname(hostname);
  } catch {
    return null;
  }
}

function serviceForHostname(hostname) {
  return runtimeServiceForHostname(hostname);
}

function serviceEntry(service, policy = null) {
  return {
    id: service.id,
    kind: service.kind,
    disposition: policy === 'cache' ? 'cached-runtime'
      : policy === 'remove' ? 'removed-runtime'
        : policy === 'placeholder' ? 'placeholder-runtime'
          : service.disposition,
    ...(policy ? { policy } : {}),
    hosts: [...service.hosts],
    references: 0,
    urls: 0,
    pages: [],
  };
}

function isRuntimeReference(ref) {
  if (ref?.required === true) return true;
  const tags = Array.isArray(ref?.tags) ? ref.tags.map(tag => String(tag).toLowerCase()) : [];
  return tags.some(tag => ['script', 'iframe', 'img', 'link'].includes(tag));
}

function addPage(entry, pages, maximum = 20) {
  const page = String(pages ?? '').split('?')[0];
  if (page && !entry.pages.includes(page) && entry.pages.length < maximum) entry.pages.push(page);
}

function dynamicServiceForHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  const canonicalHost = host.replace(/^www\./, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  return {
    id: 'external-' + canonicalHost.replaceAll('.', '-'),
    hosts: [canonicalHost],
    kind: 'external-runtime',
    disposition: 'unsupported-runtime',
  };
}

function addBrowserEvidence(services, service, page, references = 1, policy = null) {
  const entry = services.get(service.id) ?? serviceEntry(service, policy);
  if (!('browserReferences' in entry)) {
    entry.browserReferences = 0;
    entry.browserPages = [];
  }
  if (references > 0) entry.browserReferences += references;
  addPage(entry, page, 20);
  entry.browserPages = [...entry.pages];
  services.set(service.id, entry);
}

/** Build a privacy-safe report of runtime services that cannot be made offline-equivalent by static capture. */
export function buildThirdPartyServicesReport({
  externalRefs = [], unresolvedPaths = [], browserProbe = null, policies = null,
} = {}) {
  const services = new Map();
  const evidence = new Map();

  for (const ref of externalRefs) {
    let url;
    try { url = new URL(String(ref?.url ?? '')); } catch { continue; }
    const service = serviceForHostname(url.hostname);
    if (!service) continue;
    if (!isRuntimeReference(ref)) continue;
    const key = service.id + '\0external\0' + url.origin + url.pathname;
    if (!evidence.has(key)) {
      evidence.set(key, true);
      const policy = policies?.get(service.id) ?? null;
      const entry = services.get(service.id) ?? serviceEntry(service, policy);
      entry.urls++;
      services.set(service.id, entry);
    }
    const entry = services.get(service.id);
    const references = Number(ref?.references);
    entry.references += Number.isSafeInteger(references) && references > 0 ? references : 1;
    if (Array.isArray(ref?.pages)) for (const page of ref.pages) addPage(entry, page);
    else addPage(entry, ref?.page);
  }

  for (const target of unresolvedPaths) {
    const match = /^\/_ext\/([^/]+)(?:\/|$)/.exec(String(target ?? ''));
    if (!match) continue;
    const service = serviceForHostname(match[1]);
    if (!service) continue;
    const policy = policies?.get(service.id) ?? null;
    const entry = services.get(service.id) ?? serviceEntry(service, policy);
    entry.references++;
    entry.urls++;
    services.set(service.id, entry);
  }

  if (browserProbe) {
    const evidence = Array.isArray(browserProbe.runtimeOrigins) && browserProbe.runtimeOrigins.length
      ? browserProbe.runtimeOrigins.map(origin => ({
        target: origin.origin,
        pages: origin.pages,
        references: origin.requests,
      }))
      : Array.isArray(browserProbe.failures)
        ? browserProbe.failures.filter(failure => failure?.kind === 'externalRequest')
        : [];
    for (const item of evidence) {
      let url;
      try { url = new URL(String(item.target)); } catch { continue; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const service = serviceForHostname(url.hostname) ?? dynamicServiceForHostname(url.hostname);
      if (!service) continue;
      if (Array.isArray(item.pages)) {
        item.pages.forEach((page, index) => {
          addBrowserEvidence(services, service, page, index === 0 ? item.references : 0, policies?.get(service.id) ?? null);
        });
      } else {
        addBrowserEvidence(services, service, item.page, item.references, policies?.get(service.id) ?? null);
      }
    }
  }

  const list = [...services.values()].sort((a, b) => a.id.localeCompare(b.id));
  const unsupported = list.filter(service => service.disposition === 'unsupported-runtime').length;
  return {
    status: list.length ? (unsupported ? 'unsupported-runtime-detected' : 'runtime-policy-applied') : 'none-detected',
    unsupportedRuntimeServices: unsupported,
    services: list,
    ...(browserProbe ? { browserEvidenceTruncated: browserProbe.truncated === true } : {}),
  };
}
