const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRewritePairs,
  canonicalAssetUrl,
  canonicalPageUrl,
  createContext,
  discoverFromHtml,
  diskPathFor,
  parseSrcset,
  rewriteContent,
  safePosixPath,
  toAssetPublicPath,
  toPageFile,
} = require('../mirror');

const ctx = createContext('https://www.myprintclub.in/');

test('parseSrcset keeps every candidate and drops descriptors', () => {
  const value = '/_next/image?url=https%3A%2F%2Fcdn.example%2Fa.jpg&w=64&q=75 1x, /_next/image?url=https%3A%2F%2Fcdn.example%2Fa.jpg&w=128&q=75 2x';
  assert.deepEqual(parseSrcset(value), [
    '/_next/image?url=https%3A%2F%2Fcdn.example%2Fa.jpg&w=64&q=75',
    '/_next/image?url=https%3A%2F%2Fcdn.example%2Fa.jpg&w=128&q=75',
  ]);
});

test('clean URLs map routes onto index.html files', () => {
  assert.equal(toPageFile('https://www.myprintclub.in/'), 'index.html');
  assert.equal(toPageFile('https://www.myprintclub.in/contact'), 'contact/index.html');
  assert.equal(toPageFile('https://www.myprintclub.in/contact/'), 'contact/index.html');
  assert.equal(
    toPageFile('https://myprintclub.in/products/solid-color-custom-polo-t-shirt?mode=single'),
    'products/solid-color-custom-polo-t-shirt/index.html',
  );
});

test('page and asset URLs are normalized once', () => {
  assert.equal(
    canonicalPageUrl('https://myprintclub.in/products/foo?mode=single#details', ctx),
    'https://www.myprintclub.in/products/foo',
  );
  assert.equal(
    canonicalAssetUrl('https://myprintclub.in/favicon.ico?favicon.40-5wmbpkgfzf.ico', ctx),
    'https://www.myprintclub.in/favicon.ico',
  );
  assert.equal(
    toAssetPublicPath('https://www.myprintclub.in/fonts/a.woff2?dpl=123', 'font/woff2', ctx),
    '/fonts/a.woff2',
  );
  assert.equal(
    toAssetPublicPath('https://cdn.example/storage/v1/a.jpg', 'image/jpeg', ctx),
    '/_external/cdn.example/storage/v1/a.jpg',
  );
});

test('path traversal cannot leave the output directory', () => {
  assert.equal(safePosixPath('/a/../../b.png'), '/b.png');
  assert.throws(() => diskPathFor('/tmp/mirror-out', '/../../etc/passwd'));
});

test('discovery follows links, srcset, and imageSrcSet, and skips trackers', () => {
  const html = `
    <html><head>
      <link rel="stylesheet" href="/_next/static/chunks/app.css?dpl=abc">
      <link rel="preload" as="image" imageSrcSet="/_next/image?url=https%3A%2F%2Fcdn.example%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_next/image?url=https%3A%2F%2Fcdn.example%2Fhero.jpg&amp;w=1080&amp;q=75 1080w">
      <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
    </head><body>
      <a href="/contact">Contact</a>
      <a href="/products/cap?mode=single">Cap</a>
      <a href="mailto:hello@myprintclub.in">Mail</a>
      <a href="https://wa.me/919124735945">WhatsApp</a>
      <img srcSet="/_next/image?url=https%3A%2F%2Fcdn.example%2Fhero.jpg&amp;w=64&amp;q=75 1x, /_next/image?url=https%3A%2F%2Fcdn.example%2Fhero.jpg&amp;w=128&amp;q=75 2x">
      <img src="https://cdn.example/gallery/team.jpg" alt="">
      <img src="https://www.facebook.com/tr?id=1&amp;ev=PageView" alt="">
    </body></html>`;
  const found = discoverFromHtml(html, 'https://www.myprintclub.in/products', ctx);
  assert.ok(found.pages.includes('https://www.myprintclub.in/contact'));
  assert.ok(found.pages.includes('https://www.myprintclub.in/products/cap'));
  assert.equal(found.pages.some((page) => page.includes('wa.me')), false);
  assert.ok(found.assets.includes('https://www.myprintclub.in/_next/static/chunks/app.css'));
  assert.ok(found.assets.includes('https://cdn.example/hero.jpg'));
  assert.ok(found.assets.includes('https://cdn.example/gallery/team.jpg'));
  assert.equal(found.assets.some((asset) => asset.includes('/_next/image')), false);
  assert.equal(found.assets.some((asset) => asset.includes('googletagmanager')), false);
  assert.equal(found.assets.some((asset) => asset.includes('facebook.com')), false);
  assert.equal(found.assets.filter((asset) => asset === 'https://cdn.example/hero.jpg').length, 1);
});

