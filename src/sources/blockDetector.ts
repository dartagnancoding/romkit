/**
 * Recognizes pages that mean "stop here": captchas, anti-bot challenges, access
 * denied or simply a page that is not what we expected.
 *
 * Detection only. romkit never tries to solve or get around these pages; the
 * caller stops and shows the URL so the user can continue in a browser.
 */

import type { FetchedPage } from "./httpClient";
import type { BlockedOutcome } from "./sourceAdapter";

/**
 * Text fragments typical of captcha/anti-bot pages. They are only checked when
 * the expected content is missing: a normal page may contain e.g. a reCAPTCHA
 * script for its comment form without blocking anything.
 */
const CHALLENGE_MARKERS: { pattern: RegExp; label: string }[] = [
  { pattern: /cf-chl|challenge-platform|cf_chl_opt|just a moment\.\.\./i, label: "Cloudflare challenge" },
  { pattern: /g-recaptcha|recaptcha\/api/i, label: "reCAPTCHA" },
  { pattern: /hcaptcha\.com|h-captcha/i, label: "hCaptcha" },
  { pattern: /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i, label: "Cloudflare Turnstile" },
  { pattern: /ddos-guard/i, label: "DDoS-Guard" },
  { pattern: /verify (that )?you are (a )?human|are you a robot|captcha/i, label: "captcha" },
];

export function findChallengeMarker(html: string): string | null {
  return CHALLENGE_MARKERS.find((marker) => marker.pattern.test(html))?.label ?? null;
}

export function blockedOutcome(reason: BlockedOutcome["reason"], detail: string, pageUrl: string): BlockedOutcome {
  return { kind: "blocked", reason, detail, pageUrl };
}

/**
 * Checks the HTTP status. 403/429/503 are what anti-bot layers usually answer
 * with; any other non-2xx status is reported as an unexpected page.
 */
export function detectHttpProblem(page: FetchedPage): BlockedOutcome | null {
  if (page.status >= 200 && page.status < 300) return null;

  if (page.status === 403 || page.status === 429 || page.status === 503) {
    const marker = findChallengeMarker(page.body);
    const detail = marker ? `HTTP ${page.status} (${marker})` : `HTTP ${page.status}`;
    return blockedOutcome(marker ? "captcha" : "http-status", detail, page.finalUrl);
  }
  return blockedOutcome("unexpected-page", `HTTP ${page.status}`, page.finalUrl);
}

/** Used when the expected element was not found: either a challenge page or a changed layout. */
export function explainMissingContent(page: FetchedPage, missingWhat: string): BlockedOutcome {
  const marker = findChallengeMarker(page.body);
  if (marker) return blockedOutcome("captcha", `${marker} detected`, page.finalUrl);
  return blockedOutcome("unexpected-page", missingWhat, page.finalUrl);
}
