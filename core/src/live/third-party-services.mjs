const KNOWN_RUNTIME_SERVICES = [
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

function addPage(entry, pages, maximum = 20) {
  const page = String(pages ?? '').split('?')[0];
  if (page && !entry.pages.includes(page) && entry.pages.length < maximum) entry.pages.push(page);
}

/** Build a privacy-safe report of runtime services that cannot be made offline-equivalent by static capture. */
export function buildThirdPartyServicesReport({ externalRefs = [], unresolvedPaths = [] } = {}) {
  const services = new Map();
  const evidence = new Map();

  for (const ref of externalRefs) {
    let url;
    try { url = new URL(String(ref?.url ?? '')); } catch { continue; }
    const service = serviceForHostname(url.hostname);
    if (!service) continue;
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

  const list = [...services.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: list.length ? 'unsupported-runtime-detected' : 'none-detected',
    unsupportedRuntimeServices: list.length,
    services: list,
  };
}
