import type { ProbeOverrides, ProbesConfig } from '../config/schema.ts';

export interface ResolvedProbeConfig {
	timeoutMs: number;
	impersonationProfile: string;
	bodySnippetCapBytes: number;
}

/** Resolve the effective probe settings for one target: start from
 *  [probes] defaults (strip the `default_` prefix), overlay the target's
 *  probe_overrides (un-prefixed keys) where present. */
export function mergeProbeConfig(
	probes: ProbesConfig,
	overrides: ProbeOverrides | undefined,
): ResolvedProbeConfig {
	return {
		timeoutMs: overrides?.timeout_ms ?? probes.default_timeout_ms,
		impersonationProfile:
			overrides?.impersonation_profile ?? probes.default_impersonation_profile,
		bodySnippetCapBytes:
			overrides?.body_snippet_cap_bytes ?? probes.default_body_snippet_cap_bytes,
	};
}
