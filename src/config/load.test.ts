import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from './load.ts';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'nba-config-test-'));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

async function writeToml(name: string, contents: string): Promise<void> {
	await writeFile(join(tmpDir, name), contents, 'utf8');
}

describe('loadConfig', () => {
	test('falls back to DEFAULT_CONFIG when no config files exist', () => {
		const config = loadConfig({ configDir: tmpDir, env: 'test' });
		expect(config.metrics).toEqual({ host: '127.0.0.1', port: 9974, path: '/metrics' });
		expect(config.storage).toEqual({ db_path: './data/probes.db', retention_days: 30 });
		expect(config.scheduler).toEqual({
			http_get_cadence_seconds: 900,
			dns_lookup_cadence_seconds: 300,
			tcp_connect_cadence_seconds: 300,
		});
		// DEFAULT_CONFIG ships one direct path and no targets.
		expect(config.paths).toEqual([{ name: 'direct', role: 'direct' }]);
		expect(config.targets).toEqual([]);
	});

	test('default.toml overrides DEFAULT_CONFIG values', async () => {
		await writeToml(
			'default.toml',
			`
[metrics]
port = 8888
`,
		);
		const config = loadConfig({ configDir: tmpDir, env: 'test' });
		expect(config.metrics.port).toBe(8888);
		expect(config.metrics.host).toBe('127.0.0.1');
	});

	test('<NODE_ENV>.toml layers on top of default.toml', async () => {
		await writeToml(
			'default.toml',
			`
[metrics]
port = 8888
`,
		);
		await writeToml(
			'test.toml',
			`
[metrics]
port = 7777
`,
		);
		const config = loadConfig({ configDir: tmpDir, env: 'test' });
		expect(config.metrics.port).toBe(7777);
	});

	test('local.toml wins over default and env layers', async () => {
		await writeToml(
			'default.toml',
			`
[metrics]
port = 8888
`,
		);
		await writeToml(
			'test.toml',
			`
[metrics]
port = 7777
`,
		);
		await writeToml(
			'local.toml',
			`
[metrics]
port = 6666
`,
		);
		const config = loadConfig({ configDir: tmpDir, env: 'test' });
		expect(config.metrics.port).toBe(6666);
	});

	test('only loads the env file matching the requested env', async () => {
		await writeToml(
			'production.toml',
			`
[metrics]
port = 1111
`,
		);
		const config = loadConfig({ configDir: tmpDir, env: 'test' });
		expect(config.metrics.port).toBe(9974);
	});

	test('strips unknown top-level sections (e.g. [rules]) before validation', async () => {
		await writeToml(
			'local.toml',
			`
[rules.tls_handshake_hang]
min_consecutive = 5
`,
		);
		expect(() => loadConfig({ configDir: tmpDir, env: 'test' })).not.toThrow();
	});

	test('arrays replace wholesale across layers (paths/targets do not merge)', async () => {
		await writeToml(
			'default.toml',
			`
[[paths]]
name = "direct"
role = "direct"
`,
		);
		await writeToml(
			'local.toml',
			`
[[paths]]
name = "corp-vantage"
role = "vantage"
proxy_url = "socks5h://localhost:10801"
`,
		);
		const config = loadConfig({ configDir: tmpDir, env: 'test' });
		expect(config.paths).toEqual([
			{ name: 'corp-vantage', role: 'vantage', proxy_url: 'socks5h://localhost:10801' },
		]);
	});

	test('throws fatally on duplicate path names', async () => {
		await writeToml(
			'local.toml',
			`
[[paths]]
name = "direct"
role = "direct"

[[paths]]
name = "direct"
role = "vantage"
proxy_url = "socks5h://localhost:10801"
`,
		);
		expect(() => loadConfig({ configDir: tmpDir, env: 'test' })).toThrow();
	});

	test('throws fatally on duplicate target names', async () => {
		await writeToml(
			'local.toml',
			`
[[targets]]
name = "rutracker"
url = "https://rutracker.org/"

[[targets]]
name = "rutracker"
url = "https://rutracker.org/other"
`,
		);
		expect(() => loadConfig({ configDir: tmpDir, env: 'test' })).toThrow();
	});

	test('warns when there are zero enabled targets', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await writeToml(
			'local.toml',
			`
[[targets]]
name = "rutracker"
url = "https://rutracker.org/"
enabled = false
`,
		);
		loadConfig({ configDir: tmpDir, env: 'test' });
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('warns when a target has an empty check_types list', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await writeToml(
			'local.toml',
			`
[[targets]]
name = "rutracker"
url = "https://rutracker.org/"
check_types = []
`,
		);
		loadConfig({ configDir: tmpDir, env: 'test' });
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('warns when the merged paths list is empty', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// An inline empty array replaces DEFAULT_CONFIG's direct path wholesale.
		await writeToml('local.toml', `paths = []\n`);
		loadConfig({ configDir: tmpDir, env: 'test' });
		expect(warnSpy).toHaveBeenCalledWith('config: empty paths list');
		warnSpy.mockRestore();
	});

	test('warns when the merged (non-empty) paths list has no direct path', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		// Vantage-only list replaces DEFAULT_CONFIG's direct path — no direct baseline.
		await writeToml(
			'local.toml',
			`
[[paths]]
name = "corp-vantage"
role = "vantage"
proxy_url = "socks5h://localhost:10801"

[[targets]]
name = "rutracker"
url = "https://rutracker.org/"
`,
		);
		loadConfig({ configDir: tmpDir, env: 'test' });
		expect(warnSpy).toHaveBeenCalledWith('config: no direct path');
		warnSpy.mockRestore();
	});

	test('does not emit the no-direct-path warning when a direct path is present', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await writeToml(
			'local.toml',
			`
[[paths]]
name = "direct"
role = "direct"

[[paths]]
name = "corp-vantage"
role = "vantage"
proxy_url = "socks5h://localhost:10801"

[[targets]]
name = "rutracker"
url = "https://rutracker.org/"
`,
		);
		loadConfig({ configDir: tmpDir, env: 'test' });
		expect(warnSpy).not.toHaveBeenCalledWith('config: no direct path');
		warnSpy.mockRestore();
	});

	test('does not warn when at least one target is enabled with check types', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await writeToml(
			'local.toml',
			`
[[targets]]
name = "rutracker"
url = "https://rutracker.org/"
`,
		);
		loadConfig({ configDir: tmpDir, env: 'test' });
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('throws fatally when merged config fails schema validation', async () => {
		await writeToml(
			'local.toml',
			`
[metrics]
port = 999999
`,
		);
		expect(() => loadConfig({ configDir: tmpDir, env: 'test' })).toThrow();
	});

	test('surfaces a non-ENOENT read error rather than silently using defaults', async () => {
		// A layer path that exists but is not a readable file (a directory) makes
		// readFileSync throw EISDIR, not ENOENT — that must propagate, not be swallowed.
		await mkdir(join(tmpDir, 'local.toml'));
		expect(() => loadConfig({ configDir: tmpDir, env: 'test' })).toThrow();
	});
});
