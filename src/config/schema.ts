import { z } from 'zod';

// Section schemas are LENIENT (loose objects): they type only the keys M1
// consumes and tolerate the other keys documented in CONFIG_FILE.md (e.g.
// [metrics].log_level, [probes].default_follow_redirects, [[paths]].tags,
// [[targets]].label) so a spec-compliant config file loads without error.

export const metricsSchema = z
	.looseObject({
		host: z.string(),
		port: z.int().min(1).max(65535),
		path: z.string().startsWith('/'),
	})
	.default({ host: '127.0.0.1', port: 9974, path: '/metrics' });

export const storageSchema = z
	.looseObject({
		db_path: z.string().min(1),
		retention_days: z.int().min(1),
	})
	.default({ db_path: './data/probes.db', retention_days: 30 });

export const schedulerSchema = z
	.looseObject({
		http_get_cadence_seconds: z.int().min(1),
		dns_lookup_cadence_seconds: z.int().min(1),
		tcp_connect_cadence_seconds: z.int().min(1),
	})
	.default({
		http_get_cadence_seconds: 900,
		dns_lookup_cadence_seconds: 300,
		tcp_connect_cadence_seconds: 300,
	});

export const shapeDetectionSchema = z
	.looseObject({
		unavailability_phrases: z.array(z.string()),
	})
	.default({ unavailability_phrases: [] });

export const probesSchema = z
	.looseObject({
		default_timeout_ms: z.int().min(1),
		default_impersonation_profile: z.string().min(1),
		default_body_snippet_cap_bytes: z.int().min(0),
		shape_detection: shapeDetectionSchema,
	})
	.default({
		default_timeout_ms: 10000,
		default_impersonation_profile: 'chromium-latest',
		default_body_snippet_cap_bytes: 32768,
		shape_detection: { unavailability_phrases: [] },
	});

export const pathRoleSchema = z.enum(['direct', 'vantage', 'obfuscation']);

export const pathSchema = z
	.looseObject({
		name: z.string().min(1),
		role: pathRoleSchema,
		proxy_url: z.url().optional(),
	})
	.superRefine((path, ctx) => {
		if (path.role === 'direct' && path.proxy_url !== undefined) {
			ctx.addIssue({
				code: 'custom',
				message: 'path with role "direct" must not set proxy_url',
				path: ['proxy_url'],
			});
		}
		if (path.role !== 'direct' && path.proxy_url === undefined) {
			ctx.addIssue({
				code: 'custom',
				message: `path with role "${path.role}" requires proxy_url`,
				path: ['proxy_url'],
			});
		}
	});

export const checkTypeSchema = z.enum(['http_get', 'dns_lookup', 'tcp_connect']);

// Loose record of un-prefixed probe-override keys (timeout_ms,
// impersonation_profile, body_snippet_cap_bytes, ...); merged over the
// [probes] defaults at dispatch time in a later milestone.
export const probeOverridesSchema = z.looseObject({
	timeout_ms: z.int().min(1).optional(),
	impersonation_profile: z.string().min(1).optional(),
	body_snippet_cap_bytes: z.int().min(0).optional(),
});

export const targetSchema = z.looseObject({
	name: z.string().min(1),
	url: z.url(),
	enabled: z.boolean().default(true),
	check_types: z.array(checkTypeSchema).default(['http_get']),
	probe_overrides: probeOverridesSchema.optional(),
});

// Strict on the TOP-LEVEL section set: callers must pre-filter the merged
// object to KNOWN_SECTIONS (as loadConfig's pick() does) or this rejects
// unknown top-level sections (e.g. [rules]). Section schemas themselves are lenient.
export const appConfigSchema = z.strictObject({
	metrics: metricsSchema,
	storage: storageSchema,
	scheduler: schedulerSchema,
	probes: probesSchema,
	paths: z.array(pathSchema),
	targets: z.array(targetSchema),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ProbesConfig = z.infer<typeof probesSchema>;
export type ProbeOverrides = z.infer<typeof probeOverridesSchema>;