test('post-process rewrites absolute URLs and srcset without touching email addresses', () => {
  const html = [
    '<img srcSet="/_next/image?url=https%3A%2F%2Fcdn.example%2Fa.jpg&amp;w=64&amp;q=75 1x, /_next/image?url=https%3A%2F%2Fcdn.example%2Fa.jpg&amp;w=128&amp;q=75 2x">',
    '<a href="https://www.myprintclub.in/contact">Contact</a>',
    '<a href="https://myprintclub.in/products">Products</a>',
    '<script>fetch("https:\\/\\/www.myprintclub.in\\/about")</script>',
    '<p>hello@myprintclub.in</p>',
  ].join('');
  const discovered = discoverFromHtml(html, 'https://www.myprintclub.in/', ctx);
  const publicPaths = new Map([
    ['https://cdn.example/a.jpg', '/_external/cdn.example/a.jpg'],
  ]);
  const pairs = buildRewritePairs(discovered.refs, publicPaths, ctx);
  const rewritten = rewriteContent(html, pairs, ctx, '.html');

  assert.equal(rewritten.includes('/_next/image?'), false);
  assert.equal(rewritten.includes('https://www.myprintclub.in'), false);
  assert.equal(rewritten.includes('https://myprintclub.in'), false);
  assert.match(rewritten, /\/_external\/cdn\.example\/a\.jpg 1x/);
  assert.match(rewritten, /\/_external\/cdn\.example\/a\.jpg 2x/);
  assert.match(rewritten, /href="\/contact"/);
  assert.match(rewritten, /href="\/products"/);
  assert.match(rewritten, /fetch\("\\\/about"\)/);
  assert.match(rewritten, /hello@myprintclub.in/);
});

test('bare origins inside escaped JSON become a root path', () => {
  const input = '{\\"content\\":\\"https://myprintclub.in\\",\\"logo\\":\\"https://www.myprintclub.in/icons/icon-192.png\\"}';
  const rewritten = rewriteContent(input, [], ctx, '.html');
  assert.equal(rewritten.includes('myprintclub.in'), false);
  assert.match(rewritten, /\\"content\\":\\"\/\\"/);
  assert.match(rewritten, /\\"logo\\":\\"\/icons\/icon-192.png\\"/);
});

test('html pages force ordinary link loads so static hosting can navigate', () => {
  const { enableStaticNavigation } = require('../mirror');
  const once = enableStaticNavigation('<head><title>Home</title></head>');
  const twice = enableStaticNavigation(once);
  assert.equal(once, twice);
  assert.match(once, /data-static-mirror="nav"/);
  assert.match(once, /location\.assign\(u\.href\)/);
});

test('template and accept-list strings are not treated as assets', () => {
  const html = '<input accept="*,.pdf,.ai,.psd,.svg"><img src="/video/upload/so_0,f_jpg/${s}.jpg">';
  const found = discoverFromHtml(html, 'https://www.myprintclub.in/', ctx);
  assert.deepEqual(found.assets, []);
});
