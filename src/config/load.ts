import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { DEFAULT_CONFIG } from './defaults.ts';
import { deepMerge } from './merge.ts';
import { type AppConfig, appConfigSchema } from './schema.ts';

const KNOWN_SECTIONS = ['metrics', 'storage', 'scheduler', 'probes', 'paths', 'targets'] as const;

function tryRead(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch (err) {
		// A missing layer file is expected (skip it); any other I/O error
		// (e.g. EACCES on an existing file) must surface, not fall back to defaults.
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		return undefined;
	}
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (key in source) out[key] = source[key];
	}
	return out;
}

function finalizeConfig(config: AppConfig): AppConfig {
	if (config.paths.length === 0) {
		console.warn('config: empty paths list');
	} else if (!config.paths.some((path) => path.role === 'direct')) {
		// A non-empty list with no direct path loses the direct baseline the
		// comparison model needs (CONFIG_FILE.md: "zero direct paths emits a
		// warning at startup"). Distinct from the empty-list case above.
		console.warn('config: no direct path');
	}

	const pathNames = new Set<string>();
	for (const path of config.paths) {
		if (pathNames.has(path.name)) {
			throw new Error(`config: duplicate path name "${path.name}"`);
		}
		pathNames.add(path.name);
	}

	const targetNames = new Set<string>();
	for (const target of config.targets) {
		if (targetNames.has(target.name)) {
			throw new Error(`config: duplicate target name "${target.name}"`);
		}
		targetNames.add(target.name);

		if (target.check_types.length === 0) {
			console.warn(`config: target "${target.name}" has an empty check_types list`);
		}
	}

	const enabledTargetCount = config.targets.filter((target) => target.enabled).length;
	if (enabledTargetCount === 0) {
		console.warn('config: zero enabled targets');
	}

	return config;
}

export function loadConfig(opts?: { configDir?: string; env?: string }): AppConfig {
	const dir = opts?.configDir ?? './config';
	const env = opts?.env ?? process.env.NODE_ENV ?? 'development';

	let merged: Record<string, unknown> = structuredClone(DEFAULT_CONFIG);
	for (const file of ['default.toml', `${env}.toml`, 'local.toml']) {
		const text = tryRead(join(dir, file));
		if (text) merged = deepMerge(merged, parseToml(text));
	}

	const known = pick(merged, KNOWN_SECTIONS);
	const config = appConfigSchema.parse(known);
	return finalizeConfig(config);
}
