type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects deep-merge; arrays and scalars REPLACE (node-config array semantics). */
export function deepMerge<T extends Plain>(base: T, override: Plain): T {
	const out: Plain = { ...base };
	for (const [k, v] of Object.entries(override)) {
		const cur = out[k];
		out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
	}
	return out as T;
}
