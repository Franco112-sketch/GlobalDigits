import { next, rewrite } from '@vercel/functions';

// Runs on EVERY request before Vercel resolves static files (including "/",
// which is what index.html was winning against under vercel.json's old
// "rewrites" rule — static files are matched before rewrites, so a host-based
// rewrite to reseller.html never fired for e.g. francostore.globaldigits.shop/).
// This only ever touches requests to *.globaldigits.shop subdomains; every
// other hostname (globaldigits.shop, www.globaldigits.shop, vercel preview
// URLs, localhost) falls straight through to next() and is served exactly as
// before — main site, admin panel and everything else are untouched.

const RESERVED_SUBDOMAINS = new Set(['www', 'reseller', 'admin']);

export default function middleware(request) {
  const hostHeader = request.headers.get('host') || '';
  const hostname = hostHeader.split(':')[0].toLowerCase();

  const match = hostname.match(/^([a-z0-9-]+)\.globaldigits\.shop$/);
  if (!match || RESERVED_SUBDOMAINS.has(match[1])) {
    return next();
  }

  const subdomain = match[1];
  const url = new URL(request.url);

  // Every path on a reseller subdomain — "/", "/checkout", trailing slashes,
  // whatever — loads reseller.html with ?store=<subdomain> appended (kept
  // alongside any existing query params). reseller.html itself already knows
  // how to read this and load the matching storefront from Supabase.
  const target = new URL('/reseller.html', url);
  target.search = url.search;
  target.searchParams.set('store', subdomain);

  return rewrite(target);
}

export const config = {
  matcher: '/:path*',
};
