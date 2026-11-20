const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * The visitor's real IP, so the API's per-IP rate limits apply per visitor (not to this server).
 * Prefer headers the edge sets itself and a client cannot forge (Cloudflare / Render), then the
 * first X-Forwarded-For entry. Safe for the middleware (no Node-only imports).
 */
export function clientIpOf(h: Headers): string | null {
  const candidates = [h.get("cf-connecting-ip"), h.get("true-client-ip"), h.get("x-real-ip"),
    (h.get("x-forwarded-for") || "").split(",")[0]];
  for (const c of candidates) {
    const v = (c || "").trim();
    if (v && IP_RE.test(v)) return v;
  }
  return null;
}
