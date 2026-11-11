// functions/lib/icon-proxy.js
//
// 站点图标代理：把第三方 favicon 服务收敛到本站同源 /icon?url=<domain>。
//
// 动机（中国大陆直连场景）：
//   1. 首屏图标直连 faviconsnap.com 这类第三方域，每次都要多付一轮 DNS + TLS
//      握手，跨境链路上这两步就是 2 个 RTT 起步；换成同源后直接复用首页那条连接。
//   2. 第三方一般只给几小时缓存，过期后冷启动又要重走一遍跨境握手。
//   3. 上游被墙或超时后浏览器要一直挂到超时才显示占位图，首屏长期空着。
//      这里把上游超时压到 2.5s，失败立刻返回本地生成的字母占位图。
//
// 缓存分层：
//   - 浏览器：成功的图标 max-age=1 年 + immutable，域名到图标的映射基本不变。
//   - 边缘：Cache API 按 colo 缓存一份，配合上游 fetch 的 cacheTtlByStatus，
//     让第三方响应在 Cloudflare 侧也能跨 colo 复用。
//   - 失败兜底只缓存 10 分钟，避免一次上游抖动把占位图锁死一年。

const UPSTREAM_TIMEOUT_MS = 2500;
// 四个上游串行兜底时最坏要 10s，浏览器等不起；给整轮尝试一个总预算，
// 超出就立刻返回占位图（首屏宁可先出灰块，也不要卡住整页）。
const TOTAL_BUDGET_MS = 3500;
const MIN_IMAGE_BYTES = 100;
const SUCCESS_MAX_AGE = 31536000;
const FALLBACK_MAX_AGE = 600;
const UPSTREAM_CACHE_TTL = 2592000;

// 只接受规范域名，拒绝端口、路径、协议拼接等一切花活，避免这个端点被当成通用代理。
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

// 这些域名是「图标服务」专用域，出现即视为需要改写的第三方图标地址。
const ICON_PROVIDER_HOSTS = new Set([
  'faviconsnap.com',
  'www.faviconsnap.com',
  'favicon.im',
  'www.favicon.im',
  'faviconextractor.com',
  'www.faviconextractor.com',
]);

/**
 * 把各种写法的域名归一化成纯 hostname，非法输入返回空串。
 * @param {string} value - 可能是 "example.com"、"https://example.com/a/b?q=1"
 * @returns {string}
 */
export function normalizeIconDomain(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;

  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return DOMAIN_PATTERN.test(host) ? host : '';
  } catch {
    return '';
  }
}

/**
 * 判断一个绝对 URL 是否指向第三方图标服务。
 * google.com 只有走 /s2/favicons 才算，避免把用户真实收藏的谷歌主页图标误判。
 * @param {URL} parsed
 * @returns {boolean}
 */
function isThirdPartyIconUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (ICON_PROVIDER_HOSTS.has(host)) return true;
  if ((host === 'www.google.com' || host === 'google.com') && parsed.pathname.includes('/s2/favicons')) {
    return true;
  }
  if (host === 'icons.duckduckgo.com' && parsed.pathname.includes('/ip3')) return true;
  return false;
}

/**
 * 从第三方图标 URL 里还原出目标域名。
 * 例如 faviconsnap.com/api/favicon?url=github.com → github.com
 *      favicon.im/github.com → github.com
 * @param {URL} parsed
 * @returns {string}
 */
function extractIconDomain(parsed) {
  const embedded = parsed.searchParams.get('url')
    || parsed.searchParams.get('domain')
    || parsed.searchParams.get('domain_url');
  if (embedded) return normalizeIconDomain(embedded);

  const segments = parsed.pathname.split('/').filter(Boolean);
  return normalizeIconDomain(segments.pop() || '');
}

/**
 * 渲染时把第三方图标地址改写成本站 /icon。
 * 数据库里存的是绝对地址（导入/补全时写入），这里做渲染层收敛，
 * 免去对存量 166 条记录做 D1 数据迁移。
 * @param {string} logoUrl - 已经过 sanitizeUrl 的绝对地址
 * @param {string} iconBase - 本地图标端点前缀
 * @returns {string} 站内相对地址，或原地址，或空串
 */
