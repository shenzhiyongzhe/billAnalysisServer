import type { Request } from 'express';

function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip) return null;

  // Remove IPv6-mapped IPv4 prefix
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  // Strip surrounding brackets from IPv6 literals like [::1]
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }

  // Drop optional port on IPv4 host:port (avoid breaking IPv6)
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.split(':')[0];
  }

  return ip || null;
}

/**
 * Resolve client IP from Express request.
 * Prefer X-Forwarded-For (first hop), then X-Real-IP, then req.ip / socket.
 */
export function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0];
    const ip = normalizeIp(first);
    if (ip) return ip;
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0].split(',')[0];
    const ip = normalizeIp(first);
    if (ip) return ip;
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string') {
    const ip = normalizeIp(realIp);
    if (ip) return ip;
  }

  const fallback =
    (req as Request & { ip?: string }).ip ||
    req.socket?.remoteAddress ||
    null;
  return normalizeIp(fallback);
}
