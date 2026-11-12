import jsonld from 'jsonld';
import { readFileSync } from 'node:fs';

// Schema.org official context, pinned locally; provenance is recorded in the audit.
const schemaContext = JSON.parse(readFileSync(new URL('./schemaorg-context.json', import.meta.url), 'utf8'));
export const JSONLD_LIMITS = Object.freeze({ scripts: 16, codeUnits: 1_048_576 });
const FIELDS = new Set(['name', 'headline', 'description', 'title', 'image', 'logo', 'url',
  'datePublished', 'dateModified', 'datePosted', 'uploadDate', 'startDate', 'endDate',
  'author', 'publisher', 'provider', 'offers', 'aggregateRating', 'review', 'reviewRating', 'itemReviewed',
  'itemListElement', 'mainEntity', 'acceptedAnswer', 'address', 'telephone', 'priceRange', 'location',
  'thumbnailUrl', 'contentUrl', 'price', 'priceCurrency', 'availability', 'brand', 'sku', 'position', 'item',
  'mainEntityOfPage', 'sameAs', 'hiringOrganization', 'ratingValue', 'ratingCount', 'reviewCount', 'step']);
const schemaName = iri => typeof iri === 'string' ? iri.replace(/^https?:\/\/schema\.org\//, '') : iri;

async function documentLoader(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== 'schema.org'
      || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
      || !['/', '/docs/jsonldcontext.jsonld', '/docs/jsonldcontext.json'].includes(parsed.pathname)) {
    throw new Error('Remote JSON-LD context is not available locally');
  }
  return { contextUrl: null, documentUrl: url, document: structuredClone(schemaContext) };
}

/** Expand context semantics before projecting bounded Schema.org fields; never fetch remote contexts. */
export async function parseJsonLdScripts(sources, base) {
  const results = [];
  for (const source of sources.slice(0, JSONLD_LIMITS.scripts)) {
    if (source.unavailable || typeof source.text !== 'string' || source.text.length > JSONLD_LIMITS.codeUnits) {
      results.push({ ok: null, types: [], items: [], semanticStatus: 'unknown', error: source.unavailable || 'JSON-LD 脚本超过采集大小限制' });
      continue;
    }
    let data;
    try { data = JSON.parse(source.text); }
    catch {
      results.push({ ok: false, types: [], items: [], semanticStatus: 'unknown', error: 'JSON 语法无法解析' });
      continue;
    }
    try {
      const expanded = await jsonld.expand(data, { base, documentLoader });
      const nodes = [...expanded];
      const types = new Set();
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        for (const type of node['@type'] ?? []) types.add(schemaName(type));
        for (const child of node['@graph'] ?? []) nodes.push(child);
      }
      let truncated = nodes.length > 12;
      const project = (value, depth = 0) => {
        if (depth > 3) { truncated = true; return undefined; }
        if (Array.isArray(value)) {
          if (value.length > 20) truncated = true;
          const values = value.slice(0, 20).map(v => project(v, depth)).filter(v => v !== undefined);
          return values.length === 1 ? values[0] : values;
        }
        if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 200) : value;
        if (Object.hasOwn(value, '@value')) return project(value['@value'], depth + 1);
        if (Object.hasOwn(value, '@list')) return project(value['@list'], depth + 1);
        const out = {};
        for (const [iri, field] of Object.entries(value)) {
          const key = schemaName(iri);
          if (key === '@type') out[key] = field.slice(0, 200).map(schemaName);
          else if (key === '@id' || FIELDS.has(key)) {
            const projected = project(field, depth + 1);
            if (projected !== undefined) out[key] = projected;
          }
        }
        return out;
      };
      const items = nodes.slice(0, 12).map(node => project(node));
      results.push({ ok: true, types: [...types].slice(0, 200), items, semanticStatus: 'complete',
        truncated, typesTruncated: types.size > 200 });
    } catch (error) {
      const invalid = error.name === 'jsonld.SyntaxError';
      results.push({ ok: !invalid, types: [], items: [], semanticStatus: 'unknown',
        error: invalid ? `JSON-LD 语义格式错误：${String(error.details?.code ?? 'invalid input').slice(0, 80)}`
          : 'JSON-LD 语义未核实；无法使用本地上下文展开，未访问其他远程上下文' });
    }
  }
  if (sources.length > JSONLD_LIMITS.scripts) results.push({ ok: null, types: [], items: [], semanticStatus: 'unknown', error: 'JSON-LD 脚本超过采集数量限制' });
  return results;
}