export function toLocalIconUrl(logoUrl, iconBase = '/icon?url=') {
  if (!logoUrl) return '';

  let parsed;
  try {
    parsed = new URL(logoUrl);
  } catch {
    return logoUrl;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (!isThirdPartyIconUrl(parsed)) return logoUrl;

  const domain = extractIconDomain(parsed);
  // 解析不出域名时保持原样，宁可慢也不要变成坏图。
  return domain ? `${iconBase}${encodeURIComponent(domain)}` : logoUrl;
}

function buildUpstreams(domain) {
  const q = encodeURIComponent(domain);
  // 顺序按「命中率 + 国内可達性」排，faviconsnap 对中文站点覆盖最好。
  return [
    `https://faviconsnap.com/api/favicon?url=${q}`,
    `https://favicon.im/${q}?larger=true`,
    `https://www.faviconextractor.com/favicon/${q}?larger=true`,
    `https://www.google.com/s2/favicons?domain=${q}&sz=64`,
  ];
}

function hashHue(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * 生成确定性字母图标：同一域名永远同一颜色，不依赖外部资源。
 * @param {string} domain
 * @returns {string}
 */
export function renderFallbackIcon(domain) {
  const label = domain.replace(/^www\./, '');
  const letter = (label.charAt(0) || '?').toUpperCase();
  const hue = hashHue(label);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${letter}">`
    + `<rect width="64" height="64" rx="14" fill="hsl(${hue} 58% 46%)"/>`
    + `<text x="32" y="34" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="30" font-weight="600" fill="#ffffff">${letter}</text>`
    + '</svg>';
}

function buildImageResponse(body, contentType, maxAge, extraHeaders = {}) {
  return new Response(body, {
    headers: {
      'Content-Type': contentType || 'image/png',
      'Cache-Control': `public, max-age=${maxAge}${maxAge >= SUCCESS_MAX_AGE ? ', immutable' : ''}`,
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function withCacheState(response, state) {
  const cloned = new Response(response.body, response);
  cloned.headers.set('X-Icon-Cache', state);
  return cloned;
}

function getDefaultCache() {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

async function fetchFromUpstreams(domain) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const target of buildUpstreams(domain)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn(`Icon upstream budget exhausted for ${domain}`);
      break;
    }

    try {
      const response = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; iori-nav/1.0; +https://github.com/zcs19960929/iori-nav)',
          Accept: 'image/*',
        },
        signal: AbortSignal.timeout(Math.min(UPSTREAM_TIMEOUT_MS, remaining)),
        // 让第三方响应在 Cloudflare 边缘也能缓存，跨 colo 复用同一份图标。
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: { '200-299': UPSTREAM_CACHE_TTL, '404': 60, '500-599': 0 },
        },
      });

      if (!response.ok) {
        response.body?.cancel?.();
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('image')) {
        response.body?.cancel?.();
        continue;
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength && contentLength < MIN_IMAGE_BYTES) {
        response.body?.cancel?.();
        continue;
      }

      return { body: response.body, contentType };
    } catch (e) {
      console.warn(`Icon upstream failed [${target}]:`, e?.message || e);
    }
  }

  return null;
}

/**
 * /icon 与 /favicon 的共用处理逻辑。
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleIconRequest(request) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const domain = normalizeIconDomain(url.searchParams.get('url') || url.searchParams.get('domain'));
  if (!domain) {
    return new Response('Missing or invalid "url" parameter', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const edgeCache = getDefaultCache();
  const cacheKey = new Request(`https://icon-cache.invalid/${domain}`, { method: 'GET' });

  if (edgeCache) {
    try {
      const hit = await edgeCache.match(cacheKey);
      if (hit) return withCacheState(hit, 'HIT');
    } catch (e) {
      console.warn('Icon edge cache read failed:', e?.message || e);
    }
  }

  const upstream = await fetchFromUpstreams(domain);
  const response = upstream
    ? buildImageResponse(upstream.body, upstream.contentType, SUCCESS_MAX_AGE, { 'X-Icon-Cache': 'MISS' })
    : buildImageResponse(renderFallbackIcon(domain), 'image/svg+xml', FALLBACK_MAX_AGE, { 'X-Icon-Cache': 'FALLBACK' });

  if (edgeCache) {
    try {
      await edgeCache.put(cacheKey, response.clone());
    } catch (e) {
      console.warn('Icon edge cache write failed:', e?.message || e);
    }
  }

  return response;
}
