/**
 * Groq bridge stub for Minecraft Windows / client worlds.
 *
 * @minecraft/server-net is BDS-only. Importing it crashes the whole pack on
 * Windows Bedrock client ("depends on unknown module @minecraft/server-net").
 *
 * Chat falls back to keyword brain in verity_ai.js.
 * Real STT + LLM: run python mc_bridge.py then /connect 127.0.0.1:3000.
 */

/**
 * @param {import("@minecraft/server").Player} _player
 * @param {string} _message
 * @param {Record<string, unknown>} [_extraCtx]
 * @returns {Promise<string | null>}
 */
export async function askVerityGroq(_player, _message, _extraCtx = {}) {
	console.warn(
		"verity groq: HTTP disabled on this client (@minecraft/server-net is BDS-only). Using keyword fallback.",
	);
	return null;
}

/**
 * @param {import("@minecraft/server").Player} _player
 * @returns {Promise<{ user: string, ai: string } | { error: string }>}
 */
export async function listenVerityGroq(_player) {
	return {
		error:
			"Voice AI needs the Python bridge. On Windows run: python mc_bridge.py then /connect 127.0.0.1:3000",
	};
}
