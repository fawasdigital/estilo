#!/usr/bin/env node
/**
 * Static site mirror.
 *
 * Recursively crawls a site, saves pages as directory indexes
 * (/contact/ -> contact/index.html), downloads images, CSS, JS, and fonts,
 * and rewrites the original absolute URLs to root-relative paths.
 *
 *   npm install
 *   npm run mirror
 *   npx serve dist
 *
 *   node mirror.js --url https://www.myprintclub.in/ --out dist --delay 400
 */

const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');

const ASSET_EXT = new Set([
  'css', 'js', 'mjs', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif',
  'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'json', 'webmanifest',
]);

const REMOTE_EXT = new Set([
  'css', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

const TEXT_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.svg', '.json', '.webmanifest', '.txt', '.xml',
]);

const MAX_PAGES = 500;
const MAX_ASSETS = 5000;
const MAX_BYTES = 30 * 1024 * 1024;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 StaticMirror/1.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createContext(start) {
  const origin = new URL(start);
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('Start URL must be http or https');
  }
  const hosts = new Set([origin.hostname.toLowerCase()]);
  if (origin.hostname.toLowerCase().startsWith('www.')) {
    hosts.add(origin.hostname.toLowerCase().slice(4));
  } else {
    hosts.add(`www.${origin.hostname.toLowerCase()}`);
  }
  return {
    origin: origin.origin,
    primaryHost: origin.hostname.toLowerCase(),
    hosts,
    protocol: origin.protocol,
    startHref: origin.href,
  };
}

function isInternal(urlObj, ctx) {
  return ctx.hosts.has(urlObj.hostname.toLowerCase());
}

function isTrackerHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'www.w3.org' ||
    host === 'schema.org' ||
    host.endsWith('.schema.org') ||
    host === 'wa.me' ||
    host.endsWith('.wa.me') ||
    host.includes('googletagmanager') ||
    host.includes('google-analytics') ||
    host.includes('googleadservices') ||
    host.endsWith('doubleclick.net') ||
    host.endsWith('facebook.com') ||
    host.endsWith('facebook.net') ||
    host.endsWith('fbcdn.net') ||
    host.endsWith('hotjar.com') ||
    host.endsWith('segment.io') ||
    host.endsWith('sentry.io') ||
    host.endsWith('openai.com')
  );
}

function extensionOf(pathname) {
  return path.posix.extname(pathname).toLowerCase().replace('.', '');
}

