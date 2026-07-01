import type { ProbeInsert, ProbePayload } from '../probe/types.ts';

/** First non-null per-op `failure`, walked per STORAGE_SCHEMA.md. For
 *  http_get: for each hop in data.hops, in order [dns, tcp.status, tls,
 *  http.request, http.response, body], return the first `failure`; else null.
 *  Null-safe: any sub-op block (or hops itself) may be absent.
 *  Invariant: reached_stage === 'complete' ⇔ first_failure_code IS NULL. */
export function deriveFirstFailureCode(payload: ProbePayload): string | null {
	for (const hop of payload.data.hops ?? []) {
		const ops: (string | null | undefined)[] = [
			hop.dns?.failure,
			hop.tcp?.status.failure,
			hop.tls?.failure,
			hop.http?.request?.failure,
			hop.http?.response?.failure,
			hop.body?.failure,
		];
		for (const failure of ops) {
			if (failure != null) return failure;
		}
	}
	return null;
}

/** Flatten a payload + the target name into the insertable `probes` row.
 *  target_name from the sweep; path_name/path_role from payload.path;
 *  started_at/runtime_ms/check_type from the envelope; reached_stage from
 *  data.reached_stage; first_failure_code via deriveFirstFailureCode;
 *  final_status_code from data.rollup.final_status_code;
 *  impersonation_profile from data.config.impersonation_profile;
 *  payload = JSON.stringify(payload). */
export function deriveProbeColumns(args: {
	targetName: string;
	payload: ProbePayload;
}): ProbeInsert {
	const { targetName, payload } = args;
	return {
		target_name: targetName,
		path_name: payload.path.name,
		path_role: payload.path.role,
		check_type: payload.check_type,
		started_at: payload.started_at,
		runtime_ms: payload.runtime_ms,
		reached_stage: payload.data.reached_stage,
		first_failure_code: deriveFirstFailureCode(payload),
		final_status_code: payload.data.rollup?.final_status_code ?? null,
		impersonation_profile: payload.data.config?.impersonation_profile ?? null,
		payload: JSON.stringify(payload),
	};
}
