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
];

function hostMatches(hostname, hosts) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return hosts.some(service => host === service || host.endsWith('.' + service));
}

function serviceForHostname(hostname) {
  return KNOWN_RUNTIME_SERVICES.find(service => hostMatches(hostname, service.hosts)) ?? null;
}

function serviceEntry(service) {
  return {
    id: service.id,
    kind: service.kind,
    disposition: service.disposition,
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

function addBrowserEvidence(services, service, page, references = 1) {
  const entry = services.get(service.id) ?? serviceEntry(service);
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
export function buildThirdPartyServicesReport({ externalRefs = [], unresolvedPaths = [], browserProbe = null } = {}) {
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
      const entry = services.get(service.id) ?? serviceEntry(service);
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
    const entry = services.get(service.id) ?? serviceEntry(service);
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
          addBrowserEvidence(services, service, page, index === 0 ? item.references : 0);
        });
      } else {
        addBrowserEvidence(services, service, item.page, item.references);
      }
    }
  }

  const list = [...services.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: list.length ? 'unsupported-runtime-detected' : 'none-detected',
    unsupportedRuntimeServices: list.length,
    services: list,
    ...(browserProbe ? { browserEvidenceTruncated: browserProbe.truncated === true } : {}),
  };
}