function safePosixPath(pathname) {
  let decoded = pathname || '/';
  try {
    decoded = decodeURIComponent(pathname || '/');
  } catch {
    decoded = pathname || '/';
  }
  const parts = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment.replace(/[<>:"\\|?*\u0000-\u001f]/g, '_'));
  }
  return `/${parts.join('/')}`;
}

function decodeUrlToken(value) {
  let text = String(value || '').trim();
  text = text.replace(/^['"]+|['"]+$/g, '');
  text = text.replace(/\\+$/g, '');
  text = text.replace(/[),;]+$/g, '');
  text = text.replace(/\\u0026/gi, '&');
  text = text.replace(/\\u002f/gi, '/');
  text = text.replace(/\\\//g, '/');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&#0*38;/g, '&');
  text = text.replace(/&#x0*26;/gi, '&');
  return text.trim();
}

function parseSrcset(value) {
  if (!value) return [];
  const urls = [];
  for (const part of String(value).split(',')) {
    const token = part.trim().split(/\s+/)[0];
    if (!token || token.startsWith('data:')) continue;
    urls.push(token);
  }
  return urls;
}

function extractCssUrls(css) {
  const urls = [];
  const urlRe = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
  let match = urlRe.exec(css);
  while (match) {
    const raw = match[2].trim();
    if (raw && !raw.startsWith('data:') && !raw.startsWith('#')) urls.push(raw);
    match = urlRe.exec(css);
  }
  const importRe = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gi;
  match = importRe.exec(css);
  while (match) {
    urls.push(match[1]);
    match = importRe.exec(css);
  }
  return urls;
}

function findNextImageRefs(text) {
  const refs = [];
  const needle = '/_next/image?';
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    let start = index;
    const prefix = text.slice(Math.max(0, index - 80), index);
    const hostPrefix = prefix.match(/(https?:(?:\\\/\\\/|\/\/)[^\s"'<>]*)$/);
    if (hostPrefix) start = index - hostPrefix[1].length;
    let end = index + needle.length;
    while (end < text.length && !/[\s"'<>]/.test(text[end])) end += 1;
    const token = text.slice(start, end).replace(/\\+$/g, '');
    if (token.length < 2000) refs.push(token);
    index = end;
  }
  return refs;
}

function findAssetRefs(text) {
  const re = /(?:https?:\/\/[^\s"'()<>]+|\/(?!\/)[^\s"'()<>]+)\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|avif|ico|woff2?|ttf|otf|eot)(?:\?[^\s"'()<>]*)?/gi;
  return text.match(re) || [];
}

function shouldMirrorAsset(urlObj, ctx) {
  if (!urlObj || (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:')) return false;
  if (isTrackerHost(urlObj.hostname)) return false;
  if (urlObj.href.includes('{') || urlObj.href.includes('}') || urlObj.href.includes('${')) return false;
  if (urlObj.href.includes('%7B') || urlObj.href.includes('%7b')) return false;
  if (/[*$,]/.test(urlObj.pathname)) return false;
  if (urlObj.href.length > 2000) return false;
  const ext = extensionOf(urlObj.pathname);
  if (!ASSET_EXT.has(ext)) return false;
  if (urlObj.pathname.includes('node_modules')) return false;
  if (isInternal(urlObj, ctx)) {
    if (ext === 'js' || ext === 'mjs') {
      const depth = urlObj.pathname.split('/').filter(Boolean).length;
      return urlObj.pathname.startsWith('/_next/') || depth === 1;
    }
    return true;
  }
  return REMOTE_EXT.has(ext);
}

function canonicalPageUrl(input, ctx) {
  const urlObj = new URL(input);
  if (!isInternal(urlObj, ctx)) return null;
  urlObj.hash = '';
  urlObj.search = '';
  urlObj.hostname = ctx.primaryHost;
  urlObj.protocol = ctx.protocol;
  const pathname = safePosixPath(urlObj.pathname);
  const ext = extensionOf(pathname);
  if (pathname.startsWith('/_next') || pathname.startsWith('/api')) return null;
  if (ext && ext !== 'html' && ext !== 'htm') return null;
  urlObj.pathname = pathname;
  return urlObj.href;
}

function canonicalAssetUrl(input, ctx) {
  const urlObj = new URL(input);
  urlObj.hash = '';
  if (isInternal(urlObj, ctx)) {
    urlObj.hostname = ctx.primaryHost;
    urlObj.protocol = ctx.protocol;
    const ext = extensionOf(urlObj.pathname);
    if (urlObj.pathname !== '/_next/image' && ASSET_EXT.has(ext)) urlObj.search = '';
  }
  return urlObj.href;
}

function extFromContentType(contentType) {
  const map = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/x-javascript': '.js',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'application/font-woff': '.woff',
    'application/json': '.json',
  };
  return map[String(contentType || '').split(';')[0].trim().toLowerCase()] || '';
}

function toAssetPublicPath(assetUrl, contentType, ctx) {
  const urlObj = new URL(assetUrl);
  const internal = isInternal(urlObj, ctx);
  if (internal && urlObj.pathname !== '/_next/image') {
    const ext = extensionOf(urlObj.pathname);
    if (ASSET_EXT.has(ext)) urlObj.search = '';
  }
  let pathname = safePosixPath(urlObj.pathname);
  let ext = path.posix.extname(pathname);
  if (!ext) {
    ext = extFromContentType(contentType);
    pathname += ext;
  }
  if (urlObj.search) {
    const hash = crypto.createHash('sha1').update(urlObj.pathname + urlObj.search).digest('hex').slice(0, 10);
    const dir = path.posix.dirname(pathname);
    const base = path.posix.basename(pathname, ext || undefined);
    pathname = `${dir === '/' ? '' : dir}/${base}__q_${hash}${ext}`;
  }
  if (!internal) {
    pathname = `/_external/${urlObj.hostname.toLowerCase()}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }
  return pathname.replace(/\/{2,}/g, '/');
}

function toPageFile(pageUrl) {
  const urlObj = new URL(pageUrl);
  const pathname = safePosixPath(urlObj.pathname);
  const ext = path.posix.extname(pathname).toLowerCase();
  if (ext === '.html' || ext === '.htm') return pathname.replace(/^\/+/, '');
  if (pathname === '/') return 'index.html';
  return `${pathname.replace(/^\/+/, '')}/index.html`;
}

function diskPathFor(outDir, publicPath) {
  const rel = String(publicPath || '').replace(/^\/+/, '');
  if (!rel) throw new Error('Refusing to write an empty path');
  const resolved = path.resolve(outDir, rel);
  const relative = path.relative(path.resolve(outDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside output directory: ${publicPath}`);
  }
  return resolved;
}

function upstreamFromNextImage(urlObj) {
  if (urlObj.pathname !== '/_next/image') return null;
  const raw = urlObj.searchParams.get('url');
  if (!raw) return null;
  try {
    return new URL(raw, urlObj.origin);
  } catch {
    return null;
  }
}

function resolveToken(raw, baseUrl) {
  const decoded = decodeUrlToken(raw);
  if (!decoded || decoded.startsWith('data:') || decoded.startsWith('#')) return null;
  if (/^(mailto:|tel:|javascript:|blob:)/i.test(decoded)) return null;
  try {
    const urlObj = new URL(decoded, baseUrl);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return null;
    urlObj.hash = '';
    return { decoded, urlObj };
  } catch {
    return null;
  }
}

function discoverFromHtml(html, baseUrl, ctx) {
  const pages = new Set();
  const assets = new Set();
  const refs = [];

  function addAsset(raw, urlObj) {
    if (urlObj.pathname === '/_next/image') {
      const upstream = upstreamFromNextImage(urlObj);
      if (!upstream || !shouldMirrorAsset(upstream, ctx)) return;
      const canonical = canonicalAssetUrl(upstream.href, ctx);
      assets.add(canonical);
      refs.push({
        tokens: [raw, decodeUrlToken(raw), urlObj.href, upstream.href],
        canonical,
      });
      return;
    }
    if (!shouldMirrorAsset(urlObj, ctx)) return;
    const canonical = canonicalAssetUrl(urlObj.href, ctx);
    assets.add(canonical);
    refs.push({
      tokens: [raw, decodeUrlToken(raw), urlObj.href],
      canonical,
    });
  }

  function considerAsset(raw) {
    const resolved = resolveToken(raw, baseUrl);
    if (!resolved) return;
    addAsset(raw, resolved.urlObj);
  }

  function considerPage(raw) {
    const resolved = resolveToken(raw, baseUrl);
    if (!resolved) return;
    if (shouldMirrorAsset(resolved.urlObj, ctx)) {
      addAsset(raw, resolved.urlObj);
      return;
    }
    const canonical = canonicalPageUrl(resolved.urlObj.href, ctx);
    if (canonical) pages.add(canonical);
  }

  function scanText(text) {
    for (const ref of extractCssUrls(text)) considerAsset(ref);
    for (const ref of findNextImageRefs(text)) considerAsset(ref);
    for (const ref of findAssetRefs(text)) considerAsset(ref);
  }

  const $ = cheerio.load(html);
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    const resolvedBase = resolveToken(baseHref, baseUrl);
    if (resolvedBase) baseUrl = resolvedBase.urlObj.href;
  }

  $('a[href], area[href]').each((_, el) => considerPage($(el).attr('href')));

  $('link').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    const as = String($(el).attr('as') || '').toLowerCase();
    const href = $(el).attr('href');
    const srcset = $(el).attr('imagesrcset') || $(el).attr('srcset');
    if (rel === 'canonical' && href) considerPage(href);
    if (srcset) {
      for (const item of parseSrcset(srcset)) considerAsset(item);
    }
    if (!href) return;
    const resolved = resolveToken(href, baseUrl);
    if (!resolved) return;
    if (shouldMirrorAsset(resolved.urlObj, ctx) || resolved.urlObj.pathname === '/_next/image') {
      addAsset(href, resolved.urlObj);
      return;
    }
    if (rel === 'prefetch' || rel === 'next' || rel === 'canonical') considerPage(href);
    if (rel.includes('stylesheet') || rel.includes('icon') || ['font', 'image', 'style', 'script'].includes(as)) {
      considerAsset(href);
    }
  });

  $('[src]').each((_, el) => {
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'iframe') return;
    considerAsset($(el).attr('src'));
  });
  $('[poster]').each((_, el) => considerAsset($(el).attr('poster')));
  $('[srcset], [imagesrcset]').each((_, el) => {
    const value = $(el).attr('srcset') || $(el).attr('imagesrcset');
    for (const item of parseSrcset(value)) considerAsset(item);
  });
  $('[style]').each((_, el) => {
    for (const ref of extractCssUrls($(el).attr('style') || '')) considerAsset(ref);
  });
  $('style').each((_, el) => {
    for (const ref of extractCssUrls($(el).text() || '')) considerAsset(ref);
  });
  $('meta[content]').each((_, el) => {
    const key = `${$(el).attr('property') || ''} ${$(el).attr('name') || ''}`.toLowerCase();
    const content = $(el).attr('content');
    if (!content) return;
    if (key.includes('image')) considerAsset(content);
    else if (key.includes('og:url')) considerPage(content);
  });

  scanText(html);
  return { pages: [...pages].sort(), assets: [...assets].sort(), refs };
}

function discoverFromText(text, baseUrl, ctx) {
  const assets = new Set();
  const refs = [];

  function considerAsset(raw) {
    const resolved = resolveToken(raw, baseUrl);
    if (!resolved) return;
    if (resolved.urlObj.pathname === '/_next/image') {
      const upstream = upstreamFromNextImage(resolved.urlObj);
      if (!upstream || !shouldMirrorAsset(upstream, ctx)) return;
      const canonical = canonicalAssetUrl(upstream.href, ctx);
      assets.add(canonical);
      refs.push({
        tokens: [raw, decodeUrlToken(raw), resolved.urlObj.href, upstream.href],
        canonical,
      });
      return;
    }
    if (!shouldMirrorAsset(resolved.urlObj, ctx)) return;
    const canonical = canonicalAssetUrl(resolved.urlObj.href, ctx);
    assets.add(canonical);
    refs.push({ tokens: [raw, decodeUrlToken(raw), resolved.urlObj.href], canonical });
  }

  for (const ref of extractCssUrls(text)) considerAsset(ref);
  for (const ref of findNextImageRefs(text)) considerAsset(ref);
  for (const ref of findAssetRefs(text)) considerAsset(ref);
  return { assets: [...assets].sort(), refs };
}

function expandVariants(token, ctx) {
  const seeds = new Set([token]);
  if (token.includes('&')) {
    seeds.add(token.replace(/&/g, '&amp;'));
    seeds.add(token.replace(/&/g, '&#38;'));
    seeds.add(token.replace(/&/g, '&#x26;'));
    seeds.add(token.replace(/&/g, '\\u0026'));
  }
  if (token.includes('&amp;')) seeds.add(token.replace(/&amp;/g, '&'));
  if (/\\u0026/i.test(token)) seeds.add(token.replace(/\\u0026/gi, '&'));

  const expanded = new Set();
  for (const seed of seeds) {
    expanded.add(seed);
    const parsed = resolveToken(seed, ctx.origin);
    if (!parsed || !isInternal(parsed.urlObj, ctx)) continue;
    const rel = `${parsed.urlObj.pathname}${parsed.urlObj.search}`;
    expanded.add(rel);
    for (const host of ctx.hosts) {
      expanded.add(`https://${host}${rel}`);
      expanded.add(`http://${host}${rel}`);
      expanded.add(`//${host}${rel}`);
    }
  }

  const out = new Set();
  for (const item of expanded) {
    if (!item || item.length < 2) continue;
    out.add(item);
    if (item.includes('/') && !item.includes('\\/')) out.add(item.replace(/\//g, '\\/'));
  }
  return [...out];
}

function buildRewritePairs(refs, publicPaths, ctx) {
  const pairs = [];
  const seen = new Set();
  for (const ref of refs) {
    const target = publicPaths.get(ref.canonical);
    if (!target) continue;
    for (const token of ref.tokens || []) {
      if (!token || token.length > 2000) continue;
      for (const variant of expandVariants(token, ctx)) {
        const to = variant.includes('\\/') ? target.replace(/\//g, '\\/') : target;
        if (!variant || variant === to) continue;
        const signature = `${variant}\n${to}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        pairs.push([variant, to]);
      }
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

function applyPairs(text, pairs) {
  let out = text;
  for (const [from, to] of pairs) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function rewriteOrigins(content, ctx) {
  const hosts = [...ctx.hosts].sort((a, b) => b.length - a.length);
  const hostAlt = hosts.map(escapeRegExp).join('|');
  const finish = (rest) => {
    if (rest.startsWith('\\/')) return '';
    if (rest.startsWith('/')) return '';
    // Bare origins also appear before an escaped quote in Next.js flight data:
    // https://example.com\"  or https://example.com\\\"
    if (rest.length === 0 || /^["'`\s<),;?#\\]/.test(rest)) return '/';
    return null;
  };

  let out = content.replace(new RegExp(`https?:\\\\/\\\\/(?:${hostAlt})`, 'g'), (match, offset, string) => {
    const replacement = finish(string.slice(offset + match.length));
    return replacement === null ? match : replacement;
  });
  out = out.replace(new RegExp(`(?:https?:)?\\/\\/(?:${hostAlt})`, 'g'), (match, offset, string) => {
    const replacement = finish(string.slice(offset + match.length));
    return replacement === null ? match : replacement;
  });
  return out;
}

const STATIC_NAV_SCRIPT = '<script data-static-mirror="nav">document.addEventListener("click",function(e){if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a||(a.target&&a.target!=="_self"))return;var u;try{u=new URL(a.href,location.href)}catch(err){return}if(u.origin!==location.origin)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();location.assign(u.href)},true);</script>';

function enableStaticNavigation(html) {
  const existing = html.match(/<script data-static-mirror="nav">[\s\S]*?<\/script>/);
  if (existing) {
    return existing[0] === STATIC_NAV_SCRIPT ? html : html.replace(existing[0], STATIC_NAV_SCRIPT);
  }
  if (html.includes('<head>')) return html.replace('<head>', `<head>${STATIC_NAV_SCRIPT}`);
  return `${STATIC_NAV_SCRIPT}${html}`;
}

function rewriteContent(text, pairs, ctx, fileExt) {
  let out = applyPairs(text, pairs);
  out = rewriteOrigins(out, ctx);
  if (fileExt === '.html' || fileExt === '.htm') {
    out = out.replace(/\s+integrity=(?:"[^"]*"|'[^']*')/g, '');
    out = enableStaticNavigation(out);
  }
  return out;
}

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      job.fn().then(job.resolve, job.reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

function createGap(ms) {
  let chain = Promise.resolve();
  let first = true;
  return function gap() {
    const job = chain.then(async () => {
      if (first) {
        first = false;
        return;
      }
      if (ms > 0) await sleep(ms);
    });
    chain = job.then(() => {}, () => {});
    return job;
  };
}

function mediaType(response) {
  return String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
}

function isTextType(type) {
  return type.startsWith('text/') || type.includes('javascript') || type.includes('json') || type.includes('xml') || type.includes('svg');
}

function isRetryable(error) {
  const status = error.response?.status;
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (!status && ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(error.code)) return true;
  return false;
}

async function fetchBuffer(url, kind) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 45000,
        maxRedirects: 5,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: kind === 'page'
            ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            : '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        validateStatus: (status) => status >= 200 && status < 300,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === 5) throw error;
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 700 * attempt * attempt;
      const status = error.response?.status || error.code || 'error';
      console.warn(`[mirror] retry ${attempt} (${status}) ${url}`);
      await sleep(wait);
    }
  }
  throw lastError;
}

function finalResponseUrl(response, fallback) {
  return response?.request?.res?.responseUrl || response?.request?.responseURL || fallback;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function resolveOutDir(out) {
  const resolved = path.resolve(process.cwd(), out);
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Output directory must stay inside the current working directory');
  }
  if (resolved === path.parse(resolved).root) {
    throw new Error('Refusing to use the filesystem root as output');
  }
  return resolved;
}

async function mirrorSite(options) {
  const ctx = createContext(options.url);
  ctx.outDir = resolveOutDir(options.out);
  ctx.delay = options.delay;
  const limit = createLimiter(options.concurrency);
  const gap = createGap(options.delay);
  const queued = new Set();
  const publicPaths = new Map();
  const refs = [];
  const failures = [];
  const pagesSaved = [];
  const assetsSaved = [];
  let pending = 0;
  let pageCount = 0;
  let assetCount = 0;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function remember(discovered) {
    refs.push(...discovered.refs);
  }

  function enqueue(url, kind) {
    if (kind === 'page' && pageCount >= MAX_PAGES) return;
    if (kind === 'asset' && assetCount >= MAX_ASSETS) return;
    const key = kind === 'page' ? canonicalPageUrl(url, ctx) : canonicalAssetUrl(url, ctx);
    if (!key) return;
    const seenKey = `${kind} ${key}`;
    if (queued.has(seenKey)) return;
    queued.add(seenKey);
    if (kind === 'page') pageCount += 1;
    else assetCount += 1;
    pending += 1;
    limit(() => processOne(key, kind).finally(() => {
      pending -= 1;
      if (pending === 0) resolveDone();
    }));
  }

  async function processOne(url, kind) {
    await gap();
    let response;
    try {
      response = await fetchBuffer(url, kind);
    } catch (error) {
      const status = error.response?.status || error.code || error.message;
      failures.push({ url, kind, status });
      console.warn(`[mirror] fail ${status} ${url}`);
      return;
    }

    const buffer = Buffer.from(response.data);
    if (!buffer.length || buffer.length > MAX_BYTES) {
      failures.push({ url, kind, status: buffer.length ? 'too-large' : 'empty' });
      console.warn(`[mirror] skip ${buffer.length ? 'too-large' : 'empty'} ${url}`);
      return;
    }

    const type = mediaType(response);
    const responseUrl = finalResponseUrl(response, url);
    const baseUrl = (() => {
      try {
        const finalUrl = new URL(responseUrl);
        return isInternal(finalUrl, ctx) ? finalUrl.href : url;
      } catch {
        return url;
      }
    })();

    if (kind === 'page') {
      if (!type.includes('html') && !type.includes('xml')) {
        failures.push({ url, kind, status: `unexpected ${type || 'type'}` });
        console.warn(`[mirror] skip non-html page ${url}`);
        return;
      }
      const html = buffer.toString('utf8');
      const discovered = discoverFromHtml(html, baseUrl, ctx);
      remember(discovered);
      for (const page of discovered.pages) enqueue(page, 'page');
      for (const asset of discovered.assets) enqueue(asset, 'asset');
      const relativeFile = toPageFile(url);
      const publicPath = `/${relativeFile}`;
      await fs.outputFile(diskPathFor(ctx.outDir, publicPath), html);
      pagesSaved.push(relativeFile);
      console.log(`[mirror] page  /${relativeFile}`);
      return;
    }

    if (type.includes('text/html') || type.includes('text/x-component')) {
      failures.push({ url, kind, status: 'unexpected-html' });
      console.warn(`[mirror] skip html asset ${url}`);
      return;
    }

    const publicPath = toAssetPublicPath(url, type, ctx);
    publicPaths.set(url, publicPath);
    await fs.outputFile(diskPathFor(ctx.outDir, publicPath), buffer);
    assetsSaved.push(publicPath);
    console.log(`[mirror] asset ${publicPath}`);

    if (isTextType(type)) {
      const discovered = discoverFromText(buffer.toString('utf8'), baseUrl, ctx);
      remember(discovered);
      for (const asset of discovered.assets) enqueue(asset, 'asset');
    }
  }

  await fs.emptyDir(ctx.outDir);
  console.log(`[mirror] ${ctx.startHref}`);
  console.log(`[mirror] -> ${ctx.outDir}`);
  enqueue(ctx.startHref, 'page');
  if (pending === 0) resolveDone();
  await done;

  const pairs = buildRewritePairs(refs, publicPaths, ctx);
  const files = await walk(ctx.outDir);
  let leftoverOptimizer = 0;
  let leftoverOrigin = 0;
  const hostAlt = [...ctx.hosts].map(escapeRegExp).join('|');
  const originRe = new RegExp(`https?:\\\\?/\\\\?/(?:www\\.)?(?:${hostAlt})`, 'g');

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    const original = await fs.readFile(file, 'utf8');
    if (original.includes('\u0000')) continue;
    const rewritten = rewriteContent(original, pairs, ctx, ext);
    if (rewritten !== original) await fs.writeFile(file, rewritten);
    if (ext === '.html' || ext === '.htm') {
      leftoverOptimizer += (rewritten.match(/\/_next\/image\?/g) || []).length;
      leftoverOrigin += (rewritten.match(originRe) || []).length;
    }
  }

  return {
    outDir: ctx.outDir,
    pages: pagesSaved,
    assets: assetsSaved,
    failures,
    rewritePairs: pairs.length,
    leftoverOptimizer,
    leftoverOrigin,
  };
}

function parseArgs(argv) {
  const opts = {
    url: 'https://www.myprintclub.in/',
    out: 'dist',
    delay: 400,
    concurrency: 2,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url' && next) {
      opts.url = next;
      i += 1;
    } else if (arg === '--out' && next) {
      opts.out = next;
      i += 1;
    } else if (arg === '--delay' && next) {
      opts.delay = Number(next);
      i += 1;
    } else if (arg === '--concurrency' && next) {
      opts.concurrency = Number(next);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) opts.delay = 400;
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) opts.concurrency = 1;
  opts.concurrency = Math.min(Math.floor(opts.concurrency), 6);
  return opts;
}

function printHelp() {
  console.log(`Usage: node mirror.js [--url URL] [--out dist] [--delay 400] [--concurrency 2]

Crawls a website into a static folder.
Pages are saved as clean directory indexes (contact/index.html).
Images, CSS, JS, and fonts are mirrored. Next.js /_next/image srcset
URLs are rewritten to the downloaded source image.
After the crawl, absolute URLs on the original host become root-relative.`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }
  const summary = await mirrorSite(options);
  console.log('');
  console.log(`[mirror] pages: ${summary.pages.length}`);
  console.log(`[mirror] assets: ${summary.assets.length}`);
  console.log(`[mirror] rewrite rules: ${summary.rewritePairs}`);
  console.log(`[mirror] failures: ${summary.failures.length}`);
  if (summary.leftoverOptimizer) {
    console.warn(`[mirror] warning: ${summary.leftoverOptimizer} /_next/image URLs remain`);
  }
  if (summary.leftoverOrigin) {
    console.warn(`[mirror] warning: ${summary.leftoverOrigin} absolute origin URLs remain`);
  }
  console.log(`[mirror] output: ${summary.outDir}`);
  if (!summary.pages.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mirror] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  applyPairs,
  buildRewritePairs,
  canonicalAssetUrl,
  canonicalPageUrl,
  createContext,
  decodeUrlToken,
  discoverFromHtml,
  diskPathFor,
  expandVariants,
  extractCssUrls,
  findNextImageRefs,
  parseSrcset,
  enableStaticNavigation,
  rewriteContent,
  rewriteOrigins,
  safePosixPath,
  toAssetPublicPath,
  toPageFile,
};
