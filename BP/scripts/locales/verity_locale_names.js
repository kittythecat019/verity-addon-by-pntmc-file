/**
 * Proper names — never translate. Preserve exact spelling in input + output.
 * Verity / addon cast plus well-known Minecraft names (Herobrine, Notch, …).
 */

/** @type {{ canonical: string, source: RegExp, mangled?: RegExp }[]} */
const CORE_NAME_GUARDS = [
	{ canonical: "ThatMob", source: /\bThatMob\b/i, mangled: /\b(?:that\s*mob|dat\s*mob|ese\s*mob)\b/gi },
	{ canonical: "PnTMC", source: /\bPnTMC\b/i, mangled: /\bpntmc\b/gi },
	{ canonical: "Verity", source: /\bVerity\b/i, mangled: /\bverity\b/gi },
	{ canonical: "Mob...", source: /\bMob\.\.\./, mangled: /\b(?:mob\s*\.{2,}|моб\s*\.{2,}|mób\s*\.{2,})\b/gi },
	{ canonical: "Mob", source: /\bMob\b/, mangled: /\b(?:моб|mób)\b/gi },
];

/** Minecraft / Mojang names that must stay in Latin spelling. */
const MINECRAFT_NAME_GUARDS = [
	{ canonical: "Herobrine", source: /\bHerobrine\b/i, mangled: /\b(?:херобр(?:айн|ин|айна)|herobrina)\b/gi },
	{ canonical: "Notch", source: /\bNotch\b/i },
	{ canonical: "Mojang", source: /\bMojang\b/i },
	{ canonical: "Minecraft", source: /\bMinecraft\b/i },
	{ canonical: "Microsoft", source: /\bMicrosoft\b/i },
	{ canonical: "Dinnerbone", source: /\bDinnerbone\b/i },
	{ canonical: "jeb_", source: /\bjeb_\b/i },
	{ canonical: "Bedrock", source: /\bBedrock\b/i },
	{ canonical: "Nether", source: /\bNether\b/i },
	{ canonical: "End", source: /\bEnd\b/i },
];

const NAME_GUARDS = [...CORE_NAME_GUARDS, ...MINECRAFT_NAME_GUARDS];

/** Mask proper names before locale folding. Longer / more specific patterns first. */
const INPUT_MASK_ORDER = [
	/\bThatMob\b/gi,
	/\bthat\s*mob\b/gi,
	/\bPnTMC\b/gi,
	/\bpntmc\b/gi,
	/\bMob\.\.\./g,
	/\bHerobrine\b/gi,
	/\bDinnerbone\b/gi,
	/\bMinecraft\b/gi,
	/\bMicrosoft\b/gi,
	/\bMojang\b/gi,
	/\bBedrock\b/gi,
	/\bNether\b/gi,
	/\bNotch\b/gi,
	/\bjeb_\b/gi,
	/\bMob\b/g,
	/\bEnd\b/g,
	/\bVerity\b/gi,
	/\bverity\b/gi,
];

/** @type {Map<string, string>} */
const INPUT_CANONICAL = new Map(
	NAME_GUARDS.map((guard) => [guard.canonical.toLowerCase(), guard.canonical]),
);
INPUT_CANONICAL.set("jeb_", "jeb_");
INPUT_CANONICAL.set("mob...", "Mob...");
INPUT_CANONICAL.set("mob", "Mob");
INPUT_CANONICAL.set("thatmob", "ThatMob");
INPUT_CANONICAL.set("pntmc", "PnTMC");
INPUT_CANONICAL.set("verity", "Verity");

/**
 * @param {string} match
 */
function canonicalizeInputName(match) {
	const key = match.replace(/\s+/g, "").toLowerCase();
	if (key === "thatmob") return "ThatMob";
	if (match.includes("...")) return "Mob...";
	return INPUT_CANONICAL.get(key) ?? INPUT_CANONICAL.get(match.toLowerCase()) ?? match;
}

/**
 * @param {string} value
 * @returns {{ text: string, restore: (result: string) => string }}
 */
export function protectProperNames(value) {
	const tokens = [];
	let text = value;
	for (const pattern of INPUT_MASK_ORDER) {
		text = text.replace(pattern, (match) => {
			const marker = `__PN${tokens.length}__`;
			tokens.push(canonicalizeInputName(match));
			return marker;
		});
	}
	return {
		text,
		restore: (result) =>
			result.replace(/\b__PN(\d+)__\b/gi, (_, index) => tokens[Number(index)] ?? _),
	};
}

/**
 * After translation, put back any proper name the English source had.
 * @param {string} englishSource
 * @param {string} translated
 * @returns {string}
 */
export function enforceProperNamesInOutput(englishSource, translated) {
	if (typeof englishSource !== "string" || typeof translated !== "string") return translated;
	if (!englishSource || englishSource === translated) return translated;

	let out = translated;
	for (const guard of NAME_GUARDS) {
		if (!guard.source.test(englishSource)) continue;
		if (guard.source.test(out)) continue;
		if (guard.mangled) out = out.replace(guard.mangled, guard.canonical);
	}
	return out;
}
