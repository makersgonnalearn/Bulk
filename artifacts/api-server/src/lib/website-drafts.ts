import { createHash, timingSafeEqual } from "node:crypto";

// The MGL website pulls queued designs from Bulk (its host blocks inbound
// calls from cloud servers), so Bulk only needs the shared pull key.
export function getWebsitePullKey(): string | null {
  const key = process.env.MGL_WP_PULL_KEY?.trim();
  return key && key.length >= 32 ? key : null;
}

export function websiteDraftsEnabled(): boolean {
  return getWebsitePullKey() !== null;
}

export function isValidPullKey(candidate: string | undefined): boolean {
  const key = getWebsitePullKey();
  if (!key || !candidate) return false;
  const expected = createHash("sha256").update(key).digest();
  const actual = createHash("sha256").update(candidate.trim()).digest();
  return timingSafeEqual(expected, actual);
}

// "watercolor-fall-wreath-2" -> "Watercolor Fall Wreath 2"
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
