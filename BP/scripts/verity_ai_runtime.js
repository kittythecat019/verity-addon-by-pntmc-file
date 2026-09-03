/**
 * AI-era runtime — Groq (Python bridge) owns language and conversation.
 *
 * Old locale tables + /pntmc:verity_language were for offline canned chat.
 * They do not run on the live AI path.
 *
 * Addon still detects in-game ACTIONS (follow, locate, drop, music, story)
 * via regex in verity_intent.js. Everything else is a world fact + Groq.
 */

/**
 * Pack voice lines stay English. Chat language is chosen by Groq from speech.
 * @returns {string}
 */
export function getVerityLanguage() {
	return "english";
}

/**
 * @param {string} [_language]
 * @returns {string}
 */
export function setVerityLanguage(_language) {
	return "english";
}

/**
 * Never gate player chat on English — Groq already mirrors any language.
 * @returns {boolean}
 */
export function isEnglishLanguage() {
	return false;
}

/**
 * Identity — do not rewrite player chat through locale phrase maps.
 * @param {string} text
 * @returns {string}
 */
export function translateVerityInput(text) {
	return String(text ?? "");
}

/**
 * Identity — do not rewrite Groq / addon lines through locale maps.
 * @param {string} text
 * @returns {string}
 */
export function translateVerityOutput(text) {
	return String(text ?? "");
}

/** Removed: Groq mirrors the player's language. */
export function registerLanguageCommand() {}

export const VERITY_LANGUAGE_PROP = "pntmc:verity_language";
export const VERITY_LANGUAGES = ["english"];

/**
 * Live biome id/name from the world — no locale lookup.
 * @param {import("@minecraft/server").Player} player
 * @returns {string}
 */
export function readStandingBiome(player) {
	const loc = player.location;
	const sample = {
		x: Math.floor(loc.x),
		y: Math.floor(loc.y),
		z: Math.floor(loc.z),
	};
	const raw = player.dimension.getBiome(sample);
	const biomeId =
		typeof raw === "string" ? raw : raw?.id ?? String(raw);
	const part = String(biomeId).split(":").pop() ?? String(biomeId);
	const pretty = part
		.split("_")
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(" ");
	console.warn(`verity biome read @${sample.x},${sample.y},${sample.z} → ${biomeId}`);
	return pretty;
}
