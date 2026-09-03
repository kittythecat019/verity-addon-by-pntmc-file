import {
	Player } from "@minecraft/server";
import {
	getOreHowToAnswer,
	PLAYER_SAVE,
	loadPlayerJson,
	savePlayerJson
} from "./verity_lib.js";

/** @typedef {{ structure: string, x: number, z: number, dir: string, blocks: number, precise: boolean }} LocateMemory */
/** @typedef {{ lastQuestion?: string, lastAnswer?: string, lastIntent?: string, lastBiome?: string, lastLocate?: LocateMemory, lastSound?: string, lastStructure?: string }} PlayerContext */

/** @type {Map<string, PlayerContext>} */
const playerContext = new Map();

const STOP_WORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"do", "does", "did", "have", "has", "had", "will", "would", "could",
	"should", "may", "might", "must", "shall", "can", "to", "of", "in",
	"for", "on", "with", "at", "by", "from", "up", "about", "into", "over",
	"after", "i", "me", "my", "you", "your", "we", "our", "they", "them",
	"it", "its", "this", "that", "these", "those", "please", "thanks", "thank",
	"verity", "hey", "uh", "um", "like", "just", "really", "actually",
]);

/** canonical token → extra tokens injected for matching */
const SYNONYM_EXPAND = {
	village: [
		"town", "settlement", "hamlet", "community", "civilization",
		"trader", "trading", "trade", "emerald", "golem",
		"blacksmith", "cleric", "farmer", "librarian", "butcher",
	],
	stronghold: ["end", "portal", "ender", "eye", "dragon", "silverfish"],
	mansion: ["evoker", "vindicator", "woodland", "illager"],
	monument: ["guardian", "prismarine", "elder", "underwater", "ocean temple"],
	shipwreck: ["wreck", "sunken", "boat", "treasure map"],
	mineshaft: ["mine", "rails", "cobweb", "abandoned mine"],
	ancient_city: ["warden", "sculk", "deep dark", "echo"],
	bastion_remnant: ["piglin", "nether gold", "remnant"],
	pillager_outpost: ["raid", "bad omen", "crossbow"],
	ruined_portal: ["obsidian", "crying obsidian", "broken portal"],
	buried_treasure: ["beach", "sand", "map", "chest"],
	end_city: ["shulker", "elytra", "purpur", "chorus"],
	fortress: ["blaze", "nether fortress", "rod"],
	temple: ["desert temple", "jungle temple", "pyramid", "trap"],
	trail_ruins: ["archaeology", "brush", "pottery", "sherd"],
	trial_chambers: ["trial", "breeze", "ominous", "vault"],
	cow: ["moo", "milk"],
	chicken: ["cluck", "egg", "poultry"],
	pig: ["oink", "pork"],
	sheep: ["baa", "wool"],
	cat: ["meow", "kitten"],
	dog: ["woof", "puppy"],
	wolf: ["woof", "pack"],
	creeper: ["ssss", "explode"],
	zombie: ["undead", "rotten"],
	skeleton: ["bones", "arrow", "bow"],
	biome: ["ecosystem", "environment", "terrain", "landscape", "climate"],
	diamond: ["deepest", "best layer"],
	iron: ["underground"],
	lava: ["danger", "burn"],
};

const TYPO_FIX = {
	vilage: "village",
	villiage: "village",
	strongholds: "stronghold",
	monuments: "monument",
	shipwrecks: "shipwreck",
	mineshafts: "mineshaft",
	coords: "coordinates",
	coodinates: "coordinates",
	coordinats: "coordinates",
	biomee: "biome",
	whre: "where",
	wher: "where",
	fnd: "find",
	locat: "locate",
};

export const LOCATE_SEEKING =
	/\b(where|find|locate|nearest|closest|nearby|around here|any|search|look(ing)? for|how (do|can|should) i (get|reach|find)|direction|way to|lead me|point me|track down|get to|go to|headed for|path to|know (of )?any|got any|help me find|trying to find|show me|take me|guide me|which way|what direction)\b/;

export const STRUCTURE_ALIASES = {
	"desert temple": "desert_pyramid",
	"desert pyramid": "desert_pyramid",
	"jungle temple": "jungle_pyramid",
	"jungle pyramid": "jungle_pyramid",
	"witch hut": "swamp_hut",
	"swamp hut": "swamp_hut",
	"ocean ruin": "ocean_ruin",
	"ocean ruins": "ocean_ruin",
	"nether fossil": "nether_fossil",
	village: "village",
	stronghold: "stronghold",
	"strong hold": "stronghold",
	mansion: "mansion",
	"woodland mansion": "mansion",
	monument: "monument",
	"ocean monument": "monument",
	shipwreck: "shipwreck",
	mineshaft: "mineshaft",
	"ancient city": "ancient_city",
	bastion: "bastion_remnant",
	"pillager outpost": "pillager_outpost",
	outpost: "pillager_outpost",
	"ruined portal": "ruined_portal",
	"buried treasure": "buried_treasure",
	"end city": "end_city",
	fortress: "fortress",
	"nether fortress": "fortress",
	temple: "temple",
	igloo: "igloo",
	"trail ruins": "trail_ruins",
	"trial chambers": "trial_chambers",
	"place to trade": "village",
	"trading post": "village",
	"npc town": "village",
	"npc village": "village",
	"where people live": "village",
	"houses with villagers": "village",
	"underwater temple": "monument",
	"guardian temple": "monument",
	"big underwater building": "monument",
	"wood castle": "mansion",
	"evil woodland house": "mansion",
	"portal room": "stronghold",
	"end portal room": "stronghold",
	"eye of ender place": "stronghold",
	"broken nether portal": "ruined_portal",
	"cracked portal": "ruined_portal",
	"witch house": "swamp_hut",
	"sand temple": "desert_pyramid",
	"sand pyramid": "desert_pyramid",
	"jungle temple ruins": "jungle_pyramid",
	"abandoned mine": "mineshaft",
	"abandoned mines": "mineshaft",
	"cave rails": "mineshaft",
	"pirate ship": "shipwreck",
	"sunken ship": "shipwreck",
	"ship wreck": "shipwreck",
	"piglin castle": "bastion_remnant",
	"piglin base": "bastion_remnant",
	"deep dark city": "ancient_city",
	"sculk city": "ancient_city",
	"shulker city": "end_city",
	"floating end city": "end_city",
	"buried chest": "buried_treasure",
	"treasure chest beach": "buried_treasure",
	"snow hut": "igloo",
	"archeology site": "trail_ruins",
	"suspicious gravel site": "trail_ruins",
	"trial dungeon": "trial_chambers",
	"breeze dungeon": "trial_chambers",
	"underwater ruins": "ocean_ruin",
	"sunken ruins": "ocean_ruin",
	"raid tower": "pillager_outpost",
	"crossbow tower": "pillager_outpost",
	"nether castle": "fortress",
	"blaze spawner place": "fortress",
};

