import type { BodyShapeSignals } from './types.ts';

export type ShapeSignals = Required<BodyShapeSignals>;

export interface ShapeDetectionConfig {
	unavailability_phrases: string[];
}

// PROBE_PAYLOAD.md "Body shape signals" — "less than roughly 500 bytes of
// text after tag stripping" is called out explicitly as a module constant,
// not config.
const MINIMAL_HTML_TEXT_BYTE_THRESHOLD = 500;

// PROBE_PAYLOAD.md caps the noscript snippet at "up to 200 chars".
const NOSCRIPT_SNIPPET_MAX_CHARS = 200;

/** Strip HTML tags and collapse whitespace, for both the minimal-html-text
 *  measurement and the noscript snippet extraction. Conservative: this is a
 *  detector, not a renderer — no entity decoding, no DOM. */
function stripTags(fragment: string): string {
	return fragment
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractTagContent(html: string, tagName: string): string | null {
	const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i').exec(html);
	return match?.[1] ?? null;
}

function detectMetaRefresh(html: string): { has: boolean; target: string | null } {
	const metaMatch =
		/<meta\s+[^>]*http-equiv\s*=\s*["']refresh["'][^>]*>/i.exec(html) ??
		/<meta\s+[^>]*content\s*=\s*["'][^"']*url=[^"']*["'][^>]*http-equiv\s*=\s*["']refresh["'][^>]*>/i.exec(
			html,
		);
	if (!metaMatch) return { has: false, target: null };

	const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(metaMatch[0]);
	const content = contentMatch?.[1] ?? '';
	const targetMatch = /url\s*=\s*(.+)$/i.exec(content);
	const target = targetMatch?.[1]?.trim() ?? null;
	return { has: true, target: target !== null && target.length > 0 ? target : null };
}

// Common JS redirect patterns per PROBE_PAYLOAD.md: `window.location = …`,
// `window.location.href = …`, `window.location.replace(…)`. Target is
// extracted only when it's a static string literal; a bare identifier
// (dynamic target) yields has_js_redirect: true, target: null.
const JS_REDIRECT_PATTERNS = [
	/window\.location\s*=\s*(['"])(.*?)\1/,
	/window\.location\.href\s*=\s*(['"])(.*?)\1/,
	/window\.location\.replace\s*\(\s*(['"])(.*?)\1\s*\)/,
];

const JS_REDIRECT_PRESENCE_PATTERN =
	/window\.location(?:\.href)?\s*=\s*[^=]|window\.location\.replace\s*\(/;

function detectJsRedirect(html: string): { has: boolean; target: string | null } {
	if (!JS_REDIRECT_PRESENCE_PATTERN.test(html)) return { has: false, target: null };

	for (const pattern of JS_REDIRECT_PATTERNS) {
		const match = pattern.exec(html);
		if (match) {
			return { has: true, target: match[2] ?? null };
		}
	}
	// Present but not a static string literal (e.g. assigned from a variable).
	return { has: true, target: null };
}

function detectNoscript(html: string): { has: boolean; snippet: string | null } {
	const raw = extractTagContent(html, 'noscript');
	if (raw === null) return { has: false, snippet: null };

	const text = stripTags(raw);
	if (text.length === 0) return { has: true, snippet: null };

	return { has: true, snippet: text.slice(0, NOSCRIPT_SNIPPET_MAX_CHARS) };
}

function matchUnavailabilityPhrases(html: string, phrases: string[]): string[] {
	const haystack = html.toLowerCase();
	return phrases.filter((phrase) => haystack.includes(phrase.toLowerCase()));
}

/** Precompute `body.shape_signals` (PROBE_PAYLOAD.md "Body shape signals")
 *  from a response body. Pure, deterministic, no network. Detection is
 *  conservative by design: false positives are worse than false negatives. */
export function detectShapeSignals(
	html: string,
	byteLen: number,
	cfg: ShapeDetectionConfig,
): ShapeSignals {
	const text = stripTags(html);
	// Threshold is in BYTES of tag-stripped text (PROBE_PAYLOAD.md), so
	// multi-byte scripts aren't undercounted by treating UTF-16 code units
	// as bytes. `byteLen === 0` covers a wholly empty body up front.
	const isEmptyOrMinimal =
		byteLen === 0 ||
		html.length === 0 ||
		Buffer.byteLength(text, 'utf8') < MINIMAL_HTML_TEXT_BYTE_THRESHOLD;

	const metaRefresh = detectMetaRefresh(html);
	const jsRedirect = detectJsRedirect(html);
	const noscript = detectNoscript(html);

	return {
		is_empty_or_minimal_html: isEmptyOrMinimal,
		has_meta_refresh: metaRefresh.has,
		meta_refresh_target: metaRefresh.target,
		has_js_redirect: jsRedirect.has,
		js_redirect_target: jsRedirect.target,
		has_noscript_tag: noscript.has,
		noscript_text_snippet: noscript.snippet,
		unavailability_phrases_matched: matchUnavailabilityPhrases(
			html,
			cfg.unavailability_phrases,
		),
	};
}
