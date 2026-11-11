import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleIconRequest,
  normalizeIconDomain,
  renderFallbackIcon,
  toLocalIconUrl,
} from '../functions/lib/icon-proxy.js';
import { buildCardViewModel } from '../functions/lib/card-model.js';
import { renderSiteCards } from '../functions/lib/card-renderer.js';
import { parseSettings } from '../functions/lib/settings-parser.js';

test('normalizeIconDomain 只接受规范域名', () => {
  assert.equal(normalizeIconDomain('github.com'), 'github.com');
  assert.equal(normalizeIconDomain('  PanHub.ShenZJD.com  '), 'panhub.shenzjd.com');
  assert.equal(normalizeIconDomain('https://www.youtube.com/watch?v=1'), 'www.youtube.com');
  // 端口和路径只做丢弃处理，域名本身仍然可用
  assert.equal(normalizeIconDomain('http://jenkins.local:8080/job/a'), 'jenkins.local');

  assert.equal(normalizeIconDomain(''), '');
  assert.equal(normalizeIconDomain('localhost'), '');
  // 纯 IP 不当作域名：避免这个端点被拿去探测内网地址
  assert.equal(normalizeIconDomain('192.168.1.1'), '');
  assert.equal(normalizeIconDomain('javascript:alert(1)'), '');
  assert.equal(normalizeIconDomain('https://'), '');
});

test('toLocalIconUrl 把第三方图标服务收敛到同源 /icon', () => {
  assert.equal(
    toLocalIconUrl('https://faviconsnap.com/api/favicon?url=panhub.shenzjd.com'),
    '/icon?url=panhub.shenzjd.com'
  );
  assert.equal(
    toLocalIconUrl('https://favicon.im/github.com?larger=true'),
    '/icon?url=github.com'
  );
  assert.equal(
    toLocalIconUrl('https://www.faviconextractor.com/favicon/www.bilibili.com?larger=true'),
    '/icon?url=www.bilibili.com'
  );
  assert.equal(
    toLocalIconUrl('https://www.google.com/s2/favicons?domain=npm.zhangchangsheng.top&sz=64'),
    '/icon?url=npm.zhangchangsheng.top'
  );
});

test('toLocalIconUrl 不动普通 logo 与无法解析的图标地址', () => {
  assert.equal(toLocalIconUrl('https://cdn.example.com/logo.png'), 'https://cdn.example.com/logo.png');
  // google.com 只有 /s2/favicons 才是图标服务，主页图标保持原样
  assert.equal(
    toLocalIconUrl('https://www.google.com/favicon.ico'),
    'https://www.google.com/favicon.ico'
  );
  assert.equal(toLocalIconUrl('https://faviconsnap.com/api/favicon'), 'https://faviconsnap.com/api/favicon');
  assert.equal(toLocalIconUrl(''), '');
  assert.equal(toLocalIconUrl('javascript:alert(1)'), '');
});

test('renderFallbackIcon 生成确定性的字母占位图', () => {
  const first = renderFallbackIcon('github.com');
  const second = renderFallbackIcon('github.com');

  assert.equal(first, second);
  assert.match(first, /^<svg /);
  assert.match(first, />G<\/text>/);
  assert.notEqual(renderFallbackIcon('npm.zhangchangsheng.top'), first);
  // www 前缀不参与取首字母
  assert.match(renderFallbackIcon('www.bilibili.com'), />B<\/text>/);
});

test('buildCardViewModel 把存量第三方 logo 改写为同源地址', () => {
  const card = buildCardViewModel({
    id: 1,
    name: 'GitHub',
    url: 'https://github.com',
    logo: 'https://faviconsnap.com/api/favicon?url=github.com',
  });

  assert.equal(card.logoUrlHtml, '/icon?url=github.com');
});

test('renderSiteCards 输出的 img 不再指向第三方图标服务', () => {
  const html = renderSiteCards([
    {
      id: 1,
      name: 'GitHub',
      url: 'https://github.com',
      logo: 'https://faviconsnap.com/api/favicon?url=github.com',
      desc: 'code hosting',
      catelog_name: 'dev',
    },
  ], parseSettings([]));

  assert.match(html, /src="\/icon\?url=github\.com"/);
  assert.doesNotMatch(html, /faviconsnap\.com/);
});

// --- handleIconRequest 的运行时行为 ---
// 用假的 caches / fetch 覆盖全局对象，验证缓存命中、上游成功、全部失败三条链路。

function createFakeCache() {
  const store = new Map();
  return {
    async match(key) {
      const hit = store.get(key.url);
      return hit ? hit.clone() : undefined;
    },
    async put(key, response) {
      store.set(key.url, response.clone());
    },
    store,
  };
}

function withGlobals({ cache, fetchImpl }, fn) {
  const originalFetch = globalThis.fetch;
  const hadCaches = Object.prototype.hasOwnProperty.call(globalThis, 'caches');
  const originalCaches = globalThis.caches;

  globalThis.fetch = fetchImpl;
  Object.defineProperty(globalThis, 'caches', { value: { default: cache }, configurable: true, writable: true });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
      if (hadCaches) {
        Object.defineProperty(globalThis, 'caches', { value: originalCaches, configurable: true, writable: true });
      } else {
        delete globalThis.caches;
      }
    });
}

test('handleIconRequest 缺少 url 参数时返回 400', async () => {
  const response = await handleIconRequest(new Request('https://nav.example/icon'));

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('handleIconRequest 命中边缘缓存时直接返回且不再请求上游', async () => {
  const cache = createFakeCache();
  await cache.put(
    new Request('https://icon-cache.invalid/github.com'),
    new Response('cached-icon', { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })
  );

  let upstreamCalls = 0;
  const response = await withGlobals({
    cache,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('unexpected', { status: 500 });
    },
  }, () => handleIconRequest(new Request('https://nav.example/icon?url=github.com')));

  assert.equal(upstreamCalls, 0);
  assert.equal(response.headers.get('X-Icon-Cache'), 'HIT');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(await response.text(), 'cached-icon');
});

test('handleIconRequest 上游成功时写入缓存并返回长缓存响应', async () => {
  const cache = createFakeCache();
  const imageBody = new Uint8Array(200).fill(7);

  const response = await withGlobals({
    cache,
    fetchImpl: async (target) => {
      assert.match(String(target), /^https:\/\/faviconsnap\.com\/api\/favicon\?url=github\.com$/);
      return new Response(imageBody, {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '200' },
      });
    },
  }, () => handleIconRequest(new Request('https://nav.example/icon?url=github.com')));

  assert.equal(response.headers.get('X-Icon-Cache'), 'MISS');
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  assert.equal((await response.arrayBuffer()).byteLength, 200);
  assert.ok(cache.store.has('https://icon-cache.invalid/github.com'));
});

test('handleIconRequest 上游全部失败时返回字母占位图且只短暂缓存', async () => {
  const cache = createFakeCache();

  const response = await withGlobals({
    cache,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  }, () => handleIconRequest(new Request('https://nav.example/icon?url=github.com')));

  assert.equal(response.headers.get('X-Icon-Cache'), 'FALLBACK');
  assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=600');
  assert.match(await response.text(), /^<svg /);
});
