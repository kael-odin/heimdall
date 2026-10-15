import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThirdPartyServicesReport } from '../src/live/third-party-services.mjs';

test('known runtime services are reported without full URLs or query values', () => {
  const report = buildThirdPartyServicesReport({
    externalRefs: [
      {
        url: 'https://cdn.carbonads.com/carbon.js?serve=private-placement',
        references: 54,
        required: true,
        tags: ['script'],
        pages: ['/guide/', '/blog/'],
      },
      {
        url: 'https://www.youtube-nocookie.com/embed/demo?token=private',
        references: 1,
        required: false,
        tags: ['iframe'],
        pages: ['/live/'],
      },
    ],
    unresolvedPaths: ['/_ext/www.youtube-nocookie.com/embed/demo'],
  });

  assert.equal(report.status, 'unsupported-runtime-detected');
  assert.equal(report.unsupportedRuntimeServices, 2);
  assert.deepEqual(report.services, [
    {
      id: 'carbonads',
      kind: 'advertising',
      disposition: 'unsupported-runtime',
      hosts: ['carbonads.com', 'carbonads.net'],
      references: 54,
      urls: 1,
      pages: ['/guide/', '/blog/'],
    },
    {
      id: 'youtube',
      kind: 'video-embed',
      disposition: 'unsupported-runtime',
      hosts: ['youtube.com', 'youtube-nocookie.com'],
      references: 2,
      urls: 2,
      pages: ['/live/'],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private-placement|demo|token=private/);
});

test('ordinary CDN assets do not create a runtime-service blocker', () => {
  const report = buildThirdPartyServicesReport({
    externalRefs: [{ url: 'https://cdn.example.org/app.js', references: 3, pages: ['/'] }],
    unresolvedPaths: ['/_ext/cdn.example.org/app.js'],
  });
  assert.equal(report.status, 'none-detected');
  assert.equal(report.unsupportedRuntimeServices, 0);
  assert.deepEqual(report.services, []);
});

test('ordinary outbound service links are not runtime blockers', () => {
  const report = buildThirdPartyServicesReport({
    externalRefs: [{ url: 'https://www.youtube.com/watch?v=demo', references: 1, required: false, tags: ['a'] }],
  });
  assert.equal(report.status, 'none-detected');
  assert.equal(report.unsupportedRuntimeServices, 0);
  assert.deepEqual(report.services, []);
});

test('browser-probe failures expose runtime-only services', () => {
  const report = buildThirdPartyServicesReport({
    browserProbe: {
      failures: [
        { kind: 'externalRequest', target: 'https://api.iconify.design', page: '/' },
        { kind: 'externalRequest', target: 'https://api.simplesvg.com', page: '/' },
        { kind: 'externalRequest', target: 'https://sponsors.vite.dev', page: '/guide/' },
        { kind: 'externalRequest', target: 'http://cdn.carbonads.com', page: '/blog/' },
        { kind: 'externalRequest', target: 'https://www.youtube.com', page: '/blog/announcing-vite6/' },
        { kind: 'externalRequest', target: 'https://unknown.example.org', page: '/blog/' },
        { kind: 'http', status: 404, target: '/missing.riv', page: '/blog/' },
      ],
    },
  });

  assert.equal(report.status, 'unsupported-runtime-detected');
  assert.equal(report.unsupportedRuntimeServices, 5);
  assert.deepEqual(report.services.map(service => ({
    id: service.id,
    kind: service.kind,
    browserReferences: service.browserReferences,
    browserPages: service.browserPages,
  })), [
    { id: 'carbonads', kind: 'advertising', browserReferences: 1, browserPages: ['/blog/'] },
    { id: 'external-unknown-example-org', kind: 'external-runtime', browserReferences: 1, browserPages: ['/blog/'] },
    { id: 'iconify', kind: 'icon-api', browserReferences: 2, browserPages: ['/'] },
    { id: 'vite-sponsors', kind: 'sponsorship-widget', browserReferences: 1, browserPages: ['/guide/'] },
    { id: 'youtube', kind: 'video-embed', browserReferences: 1, browserPages: ['/blog/announcing-vite6/'] },
  ]);
});