/** @type {Record<string, RegExp[]>} */
export const STRUCTURE_INTENT_HINTS = {
	village: [
		/\btrading\b/,
		/\btrade(s|rs?)?\b/,
		/\bmerchant(s)?\b/,
		/\biron golems?\b/,
		/\bemerald(s)?\b/,
		/\b(blacksmith|cleric|farmer|librarian|butcher|cartographer|fletcher|armorer|weaponsmith)\b/,
		/\b(settlement|town|hamlet|civilization|community)\b/,
		/\bwhere\b.*\b(people|humans?|someone|folk|npcs?)\b/,
		/\b(people|humans?|someone|folk|npcs?)\b.*\b(live|living|near|around|close)\b/,
		/\b(need|want|looking for)\b.*\b(trade|trades|emeralds?|villagers?|food|books)\b/,
		/\b(safe place|somewhere safe|friendly)\b/,
		/\b(beds?|doors?)\b.*\b(find|loot|steal|many)\b/,
		/\b(raid proof|iron farm|trading hall)\b/,
		/\b(houses?|homes?|huts?)\b.*\b(near|around|here)\b/,
		/\b(place|spot)\b.*\b(trade|trading|villagers?)\b/,
		/\bwhere\b.*\b(trade|trading|emeralds?)\b/,
	],
	stronghold: [
		/\bstronghold(s)?\b/,
		/\bend portal\b/,
		/\beyes? of ender\b/,
		/\bender dragon\b/,
		/\b(fight|beat|kill)\b.*\bdragon\b/,
		/\bgo to the end\b/,
		/\benter the end\b/,
	],
	mansion: [
		/\bwoodland mansion\b/,
		/\bmansion(s)?\b/,
		/\b(evoker|vindicator)s?\b/,
		/\billager(s)?\b.*\b(mansion|woods|dark forest)\b/,
		/\btotem of undying\b/,
	],
	monument: [
		/\bocean monument\b/,
		/\b(prismarine|guardians?|elder guardian|sponge)\b/,
		/\b(underwater|sea) temple\b/,
	],
	shipwreck: [/\bshipwreck(s)?\b/, /\b(sunken|wrecked) ship\b/, /\btreasure map\b/],
	mineshaft: [/\bmineshaft(s)?\b/, /\b(abandoned )?mine\b/, /\brail(s)? in a cave\b/],
	ancient_city: [/\bancient cit(y|ies)\b/, /\bward(en)?\b/, /\bsculk (shrieker|sensor|city)\b/],
	bastion_remnant: [/\bbastion(s)?\b/, /\bpiglin (brute|bastion)\b/, /\bnether gold\b/],
	pillager_outpost: [/\bpillager(s)?\b/, /\boutpost(s)?\b/, /\b(bad omen|raid tower|crossbow tower)\b/],
	ruined_portal: [/\bruined portal(s)?\b/, /\bbroken portal\b/, /\bcrying obsidian\b/],
	buried_treasure: [/\bburied treasure\b/, /\bbeach (treasure|chest)\b/],
	end_city: [/\bend cit(y|ies)\b/, /\bshulker(s)?\b/, /\belytra\b/, /\bpurpur\b/],
	fortress: [/\bnether fortress\b/, /\bblaze (rod|spawner|farm)\b/, /\bnether wart\b.*\bfortress\b/],
	temple: [
		/\b(desert|jungle) temple\b/,
		/\bpyramid\b/,
		/\b(temple|shrine)\b.*\b(loot|trap|dispenser)\b/,
	],
	trail_ruins: [/\btrail ruins\b/, /\barcheolog(y|ist|y site)\b/, /\bbrush\b.*\bruins\b/],
	trial_chambers: [/\btrial chambers?\b/, /\bbreeze(s)?\b/, /\b(trial|ominous) (key|spawner)\b/],
	desert_pyramid: [/\bdesert (temple|pyramid)\b/, /\bsand pyramid\b/],
	jungle_pyramid: [/\bjungle (temple|pyramid)\b/, /\bovergrown temple\b/],
	swamp_hut: [/\b(witch|swamp) hut\b/, /\bwitch house\b/],
	igloo: [/\bigloo(s)?\b/, /\bsnow house\b/],
	ocean_ruin: [/\bocean ruins?\b/, /\bunderwater ruins?\b/],
	nether_fossil: [/\bnether fossil(s)?\b/],
};

/** Sound event id map. */
export const SOUND_ALIASES = {
	cow: "mob.cow.hurt",
	chicken: "mob.chicken.say",
	pig: "mob.pig.say",
	sheep: "mob.sheep.say",
	cat: "mob.cat.meow",
	dog: "mob.wolf.bark",
	wolf: "mob.wolf.bark",
	villager: "mob.villager.haggle",
	creeper: "mob.creeper.say",
	zombie: "mob.zombie.say",
	skeleton: "mob.skeleton.say",
	spider: "mob.spider.say",
	enderman: "mob.endermen.stare",
	ghast: "mob.ghast.affectionate_scream",
	warden: "mob.warden.emerge",
	bee: "mob.bee.loop",
	fox: "mob.fox.spit",
	horse: "mob.horse.angry",
	rabbit: "mob.rabbit.hurt",
	panda: "mob.panda.bite",
	dolphin: "mob.dolphin.blowhole",
	turtle: "mob.turtle.hurt",
	parrot: "mob.parrot.imitate",
	llama: "mob.llama.angry",
	goat: "mob.goat.screaming",
	frog: "mob.frog.ambient",
	axolotl: "mob.axolotl.idle",
	door: "random.door_open",
	chest: "random.chestopen",
	anvil: "random.anvil_use",
	bell: "block.bell.hit",
	explosion: "random.explode",
	thunder: "ambient.weather.thunder",
	rain: "ambient.weather.rain",
	portal: "block.portal.travel",
	enchant: "random.levelup",
};

export const MYGAL_NORMAL_SOUND = "pntmc.verity.mygal_normal";
export const MATRIX_SONG_SOUND = "pntmc.verity.matrixsong";

const ONOMATOPOEIA_MOB = {
	moo: "cow",
	meow: "cat",
	bark: "dog",
	oink: "pig",
	baa: "sheep",
};

/** @type {string[] | undefined} */
let SOUND_ALIAS_KEYS;

/**
 * @param {string} message
 */
