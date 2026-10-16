import { describe, expect, test } from 'vitest';

import { detectShapeSignals } from './shape.ts';

const NO_PHRASES = { unavailability_phrases: [] };

describe('detectShapeSignals', () => {
	test('empty body -> is_empty_or_minimal_html true, everything else false/empty', () => {
		const got = detectShapeSignals('', 0, NO_PHRASES);
		expect(got).toEqual({
			is_empty_or_minimal_html: true,
			has_meta_refresh: false,
			meta_refresh_target: null,
			has_js_redirect: false,
			js_redirect_target: null,
			has_noscript_tag: false,
			noscript_text_snippet: null,
			unavailability_phrases_matched: [],
		});
	});

	test('minimal HTML shell (<~500 bytes of text after tag-stripping) -> is_empty_or_minimal_html true', () => {
		const html = '<html><body><div id="root"></div></body></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.is_empty_or_minimal_html).toBe(true);
	});

	test('rich page with >~500 bytes of text -> is_empty_or_minimal_html false', () => {
		const paragraph = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(15);
		const html = `<html><body><article>${paragraph}</article></body></html>`;
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.is_empty_or_minimal_html).toBe(false);
		expect(got.has_meta_refresh).toBe(false);
		expect(got.has_js_redirect).toBe(false);
		expect(got.has_noscript_tag).toBe(false);
		expect(got.unavailability_phrases_matched).toEqual([]);
	});

	test('multi-byte text is measured in bytes, not code units, against the ~500 threshold', () => {
		// Each of these characters is 3 UTF-8 bytes but 1 UTF-16 code unit.
		// 200 chars => 200 code units (< 500, would wrongly read "minimal" if
		// counted as chars) but 600 bytes (>= 500, correctly "not minimal").
		const cjk = '文'.repeat(200);
		const html = `<html><body><article>${cjk}</article></body></html>`;
		const got = detectShapeSignals(html, Buffer.byteLength(html, 'utf8'), NO_PHRASES);
		expect(got.is_empty_or_minimal_html).toBe(false);
	});

	test('meta-refresh tag -> has_meta_refresh true with extracted target', () => {
		const html =
			'<html><head><meta http-equiv="refresh" content="0;url=https://example.com/next"></head><body></body></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_meta_refresh).toBe(true);
		expect(got.meta_refresh_target).toBe('https://example.com/next');
	});

	test('meta-refresh with space after semicolon -> target still extracted', () => {
		const html =
			'<html><head><meta http-equiv="refresh" content="5; url=/relative/path"></head></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_meta_refresh).toBe(true);
		expect(got.meta_refresh_target).toBe('/relative/path');
	});

	test('window.location assignment -> has_js_redirect true with static target', () => {
		const html =
			'<html><script>window.location = "https://example.com/redirected";</script></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_js_redirect).toBe(true);
		expect(got.js_redirect_target).toBe('https://example.com/redirected');
	});

	test('window.location.href assignment -> has_js_redirect true with static target', () => {
		const html =
			"<html><script>window.location.href = 'https://example.com/other';</script></html>";
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_js_redirect).toBe(true);
		expect(got.js_redirect_target).toBe('https://example.com/other');
	});

	test('window.location.replace(...) -> has_js_redirect true with static target', () => {
		const html =
			'<html><script>window.location.replace("https://example.com/replaced");</script></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_js_redirect).toBe(true);
		expect(got.js_redirect_target).toBe('https://example.com/replaced');
	});

	test('dynamic js redirect target -> has_js_redirect true but target null', () => {
		const html = '<html><script>window.location = someVariable;</script></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_js_redirect).toBe(true);
		expect(got.js_redirect_target).toBeNull();
	});

	test('noscript block -> has_noscript_tag true with tag-stripped snippet', () => {
		const html =
			'<html><body><noscript>Please enable JavaScript to continue</noscript></body></html>';
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_noscript_tag).toBe(true);
		expect(got.noscript_text_snippet).toBe('Please enable JavaScript to continue');
	});

	test('noscript block longer than ~200 chars -> snippet capped', () => {
		const longText = 'x'.repeat(300);
		const html = `<html><noscript>${longText}</noscript></html>`;
		const got = detectShapeSignals(html, html.length, NO_PHRASES);
		expect(got.has_noscript_tag).toBe(true);
		expect(got.noscript_text_snippet?.length).toBeLessThanOrEqual(200);
	});

	test('body containing a configured unavailability phrase -> matched case-insensitively', () => {
		const html =
			'<html><body><p>This content is UNAVAILABLE IN YOUR REGION at this time.</p></body></html>';
		const got = detectShapeSignals(html, html.length, {
			unavailability_phrases: ['unavailable in your region', 'blocked'],
		});
		expect(got.unavailability_phrases_matched).toEqual(['unavailable in your region']);
	});

	test('multiple configured phrases matched', () => {
		const html =
			'<html><body>Access Denied. This service is unavailable in your region.</body></html>';
		const got = detectShapeSignals(html, html.length, {
			unavailability_phrases: ['Access Denied', 'unavailable in your region', 'not present'],
		});
		expect(got.unavailability_phrases_matched).toEqual([
			'Access Denied',
			'unavailable in your region',
		]);
	});

	test('normal rich page with no phrases configured -> unavailability_phrases_matched empty', () => {
		const paragraph = 'Everything is working as expected on this website. '.repeat(15);
		const html = `<html><body>${paragraph}</body></html>`;
		const got = detectShapeSignals(html, html.length, {
			unavailability_phrases: ['blocked', 'service unavailable'],
		});
		expect(got.unavailability_phrases_matched).toEqual([]);
		expect(got.has_meta_refresh).toBe(false);
		expect(got.has_js_redirect).toBe(false);
		expect(got.has_noscript_tag).toBe(false);
		expect(got.is_empty_or_minimal_html).toBe(false);
	});
});