export function wantsSoundRequest(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (
		/\b(sound|sounds|play|hear|make|imitate|noise|let me hear|what does a|go like a|sound like)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (/\b(moo|meow|bark|oink|baa)\b/.test(n)) return true;
	if (
		/\b(cow|villager|pig|sheep|chicken|cat|dog|wolf|zombie|skeleton|creeper|spider|bee|fox|horse|goat|frog|axolotl|warden|ghast|enderman|llama|panda|dolphin|turtle|parrot)\b/.test(
			n,
		) &&
		/\b(sound|sounds|noise|say|moo|meow|bark|oink|baa)\b/.test(n)
	) {
		return true;
	}
	return false;
}

/**
 * @param {string} message
 */
export function wantsAnotherSong(message) {
	const n = expandMessage(normalizeQuestion(message));
	return (
		/\b(another|different|other|new|change|switch|something else|next)\b/.test(n) &&
		/\b(song|music|tune|track|melody)\b/.test(n)
	);
}

/**
 * @param {string} message
 */
export function wantsPlaySong(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (/\bwhat (is|are) (a |the )?(song|songs|music)\b/.test(n)) return false;
	if (wantsAnotherSong(message)) return true;
	const hasTrack = /\b(song|songs|music|mygal|melody|tune|tunes|track|beat)\b/.test(n);
	const wantsPlay =
		/\b(play|plays|playing|put on|sing|sang|start|turn on)\b/.test(n) ||
		/\b(can you|could you|please|i want|i need|bored|listen|chill)\b/.test(n);
	if (hasTrack && wantsPlay) return true;
	if (/\b(play something|put on music|sing something)\b/.test(n)) return true;
	if (/\b(i am bored|im bored|bored play)\b/.test(n)) return true;
	return false;
}

/**
 * @param {string} message
 * @param {string | undefined} lastSongId
 */
export function resolvePlaySongSound(message, lastSongId) {
	if (wantsAnotherSong(message)) {
		return lastSongId === MATRIX_SONG_SOUND ? MYGAL_NORMAL_SOUND : MATRIX_SONG_SOUND;
	}
	return MYGAL_NORMAL_SOUND;
}

/**
 * @param {string} message
 */
export function findSoundKey(message) {
	const wantsSound = wantsSoundRequest(message);
	if (!wantsSound) return null;

	const n = normalizeQuestion(message);

	if (/\bvillagers?\b/.test(n)) {
		return SOUND_ALIASES.villager;
	}

	for (const [onom, mob] of Object.entries(ONOMATOPOEIA_MOB)) {
		if (n.includes(onom)) {
			const id = SOUND_ALIASES[mob];
			if (id) return id;
		}
	}

	if (!SOUND_ALIAS_KEYS) {
		SOUND_ALIAS_KEYS = Object.keys(SOUND_ALIASES).sort((a, b) => b.length - a.length);
	}
	for (const key of SOUND_ALIAS_KEYS) {
		if (n.includes(key)) return SOUND_ALIASES[key];
	}

	return null;
}

const ORE_TIPS = [
	{
		pattern: /\b(diamond|diamonds)\b/,
		replies: [
			"Diamonds love deep stone. Try around Y minus 59. Branch mine at that level.",
			"For diamonds, go deep. Roughly Y minus 59. Bring iron pickaxes and torches.",
		],
	},
	{
		pattern: /\b(ancient debris|netherite)\b/,
		replies: [
			"Ancient debris shows up best around Y 15 in the Nether. Pack fire resistance.",
			"Netherite scrap lives near Y 15 in the Nether. Bed mining is risky, so tunnel carefully.",
		],
	},
	{
		pattern: /\b(iron|iron ore)\b/,
		replies: [
			"Iron is common around Y 16 and in mountains. A good cave at mid elevation works too.",
			"Try Y 16 for iron, or explore big caves. You'll trip over it.",
		],
	},
	{
		pattern: /\b(gold|gold ore)\b/,
		replies: [
			"Overworld gold likes badlands and deep Y around minus 16. In the Nether, it's everywhere on the ceiling.",
			"Badlands biomes are gold heaven. Otherwise, go fairly deep underground.",
		],
	},
	{
		pattern: /\b(copper|copper ore)\b/,
		replies: [
			"Copper spawns in regular overworld heights. Y around 48 down to 0 is a solid range.",
			"Dig between surface and Y 0 for copper. Mountains help too.",
		],
	},
	{
		pattern: /\b(lapis|lapis lazuli)\b/,
		replies: [
			"Lapis clusters near Y 0. Around minus 32 to 32 is the sweet spot.",
			"Go near Y 0 for lapis. Enchanting tables love the stuff.",
		],
	},
	{
		pattern: /\b(redstone)\b/,
		replies: [
			"Redstone hangs out low. Y minus 32 to 16 is where I'd dig.",
			"Mine low for redstone. Big caves at deepslate level are great.",
		],
	},
	{
		pattern: /\b(emerald|emeralds)\b/,
		replies: [
			"Emeralds come from villagers and mountain biomes. Villages are usually easier.",
			"Trade with villagers, or mine in mountains and stony peaks if you like pain.",
		],
	},
	{
		pattern: /\b(coal|charcoal)\b/,
		replies: [
			"Coal shows up everywhere from Y 0 to 256. Caves and mountains are easy mode.",
			"Dig into any hillside. Coal is the ore you trip over first.",
		],
	},
	{
		pattern: /\b(deepslate|tuff)\b/,
		replies: [
			"Deepslate starts below Y 0. Ores there are tougher but diamonds love that layer.",
			"Below Y 0 the stone turns deepslate. Bring good pickaxes.",
		],
	},
];

/**
 * @param {string} message
 */
export function normalizeQuestion(message) {
	let s = message.toLowerCase();
	s = s
		.replace(/c[oô]ng\s*tr[iì]nh/g, " structure ")
		.replace(/\bl[àa]ng\b/g, " village ")
		.replace(/t[iì]m(\s*kiếm|\s*kiem)?/g, " find ")
		.replace(/(ở\s*)?đâu/g, " where ")
		.replace(/\bgần(\s*đây)?\b/g, " nearby ")
		.replace(/\bcho\s*tôi\b/g, " find ");
	return s
		// Preserve unmatched Unicode words. Locale canonicalizers translate the
		// intent grammar first, while names and unknown topics must survive for
		// knowledge/fallback handling instead of becoming an empty string.
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * @param {string} n
 */
function fixTypos(n) {
	let out = ` ${n} `;
	for (const [typo, fix] of Object.entries(TYPO_FIX)) {
		out = out.replaceAll(` ${typo} `, ` ${fix} `);
	}
	return out.trim();
}

/**
 * @param {string} n
 */
export function expandMessage(n) {
	let expanded = fixTypos(n);

	for (const [canonical, syns] of Object.entries(SYNONYM_EXPAND)) {
		for (const syn of syns) {
			if (expanded.includes(syn)) {
				expanded += ` ${canonical}`;
			}
		}
	}

	return expanded.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} n
 */
export function tokenize(n) {
	return expandMessage(n)
		.split(" ")
		.filter((w) => w && !STOP_WORDS.has(w));
}

/** @type {{ raw: string, norm: string, expanded: string, tokens: string[] } | null} */
let messageContext = null;

/**
 * Cache normalize only. Skip synonym-expand + tokenize (those exist to
 * feed keyword Q&A tables — Groq does not need them).
 * @param {string} message
 * @param {{ lite?: boolean }} [opts]
 */
export function beginMessageContext(message, opts = {}) {
	const raw = String(message ?? "").trim();
	const norm = normalizeQuestion(raw);
	if (opts.lite) {
		messageContext = { raw, norm, expanded: norm, tokens: [] };
		return;
	}
	const expanded = expandMessage(norm);
	messageContext = { raw, norm, expanded, tokens: tokenize(expanded) };
}

export function endMessageContext() {
	messageContext = null;
}

/**
 * @param {string} message
 */
export function getMessageExpanded(message) {
	const raw = String(message ?? "").trim();
	if (messageContext && messageContext.raw === raw) return messageContext.expanded;
	return expandMessage(normalizeQuestion(raw));
}

/**
 * @param {string} message
 * @returns {string[]}
 */
export function getMessageTokens(message) {
	const raw = String(message ?? "").trim();
	if (messageContext && messageContext.raw === raw) return messageContext.tokens;
	return tokenize(expandMessage(normalizeQuestion(raw)));
}

/**
 * @param {string} playerId
 */
export function getPlayerContext(playerId) {
	let ctx = playerContext.get(playerId);
	if (!ctx) {
		const saved = loadPlayerJson(playerId, PLAYER_SAVE.CONTEXT);
		ctx = saved && typeof saved === "object" ? saved : {};
		playerContext.set(playerId, ctx);
	}
	return ctx;
}

/**
 * @param {string} playerId
 * @param {Partial<PlayerContext>} patch
 */
export function updatePlayerContext(playerId, patch) {
	const ctx = getPlayerContext(playerId);
	Object.assign(ctx, patch);
	playerContext.set(playerId, ctx);
	savePlayerJson(playerId, PLAYER_SAVE.CONTEXT, ctx);
}

/**
 * @param {string} playerId
 */
export function clearPlayerContext(playerId) {
	playerContext.delete(playerId);
}

/**
 * @param {string} message
 */
export function wantsPreciseLocate(message) {
	return /\b(exact|precise|coordinate|coords|xyz|numbers|position|pinpoint)\b/i.test(
		message,
	);
}

/**
 * @param {string} message
 */
export function looksLikeQuestion(message) {
	const n = normalizeQuestion(message);
	if (/[?？]/.test(message)) return true;
	if (
		/^(what|where|when|who|why|how|which|can|could|should|is|are|am|do|does|did|will|would|tell|show|help|find|locate|play|give|let)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (
		/\b(need|want|looking for|searching for|trying to find|help me find|know any|got any|wondering|curious|thinking about|planning to)\b/.test(
			n,
		)
	) {
		return true;
	}
	return n.split(" ").filter(Boolean).length >= 4;
}

/**
 * @param {string} n
 */
function scoreStructureIntents(n) {
	/** @type {Map<string, number>} */
	const scores = new Map();

	for (const [structure, patterns] of Object.entries(STRUCTURE_INTENT_HINTS)) {
		for (const pattern of patterns) {
			if (pattern.test(n)) {
				scores.set(structure, (scores.get(structure) ?? 0) + 1);
			}
		}
	}

	for (const [alias, structure] of Object.entries(STRUCTURE_ALIASES)) {
		if (n.includes(normalizeQuestion(alias))) {
			scores.set(structure, (scores.get(structure) ?? 0) + 3);
		}
	}

	return scores;
}

/**
 * @param {Map<string, number>} scores
 */
function pickBest(scores) {
	let best = "";
	let bestScore = 0;
	for (const [key, score] of scores) {
		if (score > bestScore) {
			bestScore = score;
			best = key;
		}
	}
	return bestScore > 0 ? { key: best, score: bestScore } : null;
}

/**
 * @param {string} n
 */
function isProximityQuestion(n) {
	return (
		/\b(here|this area|around me|around here|near me|right here|right now|where i am|at my location|close by|standing in|in this)\b/.test(
			n,
		) ||
		/\b(is this|am i in|are we in|is that a|this a|are we at)\b/.test(n) ||
		/\b(is there|are there|any|got)\b.*\b(near|here|around|close)\b/.test(n)
	);
}

/**
 * @param {string} n
 * @param {number} score
 */
function shouldLocateStructure(n, score) {
	if (wantsSoundRequest(n)) return false;
	if (/\b(don t|dont|not|without|never|no)\b.*\b(village|stronghold|mansion|structure)\b/.test(n)) {
		return false;
	}
	if (isProximityQuestion(n) && score >= 1) return true;
	if (score >= 2) return true;
	if (LOCATE_SEEKING.test(n) && score >= 1) return true;
	if (score >= 1 && looksLikeQuestion(n)) return true;
	return false;
}

/**
 * @param {string} n
 */
function isVillagerSoundNotVillage(n) {
	return (
		/\bvillagers?\b/.test(n) &&
		!/\b(village|town|settlement|hamlet|trading hall|locate|find|where|nearest)\b/.test(n)
	);
}

/**
 * @param {string} message
 */
export function findStructureKey(message) {
	const n = getMessageExpanded(message);

	if (wantsSoundRequest(message) && isVillagerSoundNotVillage(n)) {
		return null;
	}

	let bestAlias = null;
	let bestLen = 0;
	for (const [alias, structure] of Object.entries(STRUCTURE_ALIASES)) {
		const norm = normalizeQuestion(alias);
		if (n.includes(norm) && norm.length > bestLen && shouldLocateStructure(n, 3)) {
			bestAlias = structure;
			bestLen = norm.length;
		}
	}
	if (bestAlias) return bestAlias;

	const best = pickBest(scoreStructureIntents(n));
	if (best && shouldLocateStructure(n, best.score)) {
		if (best.key === "village" && isVillagerSoundNotVillage(n)) return null;
		return best.key;
	}

	if (
		LOCATE_SEEKING.test(n) &&
		/\b(people|humans?|someone|houses?|homes?|huts?|settlement|trade|trades|civilization|npcs?|friendly)\b/.test(
			n,
		) &&
		!/\bvillagers?\b/.test(n)
	) {
		return "village";
	}

	if (
		LOCATE_SEEKING.test(n) &&
		/\bvillagers?\b/.test(n) &&
		/\b(village|town|settlement|trading|trade)\b/.test(n)
	) {
		return "village";
	}

	if (LOCATE_SEEKING.test(n) && /\bstructure(s)?\b/.test(n)) {
		return "any_structure";
	}

	if (
		isProximityQuestion(n) &&
		/\b(village|town|temple|monument|mansion|stronghold|fortress|mineshaft|shipwreck|outpost|hut|ruins?|city)\b/.test(
			n,
		)
	) {
		const hint = pickBest(scoreStructureIntents(n));
		if (hint && hint.score >= 1) return hint.key;
	}

	return null;
}

/** @type {Record<string, RegExp>} */
const ORE_KEY_PATTERNS = {
	diamond: /\b(diamond|diamonds)\b/,
	iron: /\b(iron|iron ore)\b/,
	gold: /\b(gold|gold ore)\b/,
	copper: /\b(copper|copper ore)\b/,
	lapis: /\b(lapis|lapis lazuli)\b/,
	redstone: /\b(redstone)\b/,
	coal: /\b(coal|charcoal)\b/,
	emerald: /\b(emerald|emeralds)\b/,
	ancient_debris: /\b(ancient debris|netherite scrap|netherite)\b/,
	quartz: /\b(quartz|nether quartz)\b/,
};

/**
 * @param {string} message
 * @returns {string | null}
 */
export function findOreKey(message) {
	const n = expandMessage(normalizeQuestion(message));
	for (const [key, pattern] of Object.entries(ORE_KEY_PATTERNS)) {
		if (pattern.test(n)) return key;
	}
	return null;
}

/**
 * @param {string} message
 * @returns {"how_to"|"nearby"|"precise"|null}
 */
export function classifyOreIntent(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (!findOreKey(message)) return null;

	if (
		wantsPreciseLocate(message) ||
		/\b(exact|coordinates|coords|xyz|what block|pinpoint|give me the numbers)\b/.test(n)
	) {
		return "precise";
	}

	if (
		/\b(how (do|can|should|would)|best way|what y|what level|which level|which y|where (should|do) i (mine|dig|look|find)|tips? for|how to (find|get|mine))\b/.test(
			n,
		)
	) {
		return "how_to";
	}

	if (
		/\b(where|find|near|nearby|around|close|scan|sense|there any|any .+ near|locate|spot|look for|search)\b/.test(
			n,
		) &&
		/\b(ore|vein|deposit|mineral|minerals)\b/.test(n)
	) {
		return "nearby";
	}

	if (/\b(where|find|near|nearby|around)\b/.test(n)) {
		return "nearby";
	}

	return "how_to";
}

/**
 * @param {string} message
 */
export function wantsBiomeInfo(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (
		/\b(what|which)\b.{0,24}\bbiomes?\b/.test(n) ||
		/\bbiomes?\b.{0,24}\b(is this|am i in|are we in|here|now)\b/.test(n) ||
		/\b(this|current|my)\s+biomes?\b/.test(n)
	) {
		return true;
	}
	return (
		/\b(biome|ecosystem|environment|terrain|climate|weather zone|landscape|biome name)\b/.test(
			n,
		) &&
		(/\b(what|which|where|here|this|standing|under|feet|ground|area|place|land|region|zone)\b/.test(
			n,
		) ||
			looksLikeQuestion(message))
	);
}

/**
 * @param {string} playerId
 * @param {string} message
 * @returns {string | null}
 */
export function tryResolveFollowUp(playerId, message) {
	const ctx = getPlayerContext(playerId);
	const n = expandMessage(normalizeQuestion(message));

	if (ctx.lastLocate) {
		const { structure, blocks, dir, x, z, precise } = ctx.lastLocate;
		const pretty = structure.replace(/_/g, " ");

		if (/\b(how far|how many blocks|distance|far away|far is it)\b/.test(n)) {
			return `About ${blocks} blocks ${dir}. That's the nearest ${pretty}.`;
		}
		if (
			/\b(which way|what direction|where do i go|head|turn|walk|run)\b/.test(n) &&
			!findStructureKey(message)
		) {
			return `Head ${dir}. Roughly ${blocks} blocks to the nearest ${pretty}.`;
		}
		if (/\b(exact|precise|coordinates|coords|xyz|numbers)\b/.test(n)) {
			return `__LOCATE_PRECISE__:${structure}`;
		}
		if (/\b(that|it|there|same|again)\b/.test(n) && n.split(" ").length <= 6) {
			if (precise) {
				const xStr = Math.round(x) < 0 ? `minus ${Math.abs(Math.round(x))}` : String(Math.round(x));
				const zStr = Math.round(z) < 0 ? `minus ${Math.abs(Math.round(z))}` : String(Math.round(z));
				return `${pretty} is near X ${xStr} and Z ${zStr}, about ${blocks} blocks ${dir}.`;
			}
			return `Still ${dir} of you, about ${blocks} blocks to the ${pretty}.`;
		}
	}

	if (ctx.lastBiome && /\b(that biome|same biome|it again|what was it)\b/.test(n)) {
		return `Still ${ctx.lastBiome}.`;
	}

	if (ctx.lastSound && /\b(again|one more|repeat|same sound|do it again)\b/.test(n)) {
		return `__REPLAY_SOUND__:${ctx.lastSound}`;
	}

	if (ctx.lastLocate && /\b(closer|nearer|another|different|other one|somewhere else)\b/.test(n)) {
		return `__LOCATE_AGAIN__:${ctx.lastLocate.structure}`;
	}

	if (ctx.lastIntent === "locate" && /\b(is it far|is it close|far away|pretty close)\b/.test(n)) {
		const { blocks, pretty } = ctx.lastLocate
			? {
					blocks: ctx.lastLocate.blocks,
					pretty: ctx.lastLocate.structure.replace(/_/g, " "),
				}
			: { blocks: 0, pretty: "it" };
		if (blocks > 800) return `Yeah. The ${pretty} is far — about ${blocks} blocks. Pack supplies.`;
		if (blocks > 300) return `Medium trip. About ${blocks} blocks. Not around the corner.`;
		if (blocks > 0) return `Pretty close. Roughly ${blocks} blocks. You could walk it.`;
	}

	if (/\b(say that again|repeat that|what did you say|pardon|come again)\b/.test(n)) {
		if (ctx.lastAnswer) return ctx.lastAnswer;
		if (ctx.lastQuestion) return `__REPEAT_LAST__:${ctx.lastQuestion}`;
	}

	if (/\b(what can you do|what do you know|capabilities|features)\b/.test(n)) {
		return null;
	}

	return null;
}

/**
 * @param {string} message
 * @returns {string | null}
 */
export function tryOreTip(message) {
	const intent = classifyOreIntent(message);
	if (intent !== "how_to") return null;

	const oreKey = findOreKey(message);
	if (oreKey) {
		return getOreHowToAnswer(oreKey);
	}

	const n = expandMessage(normalizeQuestion(message));
	if (!/\b(where|find|mine|mining|dig|best|layer|level|y level|depth|farm|how)\b/.test(n)) {
		return null;
	}

	for (const tip of ORE_TIPS) {
		if (tip.pattern.test(n)) {
			return tip.replies[Math.floor(Math.random() * tip.replies.length)];
		}
	}
	return null;
}

/**
 * @param {string} message
 */
export function wantsRainCountdown(message) {
	const n = expandMessage(normalizeQuestion(message));
	return (
		/\b(will it rain|is it going to rain|going to rain|when will it rain|when is it going to rain|when does it rain|when is rain|rain soon|start raining|make it rain|let it rain|can it rain|bring rain|need rain)\b/.test(
			n,
		) ||
		(/\b(when|soon|start|make|let)\b/.test(n) && /\b(rain|raining|rainy|storm)\b/.test(n)) ||
		(/\b(rain|raining|rainy|storm)\b/.test(n) && /\b(when|soon|now|start|come|begin)\b/.test(n))
	);
}

/**
 * @param {string} message
 */
export function detectWorldFactIntent(message) {
	const n = expandMessage(normalizeQuestion(message));
	const lower = message.toLowerCase();

	if (/\b(health|hearts|hp|how much health|am i hurt)\b/.test(n)) {
		return "health";
	}
	if (/\b(hunger|food|starving|hungry|how hungry|đói)\b/.test(n)) {
		return "hunger";
	}
	if (/\b(time|clock|hour|day|night|morning|evening|sunrise|sunset|sleep|bed)\b/.test(n)) {
		return "time";
	}
	if (wantsRainCountdown(message)) {
		return null;
	}
	if (/\b(weather|rain|storm|thunder|snowing|clear sky)\b/.test(n)) {
		return "weather";
	}
	if (
		/\b(coordinate|coords|position|my location|where am i|lost|gps|xyz)\b/.test(n) ||
		(/\bwhere\b/.test(n) && /\b(i|me|myself)\b/.test(n))
	) {
		return "coords";
	}
	if (/\b(dimension|overworld|nether|end|which world)\b/.test(n)) {
		return "dimension";
	}
	if (/\b(spawn|world origin|0 0|center of the map)\b/.test(n)) {
		return "spawn";
	}
	if (
		/\b(facing|looking|direction am i|which way am i|compass)\b/.test(n) ||
		(/\b(am i)\b/.test(n) && /\b(facing|looking)\b/.test(lower))
	) {
		return "facing";
	}
	if (/\b(depth|y level|height|how high|how deep|elevation)\b/.test(n)) {
		return "elevation";
	}
	if (/\b(light|dark|bright|can mobs spawn)\b/.test(n)) {
		return "light";
	}
	if (/\b(how many players|anyone else|other players|who else|am i alone|solo|multiplayer)\b/.test(n)) {
		return "players";
	}
	if (/\b(gamemode|creative|survival|hardcore|cheats)\b/.test(n)) {
		return "gamemode";
	}
	if (/\b(safe|danger|dangerous|hostile|mobs nearby|something near)\b/.test(n) && looksLikeQuestion(message)) {
		return "safety";
	}
	if (/\b(how long|days|played|world age)\b/.test(n) && /\b(world|game|server)\b/.test(n)) {
		return "world_age";
	}
	return null;
}

/**
 * @param {string} message
 */
const BIOME_LOCATE_ALIASES = {
	desert: "desert",
	jungle: "jungle",
	"dark forest": "roofed_forest",
	"roofed forest": "roofed_forest",
	swamp: "swamp",
	mangrove: "mangrove_swamp",
	taiga: "taiga",
	"snowy taiga": "cold_taiga",
	savanna: "savanna",
	"badlands": "mesa",
	mesa: "mesa",
	cherry: "cherry_grove",
	"cherry grove": "cherry_grove",
	plains: "plains",
	forest: "forest",
	"flower forest": "flower_forest",
	birch: "birch_forest",
	"old growth": "old_growth_birch_forest",
	ice: "ice_plains",
	"snowy plains": "ice_plains",
	"deep dark": "deep_dark",
	mushroom: "mushroom_island",
	"mooshroom": "mushroom_island",
	ocean: "ocean",
	"warm ocean": "warm_ocean",
	"deep ocean": "deep_ocean",
};

/**
 * @param {string} message
 */
export function findBiomeLocateKey(message) {
	const n = expandMessage(normalizeQuestion(message));
	// "what biome is this / am I in" → current biome, not locate
	if (
		/\b(what|which)\b.{0,24}\bbiomes?\b/.test(n) &&
		!/\b(find|locate|nearest|closest|where is|where are|direction|way to|lead me|point me|go to|get to)\b/.test(
			n,
		)
	) {
		return null;
	}
	if (
		/\bbiomes?\b.{0,20}\b(is this|am i in|are we in|here|under (my )?feet)\b/.test(n)
	) {
		return null;
	}
	if (!LOCATE_SEEKING.test(n) && !/\b(find|need|want|looking)\b.*\b(biome|desert|jungle|swamp|taiga)\b/.test(n)) {
		return null;
	}

	let best = "";
	let bestLen = 0;
	for (const [alias, biomeId] of Object.entries(BIOME_LOCATE_ALIASES)) {
		if (n.includes(alias) && alias.length > bestLen) {
			best = biomeId;
			bestLen = alias.length;
		}
	}
	return best || null;
}

export function detectSocialIntent(message) {
	const n = expandMessage(normalizeQuestion(message));
	const short = message.trim().length <= 24;
	if (
		/\b(who are you|what are you|your name)\b/.test(n) ||
		/\b(ban la ai|bạn là ai|may la ai|cau la ai|verity la ai|ten (ban|may) la gi)\b/.test(
			n,
		)
	) {
		return "identity";
	}
	if (
		/\b(are you|you are|you re|youre|r u)\s+(gay|straight|lesbian|bi|bisexual)\b/.test(n) ||
		/\byou\s+(gay|straight|lesbian|bi|bisexual)\b/.test(n)
	) {
		return "sexuality";
	}
	if (/\b(help|how do i use you|what can you do|commands)\b/.test(n)) return "help";
	if (/\b(thanks|thank you|ty|appreciate|cheers)\b/.test(n)) return "thanks";
	if (/\b(good night|goodnight|gn|nighty? night|sleep tight)\b/.test(n)) return "good_night";
	if (/\b(goodbye|bye|see you|see ya|cya)\b/.test(n)) return "goodbye";
	if (/\b(sorry|my bad|apologize|didn t mean|xin lỗi|xin loi)\b/.test(n)) return "sorry";
	if (
		/\b(you re|youre|you are) (cool|awesome|great|amazing|helpful|the best)\b/.test(n) ||
		/\b(love you|best friend)\b/.test(n)
	) {
		return "compliment";
	}
	if (
		/\b(you re|youre|you are) (weird|creepy|stupid|useless|annoying|bad|dumb)\b/.test(n) ||
		/\b(hate you|shut up)\b/.test(n)
	) {
		return "insult";
	}
	if (/\b(are we friends|do you like me|like me|friend)\b/.test(n) && /\b(you|verity|us)\b/.test(n)) {
		return "friendship";
	}
	if (/\b(joke|funny|make me laugh|tell me something funny)\b/.test(n)) return "joke";
	if (/\b(lonely|alone|scared|afraid|worried|nervous|anxious)\b/.test(n) && message.trim().length < 80) {
		return "emotional";
	}
	if (
		/\b(i m|im|i am) (fine|good|great|okay|ok|alright|doing well|doing good|not bad)\b/.test(n) &&
		message.trim().length < 72
	) {
		return "player_doing_well";
	}
	if (/\b(i m|im|i am) (tired|exhausted|sleepy|wiped|drained)\b/.test(n)) {
		return "player_tired";
	}
	if (/\b(i m|im|i am) (sad|down|depressed|upset|heartbroken|miserable)\b/.test(n)) {
		return "player_sad";
	}
	if (/\b(i m|im|i am) (stressed|overwhelmed|burnt out|burned out)\b/.test(n)) {
		return "player_stressed";
	}
	if (/\b(i m|im|i am) (happy|excited|pumped|thrilled|glad|cheerful)\b/.test(n)) {
		return "player_happy";
	}
	if (/\b(i m|im|i am) (scared|terrified|freaked out|freaked)\b/.test(n)) {
		return "player_scared";
	}
	if (
		/\b(how am i|how do i look|am i (ok|okay|alright|doing fine|doing ok)|do i look (ok|okay|fine))\b/.test(n) ||
		/\b(what do you think of me|do you care about me)\b/.test(n)
	) {
		return "check_player";
	}
	if (/\b(are you (ok|okay|alright)|you (ok|okay|alright)\??|hope you re (ok|well)|hope you re doing)\b/.test(n)) {
		return "care_verity";
	}
	if (/\b(long time no see|haven t talked|been a while|i m back|im back|i am back|back again)\b/.test(n)) {
		return "returning";
	}
	if (
		/\b(keep me company|talk (to|with) me|let s (talk|chat)|chat with me|just talk|stay with me)\b/.test(n) ||
		/\b(what s new|anything new with you|tell me about yourself)\b/.test(n)
	) {
		return "small_talk";
	}
	if (/\b(how about you|what about you|and you\??)\b/.test(n) && message.trim().length < 36) {
		return "how_about_you";
	}
	if (/\b(khoe khong|khỏe không|ban khoe|bạn khỏe)\b/.test(n)) {
		return "how_are_you";
	}
	if (/\b(xin chao|chao ban|chào bạn|chao verity)\b/.test(n)) {
		return "greet";
	}
	if (/\b(cam on|cảm ơn)\b/.test(n) && message.trim().length < 40) {
		return "thanks";
	}
	if (/\b(how old are you|your age|when were you born)\b/.test(n)) {
		return "how_old";
	}
	if (/\b(how are you|how re you|how have you been|you good)\b/.test(n)) {
		return "how_are_you";
	}
	if (
		/\b(who is thatmob|who s thatmob|whats thatmob|what is thatmob|who is that mob|who s that mob|what is that mob)\b/.test(
			n,
		) ||
		(/^(who is|who s|whats|what is) mob$/.test(n)) ||
		(/\bthatmob\b/.test(n) && /\b(who|what)\b/.test(n)) ||
		/(thatmob|that mob).{0,12}(là ai|la ai)/.test(n) ||
		/(ai là|ai la).{0,12}(thatmob|that mob)/.test(n)
	) {
		return "thatmob";
	}
	if (
		/\b(twixxel|twixel|grox|groxx)\b/.test(n) &&
		(/\b(who|what|know|about)\b/.test(n) ||
			/(là ai|la ai|tell me|do you know)/.test(n))
	) {
		return "secret_who";
	}
	if (
		/\b(who is pntmc|who s pntmc|what is pntmc|who is pntmcytb)\b/.test(n) ||
		/(pntmc).{0,16}(là ai|la ai)/.test(n) ||
		/(ai là|ai la).{0,16}pntmc/.test(n)
	) {
		return "pntmc_who";
	}
	if (/\b(who made (?:this )?(?:addon|pack|mod)|who created (?:this )?(?:addon|pack|mod)|who made the addon|who made the pack)\b/.test(n)) {
		return "creator_addon";
	}
	if (/\b(who made you|who created you|who built you)\b/.test(n)) return "creator_verity";
	if (/\b(nice to meet|good to meet|pleasure to meet)\b/.test(n)) return "nice_meet";
	if (/\b(what s up|whats up|wassup|how s it going|how goes it)\b/.test(n)) return "whats_up";
	if (/\b(are you there|you there|can you hear me)\b/.test(n) || /^verity[?!.]*$/i.test(message.trim())) {
		return "presence";
	}
	if (/\b(good job|well done|nice work|you did great)\b/.test(n)) return "praise";
	if (/\b(good luck|break a leg)\b/.test(n)) return "good_luck";
	if (/\b(congrats|congratulations)\b/.test(n)) return "congrats";
	if (/\b(miss you|missed you|do you miss me|i miss you|im back|i m back|i'm back|i am back)\b/.test(n)) {
		return "miss";
	}
	if (short && /^(ok|okay|k|sure|yep|yeah|yea|nah|nope|cool|nice|wow|lol|haha|omg|bruh|yes|no)$/i.test(n.trim())) {
		return "ack";
	}
	if (
		/\b(hi|hello|hey|good morning|good afternoon|good evening|sup|yo)\b/.test(n) &&
		message.trim().length < 48 &&
		!/\d\s*(plus|minus|times|divided)\b/.test(n) &&
		!/\d\s*[+\-*/^]/.test(message) &&
		!/^(?:what(?:'s| is)|whats|how much is|calculate|compute|solve)\s+\d/i.test(message.trim())
	) {
		return "greet";
	}
	return null;
}

/**
 * @param {string} message
 */
export function detectControlIntent(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (
		/\b(stop (the )?(music|song|songs)|stop playing|turn off (the )?(music|song)|quiet|shut up|be quiet|silence)\b/.test(
			n,
		)
	) {
		return "stop_music";
	}
	if (/\b(never mind|nevermind|forget it|nvm|cancel that|ignore that)\b/.test(n)) {
		return "cancel";
	}
	if (/\b(stop|enough|that s enough)\b/.test(n) && n.split(" ").length <= 4) {
		return "cancel";
	}
	return null;
}

/**
 * @param {string} message
 */
export function detectSituationalIntent(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (/\b((?:i m|im|i am) lost|lost|no idea where|don t know where|can t find my way|where am i going)\b/.test(n)) {
		return "lost";
	}
	if (/\b(stuck|trapped|can t get out|fallen in|in a hole|help me out)\b/.test(n)) {
		return "stuck";
	}
	if (/\b(i died|just died|lost my stuff|died again|death|all my items|grave)\b/.test(n)) {
		return "died";
	}
	if (/\b(hungry|no food|starving|need food|what do i eat|what should i eat|i m hungry|im hungry|i am hungry)\b/.test(n)) {
		return "hungry";
	}
	if (/\b(first night|getting dark|sun is setting|sunset|night is coming|before dark)\b/.test(n)) {
		return "first_night";
	}
	if (
		/\b(help me|i need help|please help|can you help)\b/.test(n) &&
		!LOCATE_SEEKING.test(n) &&
		!findStructureKey(message)
	) {
		return "need_help";
	}
	if (/\b(what should i do|what now|what do i do next|any ideas|suggest something)\b/.test(n)) {
		return "what_now";
	}
	if (/\b(bored|nothing to do|so bored)\b/.test(n) && !wantsPlaySong(message)) {
		return "bored";
	}
	if (/\b(i m|im) (stressed|overwhelmed|anxious|worried sick)\b/.test(n)) {
		return "stressed";
	}
	if (/\b(i m|im) (excited|pumped|hyped|thrilled)\b/.test(n)) {
		return "excited";
	}
	if (/\b(i m|im) (proud|accomplished|did it|finally did)\b/.test(n) || /\b(i finally|just beat|just finished)\b/.test(n)) {
		return "proud";
	}
	if (/\b(i m|im) (frustrated|annoyed|mad|angry|pissed)\b/.test(n)) {
		return "frustrated";
	}
	if (/\b(i won|i did it|let s go|yes!|we did it|finally)\b/.test(n) && message.trim().length < 48) {
		return "celebrating";
	}
	if (/\b(feeling lonely|feel alone|no one to talk)\b/.test(n)) {
		return "lonely";
	}
	return null;
}

/** @type {{ id: string, pattern: RegExp, replies: string[] }[]} */
export const GAMEPLAY_TIPS = [
	{
		id: "nether",
		pattern: /\b(nether|nether portal|go to nether|enter nether|obsidian portal)\b/,
		replies: [
			"Ten obsidian minimum for a portal. Flint and steel to light it. Bring fire resistance, gold armor for piglins, and food.",
			"Build a portal with obsidian, light it, and prep: food, blocks, fire res, and a way back.",
		],
	},
	{
		id: "end",
		pattern: /\b(the end|end dimension|ender dragon|beat the dragon|kill dragon|enter the end)\b/,
		replies: [
			"Find a stronghold, fill the portal with eyes of ender, bring beds or arrows, slow falling helps, and watch the crystals.",
			"Stronghold first. Eyes of ender. Then armor, food, blocks, and a plan for the dragon crystals.",
		],
	},
	{
		id: "warden",
		pattern: /\b(warden|deep dark|ancient city|sculk shrieker)\b/,
		replies: [
			"Sneak. Don't trigger sculk shriekers twice. Wool or carpets muffle steps. If it spawns, run and don't fight.",
			"Ancient cities are quiet zones. Crouch, avoid vibrations, and never pick a fight with a Warden.",
		],
	},
	{
		id: "enchant",
		pattern: /\b(enchant|enchanting|enchantment|enchant table|xp level|experience)\b/,
		replies: [
			"Bookshelves around the table unlock better enchants. Grind XP at a mob farm or mine coal.",
			"15 bookshelves, lapis, and XP. Rename items on an anvil before they break.",
		],
	},
	{
		id: "villager_trade",
		pattern: /\b(villager trade|trading hall|breed villagers|cure zombie villager|discount)\b/,
		replies: [
			"Lock a villager's job with a workstation. Cure zombie villagers for discounts. Protect them from doors breaking at night.",
			"Workstations, beds, and safety. Zombie cure gives big discounts if you can pull it off.",
		],
	},
	{
		id: "tame",
		pattern: /\b(tame|taming|wolf|cat|horse|parrot|axolotl)\b/,
		replies: [
			"Wolves like bones, cats raw fish, horses need repeated mounts, parrots seeds. Be patient.",
			"Most pets need food or patience. Creepers fear cats. Wolves fight for you.",
		],
	},
	{
		id: "farm",
		pattern: /\b(farm|farming|crop|wheat|carrot|potato|bread|food farm)\b/,
		replies: [
			"Start with wheat and bread. Bone meal speeds crops. Light up the farm so nothing tramples it.",
			"Water within four blocks, light it up, harvest and replant. Villagers can automate later.",
		],
	},
	{
		id: "armor",
		pattern: /\b(armor|armour|protection|what armor|best gear|diamond armor|netherite armor)\b/,
		replies: [
			"Iron early, diamond mid-game, netherite late. Protection and Feather Falling save lives.",
			"Full iron before the Nether. Diamond before the End. Enchant everything you can.",
		],
	},
	{
		id: "portal_return",
		pattern: /\b(get back|way back|return home|find home|my base)\b/,
		replies: [
			"Coords save lives. Write down your base X and Z. A compass points spawn, not home.",
			"Mark your base coordinates. Torches on the path help. In the Nether, one block is eight overworld.",
		],
	},
	{
		id: "cave",
		pattern: /\b(cave|caving|explore cave|underground|branch mine|strip mine)\b/,
		replies: [
			"Torches on the right wall on the way in, left on the way out. Listen for mobs and lava.",
			"Never dig straight down or up. Branch mine at good Y levels. Water bucket saves you from lava.",
		],
	},
	{
		id: "build",
		pattern: /\b(build a house|make a base|base location|where to build|starter base)\b/,
		replies: [
			"Flat ground near water and trees. Light a wide perimeter. Bed inside before night.",
			"Plains or forest near a village is cozy. Cave bases work if you light every corner.",
		],
	},
	{
		id: "shield",
		pattern: /\b(shield|block attacks|creeper|skeleton arrow)\b/,
		replies: [
			"Shields block frontal damage. Strafe creepers. Skeletons hate corners you can peek from.",
			"Craft a shield early. Hold block before the hit lands. It saves more lives than extra hearts.",
		],
	},
];

/**
 * @param {string} message
 * @returns {{ id: string, reply: string } | null}
 */
export function tryGameplayTip(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (!looksLikeQuestion(message) && !/\b(how|tip|advice|help|should|need|want)\b/.test(n)) {
		return null;
	}
	for (const tip of GAMEPLAY_TIPS) {
		if (tip.pattern.test(n)) {
			return {
				id: tip.id,
				reply: tip.replies[Math.floor(Math.random() * tip.replies.length)],
			};
		}
	}
	return null;
}

/**
 * @param {string} message
 */
export function detectGameplayIntent(message) {
	const hit = tryGameplayTip(message);
	return hit?.id ?? null;
}

/**
 * @param {string} message
 */
export function wantsNearbyEntityQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));

	if (
		/\b(biome|biomes|ecosystem|terrain|climate|landscape|weather|dimension|structure|village|seed|coordinate|coords)\b/.test(
			n,
		) ||
		/\b(sound|sounds|song|music|noise)\b/.test(n) ||
		/\b(block|blocks|item|items|tool|weapon|armor|ore|mob sound)\b/.test(n)
	) {
		return false;
	}

	if (wantsBiomeInfo(message) && /\bbiome/.test(n)) {
		return false;
	}

	return (
		/\b(what is that|what s that|whats that|what is this|what s this|whats this)\b/.test(
			n,
		) ||
		/\bwhat (mob|animal|creature|monster|thing|entity|is that|is this)\b/.test(n) ||
		/\b(that|this|it)\b.*\bwhat (is|was)\b/.test(n) ||
		/\bwhat (is|was)\b.*\b(that|this|it)\b/.test(n) ||
		/\b(do you see|see that|see this|what am i looking at|what s in front)\b/.test(n) ||
		/\bwho s that|who is that\b/.test(n) ||
		/(đây|day|con này|cai này|cái này|con kia)\s*(là|la)\s*(con\s*)?gì/.test(n) ||
		/con gì/.test(n)
	);
}

/**
 * Player asking about the block in their crosshair.
 * @param {string} message
 */
export function wantsLookAtBlockQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (
		/\b(biome|biomes|sound|sounds|song|music|mob|animal|creature|monster|entity)\b/.test(
			n,
		)
	) {
		return false;
	}
	return (
		/\bwhat (is|are|was)\b.{0,24}\bblocks?\b/.test(n) ||
		/\b(this|that|the)\s+blocks?\b/.test(n) ||
		/\bblocks?\b.{0,16}\b(is this|is that|am i looking)\b/.test(n) ||
		(/(what am i looking at|whats this|what s this|what is this)/.test(n) &&
			/\bblocks?\b/.test(n)) ||
		/(đây|day|cái này|cai này|khối này|khoi nay).{0,16}(block|khối|khoi)/.test(n) ||
		/\b(block|khối|khoi)\b.{0,12}(gì|gi)\b/.test(n)
	);
}

const SKIP_LOOK_BLOCKS = new Set([
	"minecraft:air",
	"minecraft:cave_air",
	"minecraft:void_air",
	"minecraft:light_block",
	"minecraft:light_block_0",
	"minecraft:barrier",
	"minecraft:structure_void",
]);

/**
 * @param {import("@minecraft/server").Player} player
 */
function viewLookVector(player) {
	const rot = player.getRotation();
	const pitch = (rot.x * Math.PI) / 180;
	const yaw = (rot.y * Math.PI) / 180;
	const cosP = Math.cos(pitch);
	return {
		x: -Math.sin(yaw) * cosP,
		y: -Math.sin(pitch),
		z: Math.cos(yaw) * cosP,
	};
}

/**
 * @param {import("@minecraft/server").Block | undefined} block
 * @returns {import("@minecraft/server").Block | undefined}
 */
function usableLookBlock(block) {
	if (!block) return undefined;
	let typeId = "";
	try {
		typeId = String(block.typeId || "");
	} catch (err) {
		console.warn(`verity look-at block typeId: ${err}`);
		return undefined;
	}
	if (!typeId || SKIP_LOOK_BLOCKS.has(typeId) || /:air$/.test(typeId)) {
		return undefined;
	}
	return block;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function playerLookDir(player) {
	try {
		const dir = player.getViewDirection();
		if (dir && Number.isFinite(dir.x)) return dir;
	} catch {
		/* fall back to rotation */
	}
	return viewLookVector(player);
}

/**
 * Walk the look ray and pick the first named block.
 * @param {import("@minecraft/server").Player} player
 * @param {number} maxDistance
 * @returns {import("@minecraft/server").Block | undefined}
 */
function walkLookBlock(player, maxDistance) {
	const dir = playerLookDir(player);
	let head;
	try {
		head = player.getHeadLocation();
	} catch {
		head = player.location;
	}
	for (let t = 0.2; t <= maxDistance; t += 0.25) {
		const pos = {
			x: Math.floor(head.x + dir.x * t),
			y: Math.floor(head.y + dir.y * t),
			z: Math.floor(head.z + dir.z * t),
		};
		let block;
		try {
			block = player.dimension.getBlock(pos);
		} catch {
			continue;
		}
		const ok = usableLookBlock(block);
		if (ok) {
			console.warn(`verity look-at block walk ${ok.typeId} t=${t.toFixed(1)}`);
			return ok;
		}
	}
	return undefined;
}

/**
 * Block the player is aiming at (crosshair).
 * Do not use Block.isValid — it is missing/throws on some Bedrock builds
 * and would drop every hit (Groq then says it has no block info).
 * @param {import("@minecraft/server").Player} player
 * @param {number} [maxDistance]
 * @returns {import("@minecraft/server").Block | undefined}
 */
export function findLookAtBlock(player, maxDistance = 32) {
	if (!player?.isValid) return undefined;

	const optionSets = [
		{ maxDistance, includeLiquidBlocks: true, includePassableBlocks: true },
		{ maxDistance, includeLiquidBlocks: true },
		{ maxDistance },
	];
	for (const opts of optionSets) {
		try {
			const hit = player.getBlockFromViewDirection(opts);
			const ok = usableLookBlock(hit?.block);
			if (ok) {
				console.warn(`verity look-at block view ${ok.typeId}`);
				return ok;
			}
		} catch (err) {
			console.warn(`verity look-at block view: ${err}`);
		}
	}

	try {
		const hit = player.dimension.getBlockFromRay(
			player.getHeadLocation(),
			playerLookDir(player),
			{
				maxDistance,
				includeLiquidBlocks: true,
				includePassableBlocks: true,
			},
		);
		const ok = usableLookBlock(hit?.block);
		if (ok) {
			console.warn(`verity look-at block ray ${ok.typeId}`);
			return ok;
		}
	} catch (err) {
		console.warn(`verity look-at block ray: ${err}`);
	}

	const walked = walkLookBlock(player, maxDistance);
	if (walked) return walked;
	console.warn("verity look-at block: no hit");
	return undefined;
}

const SKIP_ENTITY_TYPES = new Set([
	"minecraft:item",
	"minecraft:xp_orb",
	"minecraft:arrow",
	"minecraft:snowball",
	"minecraft:egg",
	"minecraft:ender_pearl",
	"minecraft:experience_orb",
	"minecraft:lightning_bolt",
	"minecraft:area_effect_cloud",
	"minecraft:fishing_hook",
	"minecraft:leash_knot",
	"minecraft:painting",
	"minecraft:item_frame",
	"minecraft:glow_item_frame",
	"minecraft:armor_stand",
	"minecraft:falling_block",
	"minecraft:tnt",
	"minecraft:fireworks_rocket",
]);

/**
 * @param {import("@minecraft/server").Entity} ent
 * @param {import("@minecraft/server").Player} player
 */
function isLookableEntity(ent, player) {
	if (!ent?.isValid) return false;
	if (ent.id === player.id) return false;
	if (ent.typeId === "pntmc:verityball") return false;
	if (ent.typeId.startsWith("pntmc:verity")) return false;
	if (ent instanceof Player) return false;
	if (SKIP_ENTITY_TYPES.has(ent.typeId)) return false;
	return true;
}

/**
 * @param {import("@minecraft/server").Vector3} from
 * @param {import("@minecraft/server").Vector3} to
 * @param {{ x: number, y: number, z: number }} look
 */
function entityAimScore(from, to, look) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dz = to.z - from.z;
	const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
	if (dist < 0.01) return { dist: 0, dot: 1 };
	const dot = (dx * look.x + dy * look.y + dz * look.z) / dist;
	return { dist, dot };
}

/**
 * Mob in the crosshair, then the best entity in the look cone.
 * Never pick a 2D-nearest cave mob the player is not facing.
 * @param {import("@minecraft/server").Player} player
 * @param {number} [maxDistance]
 */
export function findTargetEntityNearPlayer(player, maxDistance = 12) {
	if (!player?.isValid) return undefined;

	try {
		const viewHits = player.getEntitiesFromViewDirection({ maxDistance });
		for (const hit of viewHits) {
			const ent = hit.entity;
			if (!isLookableEntity(ent, player)) continue;
			console.warn(`verity look-entity view ${ent.typeId}`);
			return ent;
		}
	} catch (err) {
		console.warn(`verity nearby entity view: ${err}`);
	}

	const look = viewLookVector(player);
	let head;
	try {
		head = player.getHeadLocation();
	} catch {
		head = player.location;
	}

	/** @type {import("@minecraft/server").Entity | undefined} */
	let best;
	let bestKey = Infinity;

	for (const ent of player.dimension.getEntities({
		location: player.location,
		maxDistance,
	})) {
		if (!isLookableEntity(ent, player)) continue;
		const aim = entityAimScore(
			head,
			{
				x: ent.location.x,
				y: ent.location.y + 0.6,
				z: ent.location.z,
			},
			look,
		);
		const inCone = aim.dot >= 0.62;
		const closeBeside = aim.dist <= 3.2 && aim.dot >= 0.12;
		if (!inCone && !closeBeside) continue;
		const key = (1 - aim.dot) * 8 + aim.dist;
		if (key < bestKey) {
			bestKey = key;
			best = ent;
		}
	}

	if (best) {
		console.warn(`verity look-entity cone ${best.typeId}`);
	} else {
		console.warn("verity look-entity: none in view");
	}
	return best;
}

/**
 * @param {string} typeId
 */
export function formatEntityName(typeId) {
	const part = String(typeId).split(":").pop() ?? String(typeId);
	return part
		.split("_")
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(" ");
}

/** @type {Record<string, string[]>} */
export const ENTITY_FLAVOR = {
	"minecraft:creeper": [
		"Creeper. Back up. Now.",
		"That's a creeper. You know what that means.",
	],
	"minecraft:zombie": ["Zombie. Standard undead. Watch the noise.", "Zombie. Kill it or run."],
	"minecraft:skeleton": ["Skeleton. Bow. Shield helps.", "Skeleton archer. Don't strafe in the open."],
	"minecraft:spider": ["Spider. Climbs walls. Don't let it above you.", "Spider. Big and fast at night."],
	"minecraft:enderman": [
		"Enderman. Don't look it in the eyes.",
		"Enderman. Stare at your feet unless you want a fight.",
	],
	"minecraft:warden": ["Warden. Run. Don't fight.", "Warden. You should not be this close."],
	"minecraft:villager": ["Villager. Trades if you don't scare it.", "Villager. Emeralds if you're polite."],
	"minecraft:cow": ["Cow. Beef and leather if you're hungry.", "Cow. Passive. Easy food."],
	"minecraft:pig": ["Pig. Pork chops waiting to happen.", "Pig. Classic early food."],
	"minecraft:sheep": ["Sheep. Wool for a bed.", "Sheep. Grab wool before night."],
	"minecraft:chicken": ["Chicken. Eggs and meat.", "Chicken. Small but useful."],
	"minecraft:wolf": ["Wolf. Bones might tame it.", "Wolf. Could become your best friend."],
	"minecraft:iron_golem": ["Iron golem. Village guard. Don't pick a fight.", "Iron golem. Protects villagers."],
	"minecraft:pillager": ["Pillager. Raid trouble. Kill it quick.", "Pillager. Crossbow. Bad news."],
	"minecraft:bee": ["Bee. Don't hit it unless you like pain.", "Bee. Pollinates. Leave it alone."],
	"minecraft:panda": [
		"Panda. Bamboo eater. Usually chill unless you poke it.",
		"That's a panda. Soft until it isn't.",
	],
};

/**
 * @param {import("@minecraft/server").Entity} entity
 */
export function describeNearbyEntity(entity) {
	const name = formatEntityName(entity.typeId);
	const flavor = ENTITY_FLAVOR[entity.typeId];
	if (flavor) {
		return flavor[Math.floor(Math.random() * flavor.length)];
	}
	return `That is a ${name}.`;
}

/**
 * Keyword router for unknown questions — returns a hint category or null.
 * @param {string} message
 */
export function detectFallbackTopic(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (/\b(water|swim|drown|boat|ocean|river|fishing)\b/.test(n)) return "water";
	if (/\b(fire|lava|burn|flame|magma)\b/.test(n)) return "fire";
	if (/\b(wood|tree|chop|log|planks|crafting table)\b/.test(n)) return "wood";
	if (/\b(stone|pickaxe|cobble|tool|tools)\b/.test(n)) return "tools";
	if (/\b(bed|sleep|spawn point|respawn anchor)\b/.test(n)) return "bed";
	if (/\b(map|compass|locator|barrier|coordinates)\b/.test(n)) return "navigation";
	if (/\b(redstone|piston|automation|machine)\b/.test(n)) return "redstone";
	if (/\b(potion|brew|brewing|splash|lingering)\b/.test(n)) return "potions";
	if (/\b(boss|wither|elder guardian|raid)\b/.test(n)) return "combat";
	if (/\b(biome|climate|temperature|snow|desert)\b/.test(n)) return "biome";
	if (/\b(mob|monster|hostile|passive|animal)\b/.test(n)) return "mobs";
	return null;
}
