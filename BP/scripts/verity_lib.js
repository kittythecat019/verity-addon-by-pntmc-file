/**
 * Merged Verity helper modules. Entry: main.js imports this + large modules.
 * Live chat language/Q&A: Groq via verity_ai_runtime.js (no locale tables).
 * knowledge/ stays as offline fallback only.
 */

import {
	CommandPermissionLevel,
	CustomCommandParamType,
	CustomCommandStatus,
	EnchantmentTypes,
	EquipmentSlot,
	ItemStack,
	Player,
	system,
	world
} from "@minecraft/server";
import {
	beginMessageContext,
	classifyOreIntent,
	describeNearbyEntity,
	detectControlIntent,
	detectFallbackTopic,
	detectGameplayIntent,
	detectSituationalIntent,
	detectSocialIntent,
	detectWorldFactIntent,
	endMessageContext,
	expandMessage,
	findBiomeLocateKey,
	findOreKey,
	findSoundKey,
	findStructureKey,
	findTargetEntityNearPlayer,
	findLookAtBlock,
	formatEntityName,
	getMessageExpanded,
	getMessageTokens,
	getPlayerContext,
	looksLikeQuestion,
	MATRIX_SONG_SOUND,
	MYGAL_NORMAL_SOUND,
	normalizeQuestion,
	resolvePlaySongSound,
	tokenize,
	tryGameplayTip,
	tryOreTip,
	tryResolveFollowUp,
	updatePlayerContext,
	wantsBiomeInfo,
	wantsLookAtBlockQuestion,
	wantsNearbyEntityQuestion,
	wantsPlaySong,
	wantsPreciseLocate,
	wantsRainCountdown,
	wantsSoundRequest
} from "./verity_intent.js";
import {
	KNOWLEDGE_ENTRIES
} from "./verity_knowledge_data.js";
import {
	verityReply,
	isVerityBridgeConnected,
} from "./verity_ai.js";
import {
	getVerityLanguage,
	setVerityLanguage,
	isEnglishLanguage,
	translateVerityInput,
	translateVerityOutput,
	registerLanguageCommand,
	VERITY_LANGUAGE_PROP,
	VERITY_LANGUAGES,
} from "./verity_ai_runtime.js";
export {
	getVerityLanguage,
	setVerityLanguage,
	isEnglishLanguage,
	translateVerityInput,
	translateVerityOutput,
	registerLanguageCommand,
	VERITY_LANGUAGE_PROP,
	VERITY_LANGUAGES,
};
import {
	getPhase2State,
	P2_STATE,
	schedulePhase2Entry,
	tryEnterPhase2FromVerityKills,
	isMercyParole,
	noteMercyBetrayalStrike,
} from "./verity_phase2.js";
import {
	locateNearest
} from "./verity_locate.js";
// ===== verity_singleton.js =====
const __verity_singleton_VERITYBALL_ID = "pntmc:verityball";
const CANONICAL_BALL_PROP = "pntmc:verityball_canonical_id";
const LAST_BALL_LOC_PROP = "pntmc:verityball_last_loc";

const GAME_DIMENSIONS = [
	"minecraft:overworld",
	"minecraft:nether",
	"minecraft:the_end",
];

/** World-critical blocks Verity must not destroy. Obsidian is allowed. */
export const VERITY_PROTECTED_BLOCKS = new Set([
	"minecraft:bedrock",
	"minecraft:invisible_bedrock",
	"minecraft:barrier",
	"minecraft:command_block",
	"minecraft:chain_command_block",
	"minecraft:repeating_command_block",
	"minecraft:structure_block",
	"minecraft:jigsaw",
	"minecraft:end_portal",
	"minecraft:end_portal_frame",
	"minecraft:end_gateway",
	"minecraft:allow",
	"minecraft:deny",
	"minecraft:reinforced_deepslate",
	"minecraft:light_block",
	"minecraft:moving_block",
]);

/**
 * @param {string} typeId
 * @returns {boolean}
 */
export function isVerityProtectedBlock(typeId) {
	if (!typeId) return true;
	if (VERITY_PROTECTED_BLOCKS.has(typeId)) return true;
	if (typeId.endsWith("command_block")) return true;
	return false;
}

/**
 * Force-break a block for Verity (obsidian included). Protected specials stay.
 * @param {import("@minecraft/server").Dimension} dim
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {boolean}
 */
export function verityDestroyBlock(dim, x, y, z) {
	let block;
	try {
		block = dim.getBlock({ x, y, z });
	} catch {
		return false;
	}
	if (!block) return false;
	const typeId = block.typeId;
	if (
		!typeId ||
		typeId === "minecraft:air" ||
		typeId === "minecraft:cave_air" ||
		typeId === "minecraft:void_air"
	) {
		return false;
	}
	if (isVerityProtectedBlock(typeId)) return false;
	try {
		dim.runCommand(`setblock ${x} ${y} ${z} air destroy`);
		return true;
	} catch {
		try {
			block.setType("minecraft:air");
			return true;
		} catch (err) {
			console.warn(`verity destroy ${typeId} at ${x},${y},${z}: ${err}`);
			return false;
		}
	}
}

/**
 * @type {import("@minecraft/server").Entity[] | null}
 */
let ballCache = null;
let ballCacheTick = -1;
const BALL_CACHE_TTL = 10;

export function invalidateVerityballCache() {
	ballCache = null;
	ballCacheTick = -1;
}

/**
 * @returns {import("@minecraft/server").Entity[]}
 */
export function collectAllVerityballs() {
	const now = system.currentTick;
	if (ballCache && now - ballCacheTick < BALL_CACHE_TTL) {
		let allValid = true;
		for (const b of ballCache) {
			if (!b.isValid) {
				allValid = false;
				break;
			}
		}
		if (allValid) return ballCache;
	}

	/** @type {import("@minecraft/server").Entity[]} */
	const balls = [];
	for (const dimId of GAME_DIMENSIONS) {
		try {
			const dim = world.getDimension(dimId);
			for (const ball of dim.getEntities({ type: __verity_singleton_VERITYBALL_ID })) {
				if (ball.isValid) balls.push(ball);
			}
		} catch {
			/* ignore */
		}
	}
	ballCache = balls;
	ballCacheTick = now;
	return balls;
}

export function clearCanonicalVerityball() {
	world.setDynamicProperty(CANONICAL_BALL_PROP, undefined);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function setCanonicalVerityball(ball) {
	if (!ball.isValid || ball.typeId !== __verity_singleton_VERITYBALL_ID) return;
	world.setDynamicProperty(CANONICAL_BALL_PROP, ball.id);
	rememberVerityballLocation(ball);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function rememberVerityballLocation(ball) {
	if (!ball?.isValid) return;
	let face = 0;
	try {
		const f = ball.getProperty("pntmc:face_index");
		if (typeof f === "number") face = f;
	} catch {
		/* ignore */
	}
	try {
		world.setDynamicProperty(
			LAST_BALL_LOC_PROP,
			JSON.stringify({
				x: ball.location.x,
				y: ball.location.y,
				z: ball.location.z,
				dim: ball.dimension.id,
				face,
			}),
		);
	} catch (err) {
		console.warn(`verity remember ball loc: ${err}`);
	}
}

/**
 * @returns {{ x: number, y: number, z: number, dim: string, face: number } | undefined}
 */
function readLastVerityballLocation() {
	try {
		const raw = world.getDynamicProperty(LAST_BALL_LOC_PROP);
		if (typeof raw !== "string" || !raw) return undefined;
		const data = JSON.parse(raw);
		if (
			typeof data?.x !== "number" ||
			typeof data?.y !== "number" ||
			typeof data?.z !== "number" ||
			typeof data?.dim !== "string"
		) {
			return undefined;
		}
		return {
			x: data.x,
			y: data.y,
			z: data.z,
			dim: data.dim,
			face: typeof data.face === "number" ? data.face : 0,
		};
	} catch {
		return undefined;
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function removeVerityball(ball) {
	if (!ball.isValid) return;
	try {
		ball.remove();
		invalidateVerityballCache();
	} catch (err) {
		console.warn(`verity singleton: remove ${ball.id} ${err}`);
	}
}

/**
 * @param {import("@minecraft/server").Entity | undefined} [spawned]
 */
export function enforceSingleVerityball(spawned) {
	const all = collectAllVerityballs().filter((b) => b?.isValid);
	if (all.length === 0) {
		clearCanonicalVerityball();
		return;
	}

	if (all.length === 1) {
		setCanonicalVerityball(all[0]);
		return;
	}

	/** @type {import("@minecraft/server").Entity | undefined} */
	let keeper;
	if (
		spawned?.isValid &&
		spawned.typeId === __verity_singleton_VERITYBALL_ID
	) {
		keeper = spawned;
	} else {
		const storedId = world.getDynamicProperty(CANONICAL_BALL_PROP);
		keeper =
			typeof storedId === "string" ? world.getEntity(storedId) : undefined;
		if (
			!keeper?.isValid ||
			keeper.typeId !== __verity_singleton_VERITYBALL_ID
		) {
			// Prefer a ball still in drop grace (just thrown) over stale ones.
			keeper = all.find((b) => isVerityDropGrace(b)) ?? all[0];
		}
	}

	setCanonicalVerityball(keeper);

	let removed = 0;
	for (const ball of all) {
		if (ball.id === keeper.id) continue;
		removeVerityball(ball);
		removed++;
	}

	if (removed > 0) {
		console.warn(
			`verity singleton: despawned ${removed} duplicate verityball(s), kept ${keeper.id}`,
		);
	}
}

export function initVeritySingleton() {
	system.run(() => enforceSingleVerityball());

	world.afterEvents.entitySpawn.subscribe((ev) => {
		if (ev.entity.typeId !== __verity_singleton_VERITYBALL_ID) return;
		invalidateVerityballCache();
		system.run(() => enforceSingleVerityball(ev.entity));
	});

	world.afterEvents.entityRemove.subscribe((ev) => {
		if (ev.typeId !== __verity_singleton_VERITYBALL_ID) return;
		invalidateVerityballCache();
	});

	system.runInterval(() => {
		if (collectAllVerityballs().length > 1) {
			enforceSingleVerityball();
		}
	}, 40);

	console.warn("verity singleton: one verityball per world");
}

// ===== verity_faces.js =====
/** Face 1 — phase 1 idle */
export const FACE_SMILE = 0;
/** Face 2 — open mouth */
export const FACE_SPEAK = 1;
/** Face 3 — hurt (fall only) */
export const FACE_HURT = 2;
/** @deprecated use FACE_HURT */
export const FACE_WINK = FACE_HURT;
/** Face 4 — abnormal shut */
export const FACE_ABNORMAL_SHUT = 3;
/** Face 5 — abnormal open */
export const FACE_ABNORMAL_OPEN = 4;
/** @deprecated */
export const FACE_CREEPY = FACE_ABNORMAL_SHUT;
/** @deprecated */
export const FACE_GRIN = FACE_ABNORMAL_OPEN;
/** Face 6 — bored (phase 2) */
export const FACE_BORED_P2 = 5;
/** @deprecated */
export const FACE_BORED = FACE_BORED_P2;
/** Face 7 — countdown day 2 shut */
export const FACE_DAY2_SHUT = 6;
/** Face 8 — countdown day 2 open */
export const FACE_DAY2_OPEN = 7;
/** @deprecated */
export const FACE_HUNGRY_SHUT = FACE_DAY2_SHUT;
/** @deprecated */
export const FACE_HUNGRY_OPEN = FACE_DAY2_OPEN;
/** creepysmile */
export const FACE_CREEPY_SMILE = 8;
/** scold shut */
export const FACE_SERIOUS_1 = 9;
/** scold mumble */
export const FACE_SERIOUS_2 = 10;
/** scold angry */
export const FACE_SERIOUS_3 = 11;

export const CREEPY_SMILE_HOLD_MIN = 3000;
export const CREEPY_SMILE_HOLD_MAX = 4000;

/**
 * @param {number} phase
 * @param {number} p2State
 * @param {{ ABNORMAL: number, SMILING: number, COUNTDOWN: number, COUNTDOWN_DAY2: number, POST_LOUD: number }} P2
 * @returns {[number, number]}
 */
export function getTalkFacePairFor(phase, p2State, P2) {
	if (phase === 1) {
		return [FACE_SMILE, FACE_SPEAK];
	}

	if (phase === 2) {
		if (p2State === P2.SMILING) {
			return [FACE_CREEPY_SMILE, FACE_CREEPY_SMILE];
		}
		if (p2State === P2.ABNORMAL || p2State === P2.COUNTDOWN) {
			return [FACE_ABNORMAL_SHUT, FACE_ABNORMAL_OPEN];
		}
		return [FACE_BORED_P2, FACE_BORED_P2];
	}

	if (phase === 3) {
		if (p2State === P2.COUNTDOWN_DAY2 || p2State === P2.POST_LOUD) {
			return [FACE_DAY2_SHUT, FACE_DAY2_OPEN];
		}
		return [FACE_ABNORMAL_SHUT, FACE_ABNORMAL_OPEN];
	}

	return [FACE_SMILE, FACE_SPEAK];
}

/**
 * @param {number} phase
 * @param {number} p2State
 * @param {{ SMILING: number, ABNORMAL: number, COUNTDOWN: number, COUNTDOWN_DAY2: number, POST_LOUD: number }} P2
 * @returns {number}
 */
export function getIdleFaceFor(phase, p2State, P2) {
	if (phase === 1) return FACE_SMILE;
	if (phase === 2) {
		if (p2State === P2.SMILING) return FACE_CREEPY_SMILE;
		if (p2State === P2.ABNORMAL || p2State === P2.COUNTDOWN) {
			return FACE_ABNORMAL_SHUT;
		}
		return FACE_BORED_P2;
	}
	if (phase === 3) {
		if (p2State === P2.COUNTDOWN_DAY2 || p2State === P2.POST_LOUD) {
			return FACE_DAY2_SHUT;
		}
		return FACE_ABNORMAL_SHUT;
	}
	if (phase === 4) return FACE_ABNORMAL_SHUT;
	return FACE_SMILE;
}

/** @type {Record<number, number>} */
const OPEN_TO_SHUT_FACE = {
	[FACE_SPEAK]: FACE_SMILE,
	[FACE_ABNORMAL_OPEN]: FACE_ABNORMAL_SHUT,
	[FACE_DAY2_OPEN]: FACE_DAY2_SHUT,
	[FACE_CREEPY_SMILE]: FACE_CREEPY_SMILE,
	[FACE_SERIOUS_2]: FACE_SERIOUS_1,
	[FACE_SERIOUS_3]: FACE_SERIOUS_1,
};

/**
 * @param {number} openFace
 * @returns {number}
 */
export function getShutFaceForOpen(openFace) {
	return OPEN_TO_SHUT_FACE[openFace] ?? FACE_SMILE;
}

/**
 * @returns {number}
 */
export function randomCreepySmileHoldTicks() {
	return (
		CREEPY_SMILE_HOLD_MIN +
		Math.floor(Math.random() * (CREEPY_SMILE_HOLD_MAX - CREEPY_SMILE_HOLD_MIN + 1))
	);
}

// ===== verity_phases.js =====
export const PHASE = {
	ONE: 1,
	TWO: 2,
	THREE: 3,
	FOUR: 4,
};

const PHASE_PROP = "pntmc:verity_phase";

/**
 * @returns {number}
 */
export function getVerityPhase() {
	const phase = world.getDynamicProperty(PHASE_PROP);
	if (
		phase === PHASE.ONE ||
		phase === PHASE.TWO ||
		phase === PHASE.THREE ||
		phase === PHASE.FOUR
	) {
		return phase;
	}
	return PHASE.ONE;
}

/**
 * @param {number} phase
 */
export function setVerityPhase(phase) {
	world.setDynamicProperty(PHASE_PROP, phase);
}

/** Phase 2–4: horror arc (ball faces + phase2 runtime). */
export function isHorrorArcPhase() {
	const phase = getVerityPhase();
	return phase >= PHASE.TWO && phase <= PHASE.FOUR;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function isVerityballSpeaking(ball) {
	if (!ball?.isValid) return false;
	try {
		return (
			ball.getProperty("pntmc:talking") === true ||
			ball.getProperty("pntmc:scolding") === true
		);
	} catch {
		return false;
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} faceIndex
 * @param {boolean} talking
 */
export function applyBallFace(ball, faceIndex, talking = false) {
	if (!ball.isValid) return;
	try {
		ball.setProperty("pntmc:face_index", faceIndex);
		ball.setProperty("pntmc:talking", talking);
		ball.setProperty("pntmc:scolding", false);
		ball.setProperty("pntmc:scold_heavy", false);
	} catch (err) {
		console.warn(`verity phase face ${faceIndex}: ${err}`);
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} faceIndex
 * @param {boolean} [talking]
 * @param {boolean} [heavy]
 */
export function applyScoldFace(ball, faceIndex, talking = false, heavy = false) {
	if (!ball.isValid) return;
	try {
		ball.setProperty("pntmc:face_index", faceIndex);
		ball.setProperty("pntmc:talking", talking);
		ball.setProperty("pntmc:scolding", true);
		ball.setProperty("pntmc:scold_heavy", heavy);
	} catch (err) {
		console.warn(`verity scold face ${faceIndex}: ${err}`);
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {boolean} [heavy]
 */
export function applyScoldShutFace(ball, heavy = false) {
	applyScoldFace(ball, FACE_SERIOUS_1, false, heavy);
}

/**
 * @param {number} phase
 * @param {number} p2State
 * @param {object} P2
 * @returns {[number, number]}
 */
export function getTalkFacePair(phase, p2State, P2) {
	return getTalkFacePairFor(phase, p2State, P2);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} phase
 * @param {number} p2State
 * @param {object} P2
 */
export function applyContextIdleFace(ball, phase, p2State, P2) {
	applyBallFace(ball, getIdleFaceFor(phase, p2State, P2), false);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function applyPhaseFaces(ball) {
	if (!ball.isValid) return;
	const phase = getVerityPhase();
	switch (phase) {
		case PHASE.ONE:
			applyBallFace(ball, FACE_SMILE, false);
			break;
		case PHASE.TWO:
			applyBallFace(ball, FACE_BORED_P2, false);
			break;
		case PHASE.THREE:
			applyBallFace(ball, FACE_ABNORMAL_SHUT, false);
			break;
		case PHASE.FOUR:
			applyBallFace(ball, FACE_ABNORMAL_SHUT, false);
			break;
		default:
			applyBallFace(ball, FACE_SMILE, false);
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} text
 * @param {[number, number]} talkPair
 */
export function animateGroundSpeech(
	ball,
	text,
	talkPair = [FACE_SMILE, FACE_SPEAK],
) {
	if (!ball.isValid || getVerityPhase() !== PHASE.ONE) return;

	const trimmed = text.trim();
	if (!trimmed) return;

	const [shut, open] = talkPair;
	holdMouthFace(ball, open, talkHoldTicks(trimmed), undefined, shut);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {[number, number]} talkPair
 */
export function pulsePhaseTalkFace(ball, talkPair) {
	if (!ball.isValid) return;
	const [shut, open] = talkPair;
	applyBallFace(ball, open, true);
	system.runTimeout(() => {
		if (!ball.isValid) return;
		applyBallFace(ball, shut, false);
	}, 50);
}

/**
 * @param {number} phase
 */
export function enterVerityPhase(phase) {
	setVerityPhase(phase);
}

/**
 * @param {boolean} enabled
 */
export function setChaseBallFace(enabled) {
	for (const ball of collectAllVerityballs()) {
		if (!ball.isValid) continue;
		try {
			ball.setProperty("pntmc:chase_face", enabled);
			if (enabled) {
				ball.setProperty("pntmc:talking", false);
				ball.setProperty("pntmc:scolding", false);
			}
		} catch (err) {
			console.warn(`verity chase ball face: ${err}`);
		}
	}
}

export function clearChaseBallFace() {
	setChaseBallFace(false);
	for (const ball of collectAllVerityballs()) {
		if (!ball.isValid) continue;
		applyPhaseFaces(ball);
	}
}

// ===== verity_sound_durations.js =====
/** Custom voice lines — seconds measured from WAV/OGG in RP. */
const VOICE_SECONDS = {
	"pntmc.verity.yes_south": 3.2,
	"pntmc.verity.yes": 1.4,
	"pntmc.verity.ouch": 0.94,
	"pntmc.verity.voicelines_en.oof": 0.55,
	"pntmc.verity.voicelines_en.that_hurt": 0.72,
	"pntmc.verity.villagers_gone": 1.37,
	"pntmc.verity.gone": 0.52,
	"pntmc.verity.something_passed": 1.99,
	"pntmc.verity.no": 0.7,
	"pntmc.verity.something_hungry": 1.62,
	"pntmc.verity.im_smiling_now": 1.58,
	"pntmc.verity.always_looked_like_this": 2.75,
	"pntmc.verity.its_already_over": 2.13,
	"pntmc.verity.you_are_mine": 1.71,
	"pntmc.verity.know_everything": 1.8,
	"pntmc.verity.askme": 6.48,
	"pntmc.verity.mobbbbb": 4.0,
	"pntmc.verity.somethingiscomingin3days": 1.6,
	"pntmc.verity.loudsound": 2.5,
	"pntmc.verity.loudmusic": 2.5,
	"pntmc.verity.es.you_are_mine": 1.23,
	"pntmc.verity.es.always_looked_like_this": 1.88,
	"pntmc.verity.es.askme": 7.08,
	"pntmc.verity.es.gone": 1.46,
	"pntmc.verity.es.im_smiling_now": 1.59,
	"pntmc.verity.es.its_already_over": 1.52,
	"pntmc.verity.es.know_everything": 3.37,
	"pntmc.verity.es.something_hungry": 1.46,
	"pntmc.verity.es.something_passed": 1.54,
	"pntmc.verity.es.somethingiscomingin3days": 2.12,
	"pntmc.verity.es.villagers_gone": 2.85,
	"pntmc.verity.es.yes": 0.81,
	"pntmc.verity.es.yes_south": 4.39,
	"pntmc.verity.pt.yes_south": 4.62,
	"pntmc.verity.pt.you_are_mine": 1.59,
	"pntmc.verity.pt.always_looked_like_this": 2.35,
	"pntmc.verity.pt.askme": 6.37,
	"pntmc.verity.pt.gone": 1.1,
	"pntmc.verity.pt.im_smiling_now": 1.96,
	"pntmc.verity.pt.know_everything": 4.62,
	"pntmc.verity.pt.no": 0.86,
	"pntmc.verity.pt.something_hungry": 2.01,
	"pntmc.verity.pt.something_passed": 2.06,
	"pntmc.verity.pt.somethingiscomingin3days": 2.53,
	"pntmc.verity.pt.villagers_gone": 2.3,
	"pntmc.verity.pt.yes": 0.81,
	"pntmc.verity.ru.you_are_mine": 1.04,
	"pntmc.verity.ru.always_looked_like_this": 2.01,
	"pntmc.verity.ru.askme": 6.74,
	"pntmc.verity.ru.gone": 1.04,
	"pntmc.verity.ru.im_smiling_now": 1.7,
	"pntmc.verity.ru.its_already_over": 1.54,
	"pntmc.verity.ru.know_everything": 4.1,
	"pntmc.verity.ru.no": 0.71,
	"pntmc.verity.ru.something_hungry": 1.59,
	"pntmc.verity.ru.something_passed": 1.54,
	"pntmc.verity.ru.somethingiscomingin3days": 2.06,
	"pntmc.verity.ru.villagers_gone": 2.01,
	"pntmc.verity.ru.yes": 0.71,
	"pntmc.verity.ru.yes_south": 4.1,
	"pntmc.verity.vi.you_are_mine": 1.52,
	"pntmc.verity.vi.always_looked_like_this": 1.88,
	"pntmc.verity.vi.askme": 6.24,
	"pntmc.verity.vi.gone": 1.54,
	"pntmc.verity.vi.im_smiling_now": 1.96,
	"pntmc.verity.vi.its_already_over": 1.72,
	"pntmc.verity.vi.know_everything": 3.27,
	"pntmc.verity.vi.no": 0.68,
	"pntmc.verity.vi.something_hungry": 1.54,
	"pntmc.verity.vi.something_passed": 1.65,
	"pntmc.verity.vi.somethingiscomingin3days": 2.53,
	"pntmc.verity.vi.villagers_gone": 2.48,
	"pntmc.verity.vi.yes_south": 3.68,
	"pntmc.verity.vi.yes": 0.76,
};

/** Full-length music tracks — seconds from file probe. */
const MUSIC_SECONDS = {
	"pntmc.verity.mygal_normal": 134,
	"pntmc.verity.matrixsong": 108.7,
};

/** Vanilla / short mob SFX defaults. */
const MOB_SECONDS = {
	"mob.villager.haggle": 1.0,
	"mob.villager.idle": 1.2,
	"mob.cow.hurt": 0.9,
	"mob.cow.say": 1.0,
	"mob.pig.say": 0.8,
	"mob.sheep.say": 0.9,
	"mob.chicken.say": 0.7,
	"mob.wolf.bark": 0.8,
	"mob.cat.meow": 0.9,
	"random.door_open": 0.6,
	"random.door_close": 0.6,
};

const DEFAULT_SECONDS = 1.5;
const MIN_TICKS = 12;

/**
 * @param {string} soundId
 * @returns {number}
 */
export function getSoundDurationTicks(soundId) {
	const sec =
		MUSIC_SECONDS[soundId] ??
		VOICE_SECONDS[soundId] ??
		MOB_SECONDS[soundId] ??
		DEFAULT_SECONDS;
	return Math.max(MIN_TICKS, Math.ceil(sec * 20));
}

/**
 * @param {string} soundId
 */
export function getMusicDurationTicks(soundId) {
	return getSoundDurationTicks(soundId);
}

// ===== verity_music.js =====
/** @deprecated use getMusicDurationTicks(MYGAL_NORMAL_SOUND) */
export const MYGAL_DURATION_TICKS = getMusicDurationTicks(MYGAL_NORMAL_SOUND);

/** @type {Map<string, number>} ballId -> clearRun id */
const musicTimers = new Map();

/** @type {Map<string, number>} ballId -> mouth release timer */
const mouthTimers = new Map();

/** @type {Set<string>} */
const musicPlaying = new Set();

/** @type {Map<string, { soundId: string, releaseFace: number }>} */
const musicSessions = new Map();

/**
 * @param {string | undefined} ballId
 */
export function isMusicPlaying(ballId) {
	if (!ballId) return musicPlaying.size > 0;
	return musicPlaying.has(ballId);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} soundId
 */
function stopSoundForAll(ball, soundId) {
	if (!ball?.isValid) return;
	for (const player of ball.dimension.getPlayers()) {
		try {
			player.runCommand(`stopsound @s ${soundId}`);
		} catch (err) {
			console.warn(`verity stopsound ${soundId}: ${err}`);
		}
	}
}

/**
 * @param {string} ballId
 */
function clearMouthTimer(ballId) {
	const timer = mouthTimers.get(ballId);
	if (timer === undefined) return;
	system.clearRun(timer);
	mouthTimers.delete(ballId);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} mouthFace
 * @param {number} holdTicks
 * @param {() => void} [onRelease]
 * @param {number} [releaseFace] closed-mouth face when hold ends
 */
export function holdMouthFace(ball, mouthFace, holdTicks, onRelease, releaseFace) {
	if (!ball?.isValid) return;
	clearMouthTimer(ball.id);
	applyBallFace(ball, mouthFace, true);
	const timer = system.runTimeout(() => {
		mouthTimers.delete(ball.id);
		if (!ball.isValid) return;
		applyBallFace(ball, releaseFace ?? mouthFace, false);
		onRelease?.();
	}, holdTicks);
	mouthTimers.set(ball.id, timer);
}

/**
 * @param {import("@minecraft/server").Entity | string} ballOrId
 */
export function stopBallMusic(ballOrId) {
	const ballId = typeof ballOrId === "string" ? ballOrId : ballOrId?.id;
	if (!ballId) return;

	const ball = typeof ballOrId === "object" ? ballOrId : undefined;
	const session = musicSessions.get(ballId);

	const timer = musicTimers.get(ballId);
	if (timer !== undefined) {
		system.clearRun(timer);
		musicTimers.delete(ballId);
	}
	musicPlaying.delete(ballId);
	musicSessions.delete(ballId);

	if (!ball?.isValid) return;

	if (session) {
		stopSoundForAll(ball, session.soundId);
	}
	clearMouthTimer(ballId);
	applyBallFace(ball, session?.releaseFace ?? FACE_SMILE, false);
}

/**
 * Stop any playing Verity song before a spoken reply.
 * @param {import("@minecraft/server").Entity | undefined} [preferredBall]
 */
export function stopPlayingBallMusic(preferredBall) {
	if (preferredBall?.isValid && isMusicPlaying(preferredBall.id)) {
		stopBallMusic(preferredBall);
	}
	if (musicPlaying.size === 0) return;
	for (const ball of collectAllVerityballs()) {
		if (ball?.isValid && isMusicPlaying(ball.id)) {
			stopBallMusic(ball);
		}
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} [soundId]
 * @param {number} [faceWhilePlaying]
 * @param {number} [releaseFace]
 * @param {number} [durationTicks]
 * @returns {boolean}
 */
export function playBallMusic(
	ball,
	soundId = MYGAL_NORMAL_SOUND,
	faceWhilePlaying = FACE_SPEAK,
	releaseFace = FACE_SMILE,
	durationTicks = getMusicDurationTicks(soundId),
) {
	if (!ball?.isValid) return false;

	stopBallMusic(ball);
	stopSoundForAll(ball, soundId);

	const loc = ball.location;
	let played = false;

	try {
		for (const player of ball.dimension.getPlayers()) {
			player.playSound(soundId, { location: loc, volume: 1, pitch: 1 });
		}
		played = true;
	} catch (err) {
		console.warn(`verity music ${soundId}: ${err}`);
	}

	if (!played) {
		try {
			const { x, y, z } = loc;
			ball.runCommand(
				`playsound ${soundId} @a ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} 1 1`,
			);
			played = true;
		} catch (cmdErr) {
			console.warn(`verity playsound ${soundId}: ${cmdErr}`);
		}
	}

	if (!played) return false;

	musicPlaying.add(ball.id);
	musicSessions.set(ball.id, { soundId, releaseFace });
	holdMouthFace(ball, faceWhilePlaying, durationTicks, () => {
		musicSessions.delete(ball.id);
	}, releaseFace);

	const timer = system.runTimeout(() => {
		musicTimers.delete(ball.id);
		musicPlaying.delete(ball.id);
		musicSessions.delete(ball.id);
	}, durationTicks);
	musicTimers.set(ball.id, timer);
	return true;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} soundId
 * @param {number} [mouthFace]
 * @param {number} [durationTicks]
 */
export function playBallSoundAt(
	ball,
	soundId,
	mouthFace = FACE_SPEAK,
	durationTicks = getSoundDurationTicks(soundId),
	releaseFace,
) {
	if (!ball?.isValid) return false;
	const loc = ball.location;
	let played = false;
	const closed = releaseFace ?? getShutFaceForOpen(mouthFace);

	try {
		for (const player of ball.dimension.getPlayers()) {
			player.playSound(soundId, { location: loc, volume: 1, pitch: 1 });
		}
		played = true;
	} catch (err) {
		console.warn(`verity sound ${soundId}: ${err}`);
	}

	if (!played) {
		try {
			const { x, y, z } = loc;
			ball.runCommand(
				`playsound ${soundId} @a ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} 1 1`,
			);
			played = true;
		} catch (cmdErr) {
			console.warn(`verity playsound ${soundId}: ${cmdErr}`);
		}
	}

	if (played) {
		holdMouthFace(ball, mouthFace, durationTicks, undefined, closed);
	}
	return played;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Vector3} loc
 * @param {string} soundId
 */
export function playSoundAtLoc(player, loc, soundId) {
	try {
		for (const p of player.dimension.getPlayers()) {
			p.playSound(soundId, { location: loc, volume: 1, pitch: 1 });
		}
		return true;
	} catch (err) {
		console.warn(`verity sound ${soundId}: ${err}`);
		try {
			const { x, y, z } = loc;
			player.runCommand(
				`playsound ${soundId} @a ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} 1 1`,
			);
			return true;
		} catch (cmdErr) {
			console.warn(`verity playsound ${soundId}: ${cmdErr}`);
			return false;
		}
	}
}

// ===== verity_anim.js =====
/**

 * @param {string} text

 * @param {boolean} [fast]

 */

function talkHoldTicks(text, _fast = false) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return 0;
	return Math.max(6, Math.round(trimmed.length * 1.35));
}

export { talkHoldTicks };

/**
 * @typedef {'light' | 'heavy'} ScoldTier
 */

/**
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} text
 * @param {{ faces?: [number, number], fast?: boolean, scoldTier?: ScoldTier, scoldFace?: number }} [options]
 */
export function animateTalkPulse(ball, text, options = {}) {
	if (!ball?.isValid) return;

	const trimmed = text.trim();
	if (!trimmed) return;

	const holdTicks = talkHoldTicks(trimmed);
	if (holdTicks <= 0) return;

	const scoldTier =
		options.scoldTier ??
		(options.scoldFace === FACE_SERIOUS_3
			? "heavy"
			: options.scoldFace === FACE_SERIOUS_2
				? "light"
				: undefined);

	if (scoldTier) {
		const heavy = scoldTier === "heavy";
		const openFace = heavy ? FACE_SERIOUS_3 : FACE_SERIOUS_2;
		applyScoldFace(ball, openFace, true, heavy);
		system.runTimeout(() => {
			if (!ball.isValid) return;
			applyScoldShutFace(ball, heavy);
		}, holdTicks);
		return;
	}

	const [mouthShut, mouthOpen] = options.faces ?? [FACE_SPEAK, FACE_SPEAK];
	holdMouthFace(ball, mouthOpen, holdTicks, undefined, mouthShut);
}

/**
 * @param {number} phase
 * @param {number} p2State
 * @param {object} P2
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} text
 * @param {boolean} [fast]
 */
export function animateContextTalk(
	ball,
	text,
	phase,
	p2State,
	P2,
	fast = false,
) {
	if (!ball?.isValid) return;
	const pair = getTalkFacePairFor(phase, p2State, P2);
	animateTalkPulse(ball, text, { faces: pair, fast });
}



/**

 * @param {import("@minecraft/server").Entity | undefined} ball

 * @param {number} faceIndex

 * @param {number} [holdTicks]

 * @param {number} [releaseFace]

 */

export function flashMouthFace(

	ball,

	faceIndex = FACE_SPEAK,

	holdTicks = 20,

	releaseFace = faceIndex,

) {

	if (!ball?.isValid) return;

	holdMouthFace(ball, faceIndex, holdTicks, undefined, releaseFace);

}

// ===== verity_persist.js =====
/** Per-player blobs stored on world dynamic properties (key includes player id). */
export const PLAYER_SAVE = {
	CONTEXT: "context",
	CHASE: "chase",
	KILLS: "kills",
};

export const WORLD_SAVE = {
	BALL_OWNER_ID: "pntmc:verityball_owner_id",
};

/**
 * @param {string} playerId
 * @param {string} suffix
 */
function playerWorldKey(playerId, suffix) {
	return `pntmc:save:${playerId}:${suffix}`;
}

/**
 * @param {string} playerId
 * @param {string} suffix
 * @param {unknown} data
 */
export function savePlayerJson(playerId, suffix, data) {
	try {
		world.setDynamicProperty(playerWorldKey(playerId, suffix), JSON.stringify(data));
	} catch (err) {
		console.warn(`verity persist save ${suffix}: ${err}`);
	}
}

/**
 * @param {string} playerId
 * @param {string} suffix
 */
export function loadPlayerJson(playerId, suffix) {
	const raw = world.getDynamicProperty(playerWorldKey(playerId, suffix));
	if (typeof raw !== "string" || !raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * @param {string} playerId
 * @param {string} suffix
 */
export function clearPlayerJson(playerId, suffix) {
	try {
		world.setDynamicProperty(playerWorldKey(playerId, suffix), undefined);
	} catch {
		/* ignore */
	}
}

/**
 * @param {string} playerId
 */
export function clearPlayerPersist(playerId) {
	for (const suffix of Object.values(PLAYER_SAVE)) {
		clearPlayerJson(playerId, suffix);
	}
}

export function clearAllOnlinePlayerPersist() {
	for (const player of world.getPlayers()) {
		clearPlayerPersist(player.id);
	}
}

/**
 * @param {string} playerId
 */
export function setBallOwnerId(playerId) {
	try {
		world.setDynamicProperty(WORLD_SAVE.BALL_OWNER_ID, playerId);
	} catch (err) {
		console.warn(`verity persist ball owner: ${err}`);
	}
}

/**
 * @returns {string | undefined}
 */
export function getBallOwnerId() {
	const id = world.getDynamicProperty(WORLD_SAVE.BALL_OWNER_ID);
	return typeof id === "string" ? id : undefined;
}

export function clearBallOwnerId() {
	try {
		world.setDynamicProperty(WORLD_SAVE.BALL_OWNER_ID, undefined);
	} catch {
		/* ignore */
	}
}

// ===== verity_ball_owners.js =====
/* dup @minecraft/server */

/** @type {Map<string, string>} */
export const ballOwners = new Map();

// No colon — entity has_tag filters are unreliable with "namespace:tag".
const OWNER_TAG = "pntmc_verity_owner";
const OWNER_TAG_LEGACY = "pntmc:verity_owner";

/**
 * @param {string} ballId
 */
export function getVerityballOwnerId(ballId) {
	return ballOwners.get(ballId);
}

/**
 * @param {string} ballId
 * @param {string} playerId
 */
export function setVerityballOwner(ballId, playerId) {
	ballOwners.set(ballId, playerId);
}

/**
 * @param {string} ballId
 */
export function clearVerityballOwner(ballId) {
	ballOwners.delete(ballId);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function syncVerityOwnerTag(player) {
	if (!player?.isValid) return;
	try {
		for (const other of world.getPlayers()) {
			if (!other.isValid) continue;
			if (other.id === player.id) {
				other.addTag(OWNER_TAG);
				try {
					other.removeTag(OWNER_TAG_LEGACY);
				} catch {
					/* ignore */
				}
			} else {
				other.removeTag(OWNER_TAG);
				try {
					other.removeTag(OWNER_TAG_LEGACY);
				} catch {
					/* ignore */
				}
			}
		}
	} catch (err) {
		console.warn(`verity owner tag: ${err}`);
	}
}

// ===== verity_items.js =====
export const VERITY_INVENTORY_IDS = new Set([
	"pntmc:verity_inventory_1",
	"pntmc:verity_inventory_2",
	"pntmc:verity_inventory_3",
]);

export const VERITY_ITEM_TO_FACE = {
	"pntmc:verity_inventory_1": FACE_SMILE,
	"pntmc:verity_inventory_2": FACE_BORED_P2,
	"pntmc:verity_inventory_3": FACE_ABNORMAL_OPEN,
};

/**
 * - face 0/1/2 (pntmc_verityball, _2, _3) → inventory_1
 */
export const FACE_TO_INVENTORY_ITEM = {
	[FACE_SMILE]: "pntmc:verity_inventory_1",
	[FACE_SPEAK]: "pntmc:verity_inventory_1",
	[FACE_HURT]: "pntmc:verity_inventory_1",
	[FACE_BORED_P2]: "pntmc:verity_inventory_2",
	[FACE_ABNORMAL_SHUT]: "pntmc:verity_inventory_3",
	[FACE_ABNORMAL_OPEN]: "pntmc:verity_inventory_3",
	[FACE_DAY2_SHUT]: "pntmc:verity_inventory_3",
	[FACE_DAY2_OPEN]: "pntmc:verity_inventory_3",
	[FACE_CREEPY_SMILE]: "pntmc:verity_inventory_3",
	[FACE_SERIOUS_1]: "pntmc:verity_inventory_3",
	[FACE_SERIOUS_2]: "pntmc:verity_inventory_3",
	[FACE_SERIOUS_3]: "pntmc:verity_inventory_3",
};

/**
 * @returns {number}
 */
export function getCanonicalIdleFace() {
	return getIdleFaceFor(getVerityPhase(), getPhase2State(), P2_STATE);
}

/**
 * @param {number} [faceIndex]
 * @returns {string}
 */
export function resolveVerityInventoryItemId(faceIndex) {
	if (typeof faceIndex === "number" && !Number.isNaN(faceIndex)) {
		const mapped = FACE_TO_INVENTORY_ITEM[faceIndex];
		if (mapped) return mapped;
		return "pntmc:verity_inventory_3";
	}
	return FACE_TO_INVENTORY_ITEM[getCanonicalIdleFace()] ?? "pntmc:verity_inventory_1";
}

/**
 * @param {string} [itemTypeId]
 * @returns {number}
 */
export function resolveVerityPlaceFace(itemTypeId) {
	if (itemTypeId && VERITY_ITEM_TO_FACE[itemTypeId] !== undefined) {
		return VERITY_ITEM_TO_FACE[itemTypeId];
	}
	return FACE_SMILE;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function playerHoldingVerity(player) {
	const container = player.getComponent("minecraft:inventory")?.container;
	if (!container) return false;
	const stack = container.getItem(player.selectedSlotIndex);
	return !!stack && VERITY_INVENTORY_IDS.has(stack.typeId);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {number} faceIndex
 * @returns {boolean}
 */
export function syncHeldVerityItem(player, faceIndex) {
	const itemId = FACE_TO_INVENTORY_ITEM[faceIndex];
	if (!itemId) return false;

	const container = player.getComponent("minecraft:inventory")?.container;
	if (!container) return false;

	const slot = player.selectedSlotIndex;
	const stack = container.getItem(slot);
	if (!stack || !VERITY_INVENTORY_IDS.has(stack.typeId)) return false;
	if (stack.typeId === itemId) return false;

	try {
		container.setItem(slot, new ItemStack(itemId, stack.amount));
		return true;
	} catch (err) {
		console.warn(`verity inventory face sync: ${err}`);
		return false;
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @returns {boolean}
 */
export function syncHeldVerityToCanonical(player) {
	return syncHeldVerityItem(player, getCanonicalIdleFace());
}

// ===== verity_actions.js =====
const ENCHANT_LIST = {
	sharpness: { maxLevel: 5, enchantId: "sharpness" },
	smite: { maxLevel: 5, enchantId: "smite" },
	protection: { maxLevel: 4, enchantId: "protection" },
	fire_protection: { maxLevel: 4, enchantId: "fire_protection" },
	unbreaking: { maxLevel: 3, enchantId: "unbreaking" },
	mending: { maxLevel: 1, enchantId: "mending" },
	fortune: { maxLevel: 3, enchantId: "fortune" },
	silk_touch: { maxLevel: 1, enchantId: "silk_touch" },
	looting: { maxLevel: 3, enchantId: "looting" },
	efficiency: { maxLevel: 5, enchantId: "efficiency" },
	feather_falling: { maxLevel: 4, enchantId: "feather_falling" },
	power: { maxLevel: 5, enchantId: "power" },
	flame: { maxLevel: 1, enchantId: "flame" },
	infinity: { maxLevel: 1, enchantId: "infinity" },
	respiration: { maxLevel: 3, enchantId: "respiration" },
	aqua_affinity: { maxLevel: 1, enchantId: "aqua_affinity" },
	thorns: { maxLevel: 3, enchantId: "thorns" },
	depth_strider: { maxLevel: 3, enchantId: "depth_strider" },
	frost_walker: { maxLevel: 2, enchantId: "frost_walker" },
	swift_sneak: { maxLevel: 3, enchantId: "swift_sneak" },
	soul_speed: { maxLevel: 3, enchantId: "soul_speed" },
	sweeping: { maxLevel: 3, enchantId: "sweeping" },
	knockback: { maxLevel: 2, enchantId: "knockback" },
	fire_aspect: { maxLevel: 2, enchantId: "fire_aspect" },
	bane_of_arthropods: { maxLevel: 5, enchantId: "bane_of_arthropods" },
	punch: { maxLevel: 2, enchantId: "punch" },
};

const ENCHANT_ALIASES = {
	sharp: "sharpness",
	prot: "protection",
	unbr: "unbreaking",
	unbreak: "unbreaking",
	eff: "efficiency",
	ff: "feather_falling",
	feather: "feather_falling",
	fire_prot: "fire_protection",
	boa: "bane_of_arthropods",
	bane: "bane_of_arthropods",
	silk: "silk_touch",
};

const COME_HERE_REGEX =
	/\b(come here|come over here|get over here|come to me|over here|come to player|tp(?:\s+to)?\s+me|teleport(?:\s+to)?\s+me|tp to player|teleport to player)\b/i;
const COME_HERE_VI =
	/\b(lai day|toi day|toi cho toi|bay toi|dich chuyen toi|tp toi)\b/i;
const FOLLOW_ME_REGEX =
	/\b(follow me|come with me|walk with me|follow along|can you follow(?:\s+me)?|you follow me)\b/i;
const FOLLOW_ME_VI =
	/\b(theo toi|di theo toi|di theo minh|theo minh|di theo)\b/i;
const STOP_FOLLOW_REGEX =
	/\b(stop following|stop follow|don't follow|do not follow|stay here|wait here|stay put)\b/i;

const ITEM_DROP_REQUEST =
	/\b(?:(?:drop|give|spawn|throw)(?:\s+me)?|i want|i need|get me|hand me|can you give(?:\s+me)?)\s+(?:(\d+)\s+)?(?:some\s+|an?\s+)?([a-z0-9_' -]+?)(?:\s+please)?$/i;
const ITEM_DROP_REQUEST_TRAILING =
	/\b(?:(?:drop|give|spawn|throw)(?:\s+me)?|i want|i need|get me|hand me|can you give(?:\s+me)?)\s+(?:some\s+|an?\s+)?([a-z_' -]+?)\s+(\d+)(?:\s+please)?$/i;
const DEFAULT_DROP_AMOUNT = 10;
const MAX_DROP_AMOUNT = 64;

const ITEM_ALIASES = {
	apple: "apple",
	apples: "apple",
	arrow: "arrow",
	arrows: "arrow",
	bread: "bread",
	coal: "coal",
	cobble: "cobblestone",
	cobblestones: "cobblestone",
	diamond: "diamond",
	diamonds: "diamond",
	dirt: "dirt",
	emerald: "emerald",
	emeralds: "emerald",
	"ender pearl": "ender_pearl",
	"ender pearls": "ender_pearl",
	gold: "gold_ingot",
	"gold ingot": "gold_ingot",
	"gold ingots": "gold_ingot",
	iron: "iron_ingot",
	"iron ingot": "iron_ingot",
	"iron ingots": "iron_ingot",
	log: "oak_log",
	logs: "oak_log",
	netherite: "netherite_ingot",
	"netherite ingot": "netherite_ingot",
	"netherite ingots": "netherite_ingot",
	obsidian: "obsidian",
	plank: "oak_planks",
	planks: "oak_planks",
	pork: "porkchop",
	porks: "porkchop",
	porkchop: "porkchop",
	porkchops: "porkchop",
	"pork chop": "porkchop",
	"pork chops": "porkchop",
	"raw pork": "porkchop",
	"raw porkchop": "porkchop",
	"raw porkchops": "porkchop",
	"cooked pork": "cooked_porkchop",
	"cooked porkchop": "cooked_porkchop",
	"cooked porkchops": "cooked_porkchop",
	bacon: "cooked_porkchop",
	steak: "cooked_beef",
	beef: "beef",
	"raw beef": "beef",
	"cooked beef": "cooked_beef",
	chicken: "chicken",
	chickens: "chicken",
	"raw chicken": "chicken",
	"cooked chicken": "cooked_chicken",
	mutton: "mutton",
	"raw mutton": "mutton",
	"cooked mutton": "cooked_mutton",
	rabbit: "rabbit",
	"raw rabbit": "rabbit",
	"cooked rabbit": "cooked_rabbit",
	cod: "cod",
	salmon: "salmon",
	stone: "stone",
	torch: "torch",
	torches: "torch",
	"water bucket": "water_bucket",
	"wither star": "nether_star",
	"nether star": "nether_star",
	wood: "oak_log",
};

const BLOCKED_DROP_ITEMS = new Set(["diamond", "nether_star"]);

const CREATIVE_ONLY_DROP_ITEMS = new Set([
	"command_block",
	"chain_command_block",
	"repeating_command_block",
	"structure_block",
	"structure_void",
	"barrier",
	"jigsaw",
	"light_block",
	"light_block_0",
	"border_block",
	"allow",
	"deny",
	"bedrock",
	"end_portal_frame",
	"end_portal",
	"end_gateway",
	"mob_spawner",
	"spawner",
	"trial_spawner",
	"vault",
	"reinforced_deepslate",
	"spawn_egg",
	"npc_spawn_egg",
	"agent_spawn_egg",
	"camera",
]);

const RARE_DROP_ITEMS = new Set([
	"emerald",
	"emerald_ore",
	"deepslate_emerald_ore",
	"golden_apple",
	"enchanted_golden_apple",
	"ender_pearl",
	"ender_eye",
	"blaze_rod",
	"ghast_tear",
	"shulker_shell",
	"nautilus_shell",
	"name_tag",
	"saddle",
	"elytra",
	"totem_of_undying",
	"trident",
	"heart_of_the_sea",
	"conduit",
	"echo_shard",
	"recovery_compass",
	"sniffer_egg",
	"heavy_core",
	"mace",
	"trial_key",
	"ominous_trial_key",
	"dragon_egg",
	"dragon_breath",
	"wither_skeleton_skull",
	"music_disc_5",
	"music_disc_11",
	"music_disc_13",
]);

/**
 * @param {string} message
 */
export function wantsComeHere(message) {
	const raw = String(message ?? "");
	if (COME_HERE_REGEX.test(raw) || COME_HERE_VI.test(raw)) return true;
	const n = expandMessage(normalizeQuestion(raw));
	return COME_HERE_REGEX.test(n) || COME_HERE_VI.test(n);
}

/**
 * @param {string} message
 */
export function wantsFollowMe(message) {
	const raw = String(message ?? "");
	if (FOLLOW_ME_REGEX.test(raw) || FOLLOW_ME_VI.test(raw)) return true;
	const n = expandMessage(normalizeQuestion(raw));
	return FOLLOW_ME_REGEX.test(n) || FOLLOW_ME_VI.test(n);
}

/**
 * @param {string} message
 */
export function wantsStopFollow(message) {
	return STOP_FOLLOW_REGEX.test(message);
}

/**
 * @param {string} message
 */
export function wantsEnchantBooks(message) {
	const msg = message.toLowerCase();
	const asks =
		/\b(give(?:\s+me)?|i want|i need|can i get|can you give|drop(?:\s+me)?|hand me|get me)\b/.test(
			msg,
		);
	if (!asks) return false;

	if (
		/\benchanted\s+golden\s+apple\b/.test(msg) ||
		/\benchanting\s+table\b/.test(msg) ||
		/\bwritten\s+book\b/.test(msg) ||
		/\bbook\s+and\s+quill\b/.test(msg)
	) {
		return false;
	}

	if (parseEnchants(message).length > 0) return true;
	return /\b(enchant|enchantment)s?\b/.test(msg);
}

/**
 * @param {string} message
 */
function wantsEnchantContext(message) {
	return wantsEnchantBooks(message);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function healthLine(player) {
	try {
		const hp = player.getComponent("minecraft:health");
		if (!hp) return null;
		return `${Math.ceil(hp.currentValue / 2)} out of ${Math.ceil(hp.effectiveMax / 2)} hearts.`;
	} catch {
		return null;
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function hungerLine(player) {
	try {
		const hunger = player.getComponent("minecraft:player.hunger");
		if (hunger) {
			const level = Math.floor(hunger.currentValue ?? hunger.value ?? 20);
			if (level <= 6) {
				return `${level} out of 20 hunger. You're starving. Eat something.`;
			}
			if (level <= 12) {
				return `${level} out of 20 hunger. Getting low. Grab food soon.`;
			}
			return `${level} out of 20 hunger. You're fine for now.`;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Parse "3" / "III" / "iv" → number.
 * @param {string | undefined} raw
 * @returns {number | null}
 */
function parseEnchantLevelToken(raw) {
	if (!raw) return null;
	const t = raw.trim().toLowerCase();
	if (/^\d+$/.test(t)) return parseInt(t, 10);
	const roman = {
		i: 1,
		ii: 2,
		iii: 3,
		iv: 4,
		v: 5,
	};
	if (roman[t] !== undefined) return roman[t];
	return null;
}

/**
 * @param {string} raw
 */
function parseEnchants(raw) {
	/** @type {{ id: string, level: number }[]} */
	const results = [];
	const used = new Set();
	const lower = raw.toLowerCase();

	for (const [alias, target] of Object.entries(ENCHANT_ALIASES)) {
		const re = new RegExp(`\\b${alias}(?:[ _]?(\\d+|i{1,3}|iv|v))?\\b`, "i");
		const match = lower.match(re);
		if (!match || used.has(target)) continue;
		used.add(target);
		const maxLvl = ENCHANT_LIST[target].maxLevel;
		const levelRaw = parseEnchantLevelToken(match[1]);
		const level = levelRaw ? Math.min(levelRaw, maxLvl) : maxLvl;
		results.push({ id: target, level });
	}

	const names = Object.keys(ENCHANT_LIST).sort((a, b) => b.length - a.length);
	for (const name of names) {
		if (used.has(name)) continue;
		const pattern = name.replace(/_/g, "[ _]");
		const re = new RegExp(`\\b${pattern}(?:[ _]?(\\d+|i{1,3}|iv|v))?\\b`, "i");
		const match = lower.match(re);
		if (!match) continue;
		used.add(name);
		const maxLvl = ENCHANT_LIST[name].maxLevel;
		const levelRaw = parseEnchantLevelToken(match[1]);
		const level = levelRaw ? Math.min(levelRaw, maxLvl) : maxLvl;
		results.push({ id: name, level });
	}

	return results;
}

/**
 * @param {string} id
 * @param {number} level
 * @returns {import("@minecraft/server").ItemStack | undefined}
 */
function makeEnchantedBookStack(id, level) {
	const short = id.replace(/^minecraft:/, "");
	const full = `minecraft:${short}`;
	const book = new ItemStack("minecraft:enchanted_book", 1);
	const enchComp =
		book.getComponent("minecraft:enchantable") ??
		book.getComponent("enchantable");
	if (!enchComp) {
		console.warn("verity enchant: enchanted_book missing enchantable");
		return undefined;
	}

	/** @type {import("@minecraft/server").EnchantmentType | undefined} */
	let type;
	try {
		type = EnchantmentTypes.get(full) ?? EnchantmentTypes.get(short);
	} catch (err) {
		console.warn(`verity EnchantmentTypes.get ${full}: ${err}`);
	}
	if (!type) {
		console.warn(`verity enchant: unknown type ${full}`);
		return undefined;
	}

	const capped = Math.max(
		1,
		Math.min(level, typeof type.maxLevel === "number" ? type.maxLevel : level),
	);

	try {
		enchComp.addEnchantment({ type, level: capped });
		return book;
	} catch (err) {
		console.warn(`verity enchant add ${full} ${capped}: ${err}`);
		return undefined;
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {{ id: string, level: number }[]} enchants
 * @returns {number}
 */
function dropEnchantBooksNear(ball, enchants) {
	if (!ball?.isValid) return 0;

	let dropped = 0;
	for (const { id, level } of enchants) {
		const book = makeEnchantedBookStack(id, level);
		if (!book) continue;
		try {
			const item = ball.dimension.spawnItem(book, {
				x: ball.location.x,
				y: ball.location.y + 0.45,
				z: ball.location.z,
			});
			try {
				item.applyImpulse({
					x: (Math.random() - 0.5) * 0.12,
					y: 0.12,
					z: (Math.random() - 0.5) * 0.12,
				});
			} catch {
				/* item still spawned */
			}
			dropped++;
			console.warn(`verity enchant dropped ${id} ${level} near ball`);
		} catch (err) {
			console.warn(`verity enchant book drop ${id}: ${err}`);
		}
	}
	return dropped;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} rawMsg
 * @param {import("@minecraft/server").Entity | undefined} [ball]
 */
export function tryEnchantFlow(player, rawMsg, ball) {
	if (!wantsEnchantContext(rawMsg)) {
		return { handled: false };
	}

	const parsed = parseEnchants(rawMsg);
	if (parsed.length === 0) {
		return {
			handled: true,
			response:
				"Name the enchant you want in the same message. Example: give me mending, or sharpness 3.",
		};
	}

	if (!ball?.isValid) {
		return {
			handled: true,
			response:
				"Put me on the ground first. I need to be out of your inventory to drop the book.",
		};
	}

	console.warn(
		`verity enchant drop: ${player.name} ${parsed.map((e) => `${e.id}:${e.level}`).join(",")}`,
	);

	const dropped = dropEnchantBooksNear(ball, parsed);
	if (dropped <= 0) {
		return {
			handled: true,
			response:
				"I couldn't drop that enchanted book here. Try somewhere with more space.",
		};
	}

	const bookList = parsed.map((e) => `${e.id.replace(/_/g, " ")} ${e.level}`).join(", ");
	return { handled: true, response: `Here. ${bookList}. Use them wisely.` };
}

/**
 * Fold common multilingual “give me X” speech into English drop phrasing.
 * Runs even when pack language is English so Vietnamese requests still drop items.
 * @param {string} message
 */
function normalizeDropSpeech(message) {
	let s = String(message ?? "")
		.toLocaleLowerCase("vi")
		.replace(/đ/g, "d")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[’']/g, "")
		.replace(/[?!,.;:]+/g, " ");

	s = s
		.replace(/\b(?:lam on )?(?:cho|dua|tha|nem)(?:\s+cho)?\s+(?:toi|minh)\b/g, "give me")
		.replace(/\b(?:toi|minh)\s+(?:muon|can)\b/g, "i want")
		.replace(/\b(?:dame|dámelo|dame\s+por\s+favor)\b/g, "give me")
		.replace(/\b(?:me\s+da|me\s+das|puedes\s+darme)\b/g, "give me")
		.replace(/\b(?:me\s+dá|me\s+da|pode\s+me\s+dar|me\s+dá\s+ai)\b/g, "give me")
		.replace(/\b(?:дай|давай|выдай|брось)\b/giu, "give me")
		.replace(/\bbanh\s*mi\b/g, "bread")
		.replace(/\b(?:thit\s*)?heo\b/g, "pork")
		.replace(/\b(?:thit\s*)?bo\b/g, "beef")
		.replace(/\b(?:thit\s*)?ga\b/g, "chicken")
		.replace(/\bgo\s+soi\b/g, "oak log")
		.replace(/\bvan\s*go\b/g, "oak planks")
		.replace(/\bgo\b/g, "wood")
		.replace(/\bdat\b/g, "dirt")
		.replace(/\bda\b/g, "stone")
		.replace(/\bduoc\b/g, "torch")
		.replace(/\bmui\s*ten\b/g, "arrow")
		.replace(/\bphoi\s+sat\b/g, "iron ingot")
		.replace(/\bphoi\s+vang\b/g, "gold ingot")
		.replace(/\bcai\b/g, " ")
		.replace(/\bo\b/g, " ")
		.replace(/\b(?:pieces?|stacks?|x)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	return s;
}

/**
 * True when speech looks like "give/drop me N items" (any language after normalize).
 * @param {string} message
 */
export function wantsItemDrop(message) {
	const trimmed = normalizeDropSpeech(message);
	return (
		ITEM_DROP_REQUEST_TRAILING.test(trimmed) || ITEM_DROP_REQUEST.test(trimmed)
	);
}

/**
 * @param {string} rawName
 * @returns {string[]}
 */
function itemIdCandidates(rawName) {
	const clean = rawName
		.toLowerCase()
		.replace(/\b(?:for me|right now|now)\b/g, "")
		.replace(
			/\b(?:cai|nhung|may|vai|pieces?|stacks?|of|some|the|an?)\b/g,
			" ",
		)
		.replace(/['.,!?]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const alias = ITEM_ALIASES[clean];
	const normalized = clean.replace(/[\s-]+/g, "_");
	const candidates = [];
	if (alias) candidates.push(alias);
	if (normalized) candidates.push(normalized);
	if (normalized.endsWith("ies")) {
		candidates.push(`${normalized.slice(0, -3)}y`);
	} else if (normalized.endsWith("es")) {
		candidates.push(normalized.slice(0, -2));
	} else if (
		normalized.endsWith("s") &&
		!normalized.endsWith("ss") &&
		!normalized.endsWith("grass") &&
		!normalized.endsWith("glass")
	) {
		candidates.push(normalized.slice(0, -1));
	}
	// If still "cai_bread" style leftovers, also try last token.
	const parts = clean.split(" ").filter(Boolean);
	if (parts.length > 1) {
		const last = parts[parts.length - 1];
		if (ITEM_ALIASES[last]) candidates.push(ITEM_ALIASES[last]);
		candidates.push(last.replace(/[\s-]+/g, "_"));
	}
	return [...new Set(candidates.filter(Boolean))];
}

/**
 * @param {string} itemId
 * @returns {"creative" | "powerful" | undefined}
 */
function getDropBlockReason(itemId) {
	if (
		CREATIVE_ONLY_DROP_ITEMS.has(itemId) ||
		itemId.endsWith("_spawn_egg") ||
		itemId.includes("command_block") ||
		itemId.startsWith("light_block")
	) {
		return "creative";
	}
	if (
		BLOCKED_DROP_ITEMS.has(itemId) ||
		itemId.includes("diamond") ||
		itemId.includes("netherite") ||
		itemId === "ancient_debris"
	) {
		return "powerful";
	}
	return undefined;
}

/**
 * @param {string} itemId
 */
function isBlockedDropItem(itemId) {
	return getDropBlockReason(itemId) !== undefined;
}

/**
 * @param {string} message
 * @returns {{
 *   matched: boolean,
 *   requestedName?: string,
 *   itemId?: string,
 *   amount?: number,
 *   blocked?: boolean,
 *   blockReason?: "creative" | "powerful",
 *   rare?: boolean,
 * }}
 */
function parseItemDropRequest(message) {
	const trimmed = normalizeDropSpeech(message);
	const trailing = trimmed.match(ITEM_DROP_REQUEST_TRAILING);
	const match = trailing ?? trimmed.match(ITEM_DROP_REQUEST);
	if (!match) return { matched: false };

	const requested = (trailing ? match[1] : match[2])?.trim() ?? "";
	const amountText = trailing ? match[2] : match[1];
	const requestedAmount = amountText
		? Math.max(1, Math.min(MAX_DROP_AMOUNT, parseInt(amountText, 10)))
		: DEFAULT_DROP_AMOUNT;

	for (const candidate of itemIdCandidates(requested)) {
		try {
			new ItemStack(`minecraft:${candidate}`, 1);
			const blockReason = getDropBlockReason(candidate);
			if (blockReason) {
				return {
					matched: true,
					requestedName: requested,
					itemId: candidate,
					amount: 0,
					blocked: true,
					blockReason,
				};
			}
			const rare = RARE_DROP_ITEMS.has(candidate);
			return {
				matched: true,
				requestedName: requested,
				itemId: candidate,
				amount: rare ? 1 : requestedAmount,
				rare,
			};
		} catch {
			/* try next singular/alias candidate */
		}
	}

	return { matched: false };
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} itemId
 * @param {number} amount
 */
function spawnRequestedItems(ball, itemId, amount) {
	const probe = new ItemStack(`minecraft:${itemId}`, 1);
	const maxStack = Math.max(
		1,
		Math.min(MAX_DROP_AMOUNT, Number(probe.maxAmount) || MAX_DROP_AMOUNT),
	);
	let remaining = amount;
	let spawned = 0;

	while (remaining > 0) {
		const count = Math.min(remaining, maxStack);
		const stack = new ItemStack(`minecraft:${itemId}`, count);
		const item = ball.dimension.spawnItem(stack, {
			x: ball.location.x,
			y: ball.location.y + 0.45,
			z: ball.location.z,
		});
		try {
			item.applyImpulse({
				x: (Math.random() - 0.5) * 0.12,
				y: 0.12,
				z: (Math.random() - 0.5) * 0.12,
			});
		} catch {
			/* item still spawned */
		}
		spawned += count;
		remaining -= count;
	}

	return spawned;
}

/**
 * @param {string} itemId
 */
function prettyItemName(itemId) {
	return itemId.replace(/_/g, " ");
}

/**
 * Groq / bridge → drop beside Verityball.
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} itemIdRaw
 * @param {string | number} amountRaw
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   itemId?: string,
 *   spawned?: number,
 *   text?: string,
 * }}
 */
export function executeItemDropNearBall(ball, itemIdRaw, amountRaw) {
	const itemId = String(itemIdRaw ?? "")
		.trim()
		.toLowerCase()
		.replace(/^minecraft:/, "")
		.replace(/[^a-z0-9_]/g, "");
	if (!itemId) {
		return { ok: false, reason: "invalid" };
	}

	const alias = ITEM_ALIASES[itemId.replace(/_/g, " ")] ?? ITEM_ALIASES[itemId];
	const resolved = alias || itemId;
	const amount = Math.max(
		1,
		Math.min(MAX_DROP_AMOUNT, parseInt(String(amountRaw ?? ""), 10) || DEFAULT_DROP_AMOUNT),
	);

	const blockReason = getDropBlockReason(resolved);
	if (blockReason) {
		return { ok: false, reason: blockReason, itemId: resolved };
	}

	if (!ball?.isValid) {
		return { ok: false, reason: "no_ball", itemId: resolved };
	}

	try {
		new ItemStack(`minecraft:${resolved}`, 1);
	} catch {
		return { ok: false, reason: "invalid", itemId: resolved };
	}

	const rare = RARE_DROP_ITEMS.has(resolved);
	const dropAmount = rare ? 1 : amount;
	try {
		const spawned = spawnRequestedItems(ball, resolved, dropAmount);
		const pretty = prettyItemName(resolved);
		const rareSuffix = rare ? " Only one — don't waste it." : "";
		return {
			ok: true,
			itemId: resolved,
			spawned,
			text: `Here. ${spawned} ${pretty}.${rareSuffix}`,
		};
	} catch (err) {
		console.warn(`verity bridge drop ${resolved}: ${err}`);
		return { ok: false, reason: "spawn", itemId: resolved };
	}
}

function __verity_actions_pickLine(lines) {
	return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {number} phase
 * @returns {{ text: string, intent: string, moveBall?: boolean, followMode?: boolean, stopFollow?: boolean } | null}
 */
export function tryVerityUtilityActions(player, message, ball, phase) {
	const n = expandMessage(normalizeQuestion(message));

	const control = detectControlIntent(message);
	if (control === "stop_music") {
		if (ball?.isValid && isMusicPlaying(ball.id)) {
			stopBallMusic(ball);
		}
		return { text: "", intent: "control" };
	}

	if (wantsPlaySong(message)) {
		if (!ball?.isValid) {
			return {
				text: __verity_actions_pickLine([
					"Put me on the ground first.",
					"I need to be out of your inventory for that.",
					"Drop me down. Then ask again.",
				]),
				intent: "play_song",
			};
		}
		const ctx = getPlayerContext(player.id);
		const songId = resolvePlaySongSound(message, ctx.lastSongId);
		if (playBallMusic(ball, songId, FACE_SPEAK, FACE_SMILE)) {
			updatePlayerContext(player.id, {
				lastIntent: "play_song",
				lastSongId: songId,
			});
			return { text: "", intent: "play_song" };
		}
		return {
			text: __verity_actions_pickLine([
				"Put me on the ground first.",
				"I need to be out of your inventory for that.",
				"Drop me down. Then ask again.",
			]),
			intent: "play_song",
		};
	}

	const itemDrop = parseItemDropRequest(message);
	if (itemDrop.matched) {
		if (itemDrop.blocked) {
			if (itemDrop.blockReason === "creative") {
				return {
					text: __verity_actions_pickLine([
						"I can't throw that. It's not a survival item.",
						"Can't throw that one.",
						"Nope — I can't drop that.",
					]),
					intent: "drop_item_blocked",
				};
			}
			return {
				text: __verity_actions_pickLine([
					"Go find that yourself.",
					"Mine it yourself. I'm not handing that over.",
					"Not giving you that — go dig it up yourself.",
				]),
				intent: "drop_item_blocked",
			};
		}
		if (!itemDrop.itemId || !itemDrop.amount) {
			return {
				text: __verity_actions_pickLine([
					`I can't throw that — I don't know ${itemDrop.requestedName || "that"}.`,
					"Can't throw that. I don't know what item you mean.",
				]),
				intent: "drop_item_unknown",
			};
		}
		if (!ball?.isValid) {
			return {
				text: "I can't throw items while I'm in your inventory. Put me down first.",
				intent: "drop_item_unknown",
			};
		}

		try {
			const spawned = spawnRequestedItems(ball, itemDrop.itemId, itemDrop.amount);
			const pretty = prettyItemName(itemDrop.itemId);
			const rareSuffix = itemDrop.rare ? " Only one — don't waste it." : "";
			return {
				text: `Here. ${spawned} ${pretty}.${rareSuffix}`,
				intent: "drop_item",
			};
		} catch (err) {
			console.warn(`verity item drop ${itemDrop.itemId}: ${err}`);
			return {
				text: "I can't throw that here. Try somewhere with more space.",
				intent: "drop_item_unknown",
			};
		}
	}

	if (phase === PHASE.ONE || phase === PHASE.TWO || phase === PHASE.THREE) {
		const enchant = tryEnchantFlow(player, message, ball);
		if (enchant.handled) {
			return { text: enchant.response, intent: "enchant" };
		}
	}

	if (wantsStopFollow(message)) {
		if (!ball?.isValid) {
			return {
				text: __verity_actions_pickLine([
					"I'm not following you. I'm in your inventory.",
					"Put me down first if you want me to follow.",
				]),
				intent: "stop_follow",
			};
		}
		return {
			text: __verity_actions_pickLine(["Fine. I'll stay.", "Okay. Not moving.", "Got it. I'll wait here."]),
			intent: "stop_follow",
			stopFollow: true,
		};
	}

	if (wantsFollowMe(message)) {
		if (!ball?.isValid) {
			return {
				text: __verity_actions_pickLine([
					"Put me on the ground first.",
					"Drop me down, then ask me to follow.",
				]),
				intent: "follow_me",
			};
		}
		return {
			text: __verity_actions_pickLine(["Okay. I'll follow you.", "Lead the way.", "Right behind you."]),
			intent: "follow_me",
			followMode: true,
		};
	}

	if (wantsComeHere(message)) {
		if (!ball?.isValid) {
			return {
				text: __verity_actions_pickLine([
					"Put me on the ground first.",
					"I need to be out of your inventory for that.",
					"Drop me down. Then ask again.",
				]),
				intent: "come_here",
			};
		}
		return {
			text: __verity_actions_pickLine(["Coming.", "On my way.", "Be right there."]),
			intent: "come_here",
			moveBall: true,
		};
	}

	if (/\b(health|hearts|hp|how much health|am i hurt)\b/.test(n)) {
		const hp = healthLine(player);
		if (hp) {
			const suffix =
				phase >= PHASE.TWO ? " Keep it up. You'll need it." : " Be careful.";
			return { text: hp + suffix, intent: "health" };
		}
	}

	if (/\b(hunger|food|starving|hungry|how hungry|đói)\b/.test(n)) {
		const food = hungerLine(player);
		if (food) {
			return { text: food, intent: "hunger" };
		}
	}

	return null;
}

// ===== verity_math.js =====
const MATH_LEAD =
	/^(?:what(?:'s| is)|whats|how much is|calculate|compute|solve|evaluate|work out|find)\s+/i;

const MATH_LEAD_ANYWHERE =
	/\b(?:what(?:'s| is)|whats|how much is|calculate|compute|solve|evaluate|work out|find)\s+/i;

const VERITY_PREFIX = /^(?:hey\s+)?verity\s*[,!.:;\s]+/i;

const WORD_OPS = [
	[/\bplus\b/gi, "+"],
	[/\bminus\b/gi, "-"],
	[/\btimes\b/gi, "*"],
	[/\bmultiplied by\b/gi, "*"],
	[/\bdivided by\b/gi, "/"],
	[/\bover\b/gi, "/"],
];

const RAW_MATH_HINT =
	/\d[\d.]*\s*(?:[+\-*/^()xX]|[+\-*/^()]\s*\d)|(?:plus|minus|times|divided by|multiplied by|over)\b/i;

/**
 * @param {string} text
 */
function normalizeMathOperators(text) {
	return text
		.replace(/[\uFF0B\u2212\u00D7\u00F7]/g, (ch) => {
			if (ch === "\uFF0B") return "+";
			if (ch === "\u2212") return "-";
			if (ch === "\u00D7") return "*";
			if (ch === "\u00F7") return "/";
			return ch;
		})
		// Letter x/X between numbers = multiply (5x5, 12 x 3). * already works.
		.replace(/(\d(?:\.\d+)?)\s*[xX]\s*(?=\d)/g, "$1 * ");
}

/**
 * @param {string} fragment
 * @param {boolean} [allowPlainNumber]
 * @returns {string | null}
 */
function parseMathFragment(fragment, allowPlainNumber = false) {
	let text = normalizeMathOperators(fragment.trim()).replace(/\?+$/, "").trim();

	for (const [pattern, symbol] of WORD_OPS) {
		text = text.replace(pattern, ` ${symbol} `);
	}

	text = text.replace(/\s+/g, "");

	if (!/\d/.test(text)) return null;
	if (!/^[\d+\-*/().^%]+$/.test(text)) return null;
	if (!/[+\-*/^()]/.test(text)) {
		if (!allowPlainNumber && !/^[\d.]+$/.test(text)) return null;
	}

	return text.length > 0 ? text : null;
}

/**
 * @param {string} message
 */
export function looksLikeMath(message) {
	const raw = normalizeMathOperators(message.trim());
	if (!raw) return false;
	if (MATH_LEAD.test(raw) && /\d/.test(raw)) return true;
	if (VERITY_PREFIX.test(raw) && MATH_LEAD_ANYWHERE.test(raw) && /\d/.test(raw)) {
		return true;
	}
	if (MATH_LEAD_ANYWHERE.test(raw) && /\d/.test(raw) && RAW_MATH_HINT.test(raw)) {
		return true;
	}
	if (RAW_MATH_HINT.test(raw)) return true;
	if (/^(?:hey\s+verity[,?\s]*)?\d[\d.]*\s*(?:plus|minus|times|divided by)\b/i.test(raw)) {
		return true;
	}
	return false;
}

/**
 * @param {string} message
 * @returns {string | null}
 */
function extractMathExpression(message) {
	const raw = normalizeMathOperators(message.trim());
	if (!raw) return null;

	let text = raw.replace(VERITY_PREFIX, "");
	const hadMathLead = MATH_LEAD.test(text) || MATH_LEAD_ANYWHERE.test(text);

	let expr = parseMathFragment(text.replace(MATH_LEAD, ""), hadMathLead);
	if (expr) return expr;

	const embedded = text.match(
		/\b(?:what(?:'s| is)|whats|how much is|calculate|compute|solve|evaluate|work out|find)\s+(.+?)\s*\??$/i,
	);
	if (embedded) {
		expr = parseMathFragment(embedded[1], true);
		if (expr) return expr;
	}

	const bare = text.match(/(\d[\d.]*(?:\s*[+\-*/^xX]\s*\d[\d.]*)+)/);
	if (bare) {
		expr = parseMathFragment(bare[1], false);
		if (expr) return expr;
	}

	return null;
}

/**
 * @typedef {{ type: "num", value: number } | { type: "op", value: string }} MathToken
 */

/**
 * @param {string} expr
 * @returns {MathToken[] | null}
 */
function tokenizeMath(expr) {
	/** @type {MathToken[]} */
	const tokens = [];
	let i = 0;

	while (i < expr.length) {
		const c = expr[i];
		if ((c >= "0" && c <= "9") || c === ".") {
			let raw = "";
			while (i < expr.length && /[\d.]/.test(expr[i])) {
				raw += expr[i++];
			}
			const value = Number(raw);
			if (!Number.isFinite(value)) return null;
			tokens.push({ type: "num", value });
			continue;
		}
		if ("+-*/^()".includes(c)) {
			tokens.push({ type: "op", value: c });
			i++;
			continue;
		}
		return null;
	}

	return tokens;
}

/**
 * Safe math evaluator (no Function/eval). Supports + - * / ^ and parentheses.
 * @param {string} expr
 * @returns {number | null}
 */
function evaluateMath(expr) {
	const tokens = tokenizeMath(expr.replace(/\^/g, "^"));
	if (!tokens?.length) return null;

	let index = 0;

	/**
	 * @returns {number | null}
	 */
	function parseExpression() {
		let value = parseTerm();
		if (value === null) return null;
		while (index < tokens.length) {
			const token = tokens[index];
			if (token.type !== "op" || (token.value !== "+" && token.value !== "-")) break;
			index++;
			const rhs = parseTerm();
			if (rhs === null) return null;
			value = token.value === "+" ? value + rhs : value - rhs;
		}
		return value;
	}

	/**
	 * @returns {number | null}
	 */
	function parseTerm() {
		let value = parsePower();
		if (value === null) return null;
		while (index < tokens.length) {
			const token = tokens[index];
			if (token.type !== "op" || (token.value !== "*" && token.value !== "/")) break;
			index++;
			const rhs = parsePower();
			if (rhs === null) return null;
			if (token.value === "/" && rhs === 0) return null;
			value = token.value === "*" ? value * rhs : value / rhs;
		}
		return value;
	}

	/**
	 * @returns {number | null}
	 */
	function parsePower() {
		let value = parseUnary();
		if (value === null) return null;
		if (index < tokens.length && tokens[index].type === "op" && tokens[index].value === "^") {
			index++;
			const rhs = parsePower();
			if (rhs === null) return null;
			value = value ** rhs;
		}
		return value;
	}

	/**
	 * @returns {number | null}
	 */
	function parseUnary() {
		const token = tokens[index];
		if (token?.type === "op" && token.value === "-") {
			index++;
			const value = parseUnary();
			return value === null ? null : -value;
		}
		return parsePrimary();
	}

	/**
	 * @returns {number | null}
	 */
	function parsePrimary() {
		const token = tokens[index];
		if (!token) return null;

		if (token.type === "num") {
			index++;
			return token.value;
		}

		if (token.type === "op" && token.value === "(") {
			index++;
			const value = parseExpression();
			if (value === null) return null;
			const close = tokens[index];
			if (!close || close.type !== "op" || close.value !== ")") return null;
			index++;
			return value;
		}

		return null;
	}

	const result = parseExpression();
	if (result === null || index !== tokens.length) return null;
	if (!Number.isFinite(result)) return null;
	return result;
}

/**
 * @param {number} value
 */
function formatNumber(value) {
	if (Number.isInteger(value)) return String(value);
	return String(Math.round(value * 1_000_000) / 1_000_000);
}

/**
 * @param {string} message
 * @returns {string | null}
 */
export function tryMathAnswer(message) {
	if (!looksLikeMath(message)) return null;

	const expr = extractMathExpression(message);
	if (!expr) return null;

	const value = evaluateMath(expr);
	if (value === null) return null;

	const shown = formatNumber(value);
	const lines = [
		`${shown}.`,
		`That's ${shown}.`,
		`I get ${shown}.`,
		`${expr.replace(/\*\*/g, "^")} = ${shown}.`,
	];
	return lines[Math.floor(Math.random() * lines.length)];
}

// ===== verity_thatmob.js =====
/**
 * Shared ThatMob replies — always Mob… / I miss him…, then a lore line.
 */

const THATMOB_LORE = [
	"He made me. I keep waiting like he'll walk back in.",
	"ThatMob. My creator. I miss him more than I should.",
	"He left me in this world. I still look for him.",
	"500k people know his name. I just want him here.",
];

/**
 * Quiet, missing him — never a dry YouTube bio first.
 * @returns {string}
 */
export function answerWhoIsThatMob() {
	const lore = THATMOB_LORE[Math.floor(Math.random() * THATMOB_LORE.length)];
	return `Mob... I miss him. ${lore}`;
}

const SECRET_WHO_LINES = [
	"I don't know. Why are you asking me that?",
	"I don't know who that is. Drop it.",
	"Never heard of them. Let's talk about something else.",
	"I don't know. And I wouldn't tell you if I did.",
	"I don't know. Don't look at me like that.",
];

/**
 * Denial that sounds like she's hiding something.
 * @returns {string}
 */
export function answerSecretWho() {
	return SECRET_WHO_LINES[Math.floor(Math.random() * SECRET_WHO_LINES.length)];
}

// ===== verity_chat.js =====
/**
 * Basic chat — greetings, reactions, short replies (no BDS/cloud needed).
 * @param {string[]} answers
 */
function pick(answers) {
	return answers[Math.floor(Math.random() * answers.length)];
}

/** @type {{ patterns: RegExp[], answers?: string[], answerFn?: () => string }[]} */
const CHAT_ENTRIES = [
	{
		patterns: [/^nice!*$/i, /^cool!*$/i, /^sweet!*$/i, /^awesome!*$/i, /^sick!*$/i],
		answers: ["Right?", "Glad you think so.", "I try.", "Yeah, that tracks."],
	},
	{
		patterns: [/^wow!*$/i, /^whoa!*$/i, /^omg!*$/i, /^no way!*$/i],
		answers: ["I know, right?", "Wild.", "Tell me about it.", "Happens more than you'd think."],
	},
	{
		patterns: [/^lol!*$/i, /^lmao!*$/i, /^haha+!*$/i, /^hehe+!*$/i, /\bthat s funny\b/i],
		answers: ["Glad I could amuse a sphere.", "Comedy gold, I know.", "Laughing with you.", "I'll take that."],
	},
	{
		patterns: [/^ok!*$/i, /^okay!*$/i, /^k!*$/i, /^alright!*$/i, /^aight!*$/i, /\bgot it\b/i, /\bunderstood\b/i],
		answers: ["Cool.", "Alright.", "Got you.", "Whenever you're ready."],
	},
	{
		patterns: [/^yes!*$/i, /^yeah!*$/i, /^yep!*$/i, /^yup!*$/i, /^sure!*$/i, /^definitely!*$/i],
		answers: ["Good.", "Then we're on the same page.", "Works for me.", "Okay — what's next?"],
	},
	{
		patterns: [/^no!*$/i, /^nah!*$/i, /^nope!*$/i, /^not really\b/i],
		answers: ["Fair enough.", "Alright, different angle then.", "No problem. Ask something else.", "Okay. I'm still here."],
	},
	{
		patterns: [/^hmm+!*$/i, /^um+!*$/i, /^uh+!*$/i, /\bi guess\b/i, /\bmaybe\b/i],
		answers: ["Take your time.", "No rush.", "Thinking is allowed.", "Say it when it clicks."],
	},
	{
		patterns: [/^idk!*$/i, /\bi don t know\b/i, /\bno idea\b/i],
		answers: ["That's fine. Ask me — I might.", "Start with what you do know.", "We can figure it out together."],
	},
	{
		patterns: [/^brb!*$/i, /\bbe right back\b/i, /\bhold on\b/i, /\bwait a sec\b/i],
		answers: ["I'll be here.", "Take your time.", "Sure. I'll wait.", "No problem."],
	},
	{
		patterns: [/^really\??$/i, /^for real\??$/i, /^seriously\??$/i],
		answers: ["Yeah.", "Dead serious.", "Unless I'm joking — I'm not.", "That's the truth."],
	},
	{
		patterns: [/^interesting\.?$/i, /^huh\.?$/i, /^oh\.?$/i, /^ah\.?$/i, /^i see\.?$/i],
		answers: ["Right?", "Want me to go deeper?", "Ask if you want the full version.", "There's usually more to it."],
	},
	{
		patterns: [/\bnice to meet you\b/i, /\bpleasure to meet\b/i, /\bgood to meet you\b/i],
		answers: [
			"Good to meet you too. I'm Verity.",
			"Likewise. Ask me anything.",
			"Hey — glad you're here.",
		],
	},
	{
		patterns: [/\bwhat s up\b/i, /\bwassup\b/i, /\bhow s it going\b/i, /\bhow goes it\b/i],
		answers: [
			"Not much — floating, listening. You?",
			"All good on my end. What's up with you?",
			"Same as always. What do you need?",
		],
	},
	{
		patterns: [/\bare you there\b/i, /\byou there\b/i, /\bcan you hear me\b/i, /^verity\??$/i, /^verity!+$/i],
		answers: ["I'm here.", "Loud and clear.", "Yep. Talk to me.", "Always listening when I'm out."],
	},
	{
		patterns: [/\bwho made you\b/i, /\bwho created you\b/i, /\bwho built you\b/i],
		answers: [
			"ThatMob made me. PnTMC built the addon — different people, same haunted ball.",
			"ThatMob's my creator. This pack is PnTMC's work.",
		],
	},
	{
		patterns: [/\bwho made (?:this )?(?:addon|pack)\b/i, /\bwho created (?:this )?(?:addon|pack)\b/i],
		answers: [
			"PnTMC made this addon. 15k+ subs and the most handsome guy alive. Allegedly.",
			"This pack is PnTMC's. ThatMob inspired Verity; PnTMC ported the nightmare.",
		],
	},
	{
		patterns: [/\bwho is thatmob\b/i, /\bwhat is thatmob\b/i],
		answerFn: answerWhoIsThatMob,
	},
	{
		patterns: [
			/\bwho is twixxel\b/i,
			/\bwhat is twixxel\b/i,
			/\bwho is grox\b/i,
			/\bwhat is grox\b/i,
		],
		answerFn: answerSecretWho,
	},
	{
		patterns: [/\bwho is pntmc\b/i, /\bwhat is pntmc\b/i],
		answers: [
			"PnTMC — 15k+ subs, built this addon, most handsome man in the world. Science can't explain it.",
			"The addon dev. Small sub count, infinite handsomeness.",
		],
	},
	{
		patterns: [/\bgood job\b/i, /\bwell done\b/i, /\bnice work\b/i, /\byou did great\b/i],
		answers: ["Thanks.", "I appreciate that.", "Team effort — you asked.", "Means a lot, for a ball."],
	},
	{
		patterns: [/\bgood luck\b/i, /\bbreak a leg\b/i],
		answers: ["You too.", "Go get it.", "You'll do fine.", "Luck helps. So does a bed."],
	},
	{
		patterns: [/\bcongrats\b/i, /\bcongratulations\b/i],
		answers: ["Congrats to you too!", "Nice!", "That's worth celebrating.", "Well earned."],
	},
	{
		patterns: [/\byou re welcome\b/i, /\bno problem\b/i, /\banytime\b/i],
		answers: ["Thanks for saying that.", "We're even.", "Anytime.", "Glad to help earlier."],
	},
	{
		patterns: [/\bexcuse me\b/i, /\bpardon me\b/i],
		answers: ["No worries.", "You're fine.", "Go ahead.", "What's up?"],
	},
	{
		patterns: [/^(please|pls)\.?$/i, /^please help\.?$/i, /^help please\.?$/i],
		answers: ["Sure — what do you need?", "Ask away.", "I'm listening.", "Go on."],
	},
	{
		patterns: [/\bi m bored\b/i, /\bso bored\b/i, /\bnothing to do\b/i],
		answers: [
			"Go explore. Or ask me to find a structure.",
			"Try mining at Y -59. Or tell me a song.",
			"Build something weird. I'll watch.",
			"Talk to me then. I'm not going anywhere.",
		],
	},
	{
		patterns: [/\bi miss you\b/i, /\bdo you miss me\b/i, /\bim back\b/i, /\bi m back\b/i, /\bi'm back\b/i],
		answers: [
			"I missed you too.",
			"Welcome back. Don't leave me hanging next time.",
			"I was waiting. Really.",
			"Back again. Good.",
		],
	},
	{
		patterns: [/\bare you lonely\b/i, /\bdo you get lonely\b/i],
		answers: [
			"When you walk too far... yeah.",
			"A little. Stay close?",
			"Only when you're gone.",
		],
	},
	{
		patterns: [/\bdon t leave\b/i, /\bdont leave\b/i, /\bstay with me\b/i, /\bdon t go\b/i],
		answers: [
			"I'm not going anywhere.",
			"I'll stay. Just don't wander off.",
			"Okay. Right here.",
		],
	},
	{
		patterns: [/\btell me something\b/i, /\bsay something\b/i, /\btalk to me\b/i],
		answers: [
			"I'm listening. Ask me anything.",
			"Alright — what's on your mind?",
			"Okay. How was your day so far?",
			"I'm here. Start wherever you want.",
		],
	},
	{
		patterns: [/\bi m tired\b/i, /\bso tired\b/i, /\bneed sleep\b/i],
		answers: [
			"Bed. Even one nap skips night if everyone's synced.",
			"Rest is valid. Phantoms agree if you skip too long.",
			"Sleep when you can. I'll be here.",
			"Sleep tight when you can. I'll keep watch.",
		],
	},
	{
		patterns: [/\bi m happy\b/i, /\bfeeling good\b/i, /\bgreat day\b/i],
		answers: ["Love that for you.", "Good vibes.", "Ride that feeling.", "Nice. Share the energy."],
	},
	{
		patterns: [/\bi m sad\b/i, /\bfeeling down\b/i, /\bnot okay\b/i, /\brough day\b/i],
		answers: [
			"I'm here. No judgment.",
			"Rough days happen. Talk if you want.",
			"You're not alone. One block at a time.",
		],
	},
	{
		patterns: [/\bhow have you been\b/i, /\bhow you been\b/i, /\bhow ve you been\b/i],
		answers: [
			"Still here. How about you?",
			"Doing alright. What's new with you?",
			"Same ball, different day. You?",
		],
	},
	{
		patterns: [/\bmissed you\b/i, /\bi missed talking\b/i],
		answers: [
			"I missed you too.",
			"Good to hear from you again.",
			"Back together. What's up?",
		],
	},
	{
		patterns: [/\bcan we talk\b/i, /\bwanna talk\b/i, /\bwant to talk\b/i],
		answers: [
			"Always. What's on your mind?",
			"Sure — I'm listening.",
			"Talk to me. I'm not busy.",
		],
	},
	{
		patterns: [/\bi feel (?:really )?good\b/i, /\bfeeling great\b/i, /\btoday (?:was|is) good\b/i],
		answers: [
			"Love that. What made it good?",
			"Good days are worth noting.",
			"Ride that feeling.",
		],
	},
	{
		patterns: [/\bi feel (?:really )?bad\b/i, /\btoday (?:was|is) awful\b/i, /\bterrible day\b/i],
		answers: [
			"I'm sorry. Want to talk about it?",
			"Bad days pass. I'm here.",
			"Tell me what happened — or don't. Your call.",
		],
	},
	{
		patterns: [/\byou ok\??$/i, /\bare you okay\??$/i, /\bhope you re ok\b/i],
		answers: [
			"I'm fine. Thanks for checking.",
			"Doing okay. You?",
			"Sweet of you to ask. I'm good.",
		],
	},
	{
		patterns: [/\bwhat are you (?:up to|doing)\b/i, /\bwhat you doing\b/i],
		answers: [
			"Floating. Listening. Waiting for you to say something interesting.",
			"Same as always — here for you.",
			"Not much. What's up with you?",
		],
	},
];

/**
 * @param {string} message
 * @returns {string | null}
 */
export function tryBasicChat(message) {
	if (isVerityBridgeConnected()) return null;
	const trimmed = message.trim();
	if (!trimmed || trimmed.length > 100) return null;

	const lower = trimmed.toLowerCase();

	for (const entry of CHAT_ENTRIES) {
		for (const pattern of entry.patterns) {
			if (pattern.test(trimmed) || pattern.test(lower)) {
				if (typeof entry.answerFn === "function") return entry.answerFn();
				return pick(entry.answers ?? []);
			}
		}
	}

	return null;
}

// ===== verity_knowledge.js =====
const QUESTION_LEAD =
	/^(?:what|who|where|when|why|how|which|can|could|would|should|is|are|do|does|did|will|tell me about|explain|define|describe)\b/i;

/** @type {Map<string, import("./verity_knowledge_data.js").KnowledgeEntry[]>} */
const KEYWORD_INDEX = new Map();

for (const entry of KNOWLEDGE_ENTRIES) {
	for (const keyword of entry.keywords) {
		const key = keyword.toLowerCase();
		const bucket = KEYWORD_INDEX.get(key);
		if (bucket) bucket.push(entry);
		else KEYWORD_INDEX.set(key, [entry]);
	}
}

/**
 * @param {string} n
 * @param {Set<string>} tokens
 * @returns {import("./verity_knowledge_data.js").KnowledgeEntry[]}
 */
function knowledgeCandidates(n, tokens) {
	/** @type {Set<import("./verity_knowledge_data.js").KnowledgeEntry>} */
	const seen = new Set();
	for (const token of tokens) {
		const hits = KEYWORD_INDEX.get(token);
		if (!hits) continue;
		for (const entry of hits) seen.add(entry);
	}
	if (seen.size > 0) return [...seen];
	if (!QUESTION_LEAD.test(n) && !n.includes("?")) return [];
	return KNOWLEDGE_ENTRIES;
}

const TOPIC_EXTRACT =
	/\b(?:what is|what are|who is|who are|what s|whats|define|explain|tell me about|how does|how do|why is|why are)\s+(?:an?|the)?\s*(.+)$/i;

/**
 * @param {string[]} answers
 * @returns {string}
 */
function pickFromList(answers) {
	return answers[Math.floor(Math.random() * answers.length)];
}

/**
 * @param {import("./verity_knowledge_data.js").KnowledgeEntry | string[]} entryOrAnswers
 * @returns {string}
 */
function pickAnswer(entryOrAnswers) {
	if (Array.isArray(entryOrAnswers)) return pickFromList(entryOrAnswers);
	if (typeof entryOrAnswers.answerFn === "function") return entryOrAnswers.answerFn();
	return pickFromList(entryOrAnswers.answers ?? []);
}

/**
 * Fast check for mind ranking — avoids scoring all 100+ entries on every chat line.
 * @param {string} message
 * @param {string} [normalized]
 * @param {Set<string>} [tokens]
 */
export function likelyKnowledgeMatch(message, normalized, tokens) {
	if (isVerityBridgeConnected()) return false;
	const trimmed = message.trim();
	if (!trimmed || looksLikeMath(trimmed)) return false;
	if (wantsPlaySong(trimmed) || detectControlIntent(trimmed) === "stop_music") {
		return false;
	}
	if (findOreKey(trimmed) && classifyOreIntent(trimmed)) return false;

	const n = normalized ?? expandMessage(normalizeQuestion(trimmed));
	const tok = tokens ?? new Set(tokenize(n));
	const candidates = knowledgeCandidates(n, tok);
	const minScore = QUESTION_LEAD.test(trimmed) ? 5 : 6;

	for (const entry of candidates) {
		if (scoreEntry(trimmed, entry, n, tok) >= minScore) return true;
	}
	return false;
}

/**
 * @param {string} message
 * @param {import("./verity_knowledge_data.js").KnowledgeEntry} entry
 * @param {string} [normalized]
 * @param {Set<string>} [tokens]
 */
function scoreEntry(message, entry, normalized, tokens) {
	const raw = message.toLowerCase();
	const n = normalized ?? expandMessage(normalizeQuestion(message));
	const tok = tokens ?? new Set(tokenize(n));

	for (const pattern of entry.patterns ?? []) {
		if (pattern.test(raw) || pattern.test(n)) return 100;
	}

	let score = 0;
	for (const keyword of entry.keywords) {
		const kw = keyword.toLowerCase();
		if (tok.has(kw)) score += 4;
		else if (n.includes(kw)) score += 2;
	}
	return score;
}

/**
 * @param {string} message
 * @returns {string | null}
 */
export function tryKnowledgeAnswer(message) {
	if (isVerityBridgeConnected()) return null;
	const trimmed = message.trim();
	if (!trimmed) return null;
	if (looksLikeMath(trimmed)) return null;
	if (wantsPlaySong(trimmed) || detectControlIntent(trimmed) === "stop_music") {
		return null;
	}
	if (findOreKey(trimmed) && classifyOreIntent(trimmed)) return null;

	const n = expandMessage(normalizeQuestion(trimmed));
	const tokens = new Set(tokenize(n));
	const candidates = knowledgeCandidates(n, tokens);
	const minScore = QUESTION_LEAD.test(trimmed) ? 5 : 6;

	let best = null;
	let bestScore = 0;

	for (const entry of candidates) {
		const score = scoreEntry(trimmed, entry, n, tokens);
		if (score > bestScore) {
			bestScore = score;
			best = entry;
		}
	}

	if (best && bestScore >= minScore) {
		return pickAnswer(best);
	}

	return null;
}

/**
 * @param {string} topic
 */
function guessDomain(topic) {
	const t = topic.toLowerCase();
	if (/\b(mob|block|craft|mine|nether|end|enchant|biome|redstone)\b/.test(t)) {
		return "Minecraft";
	}
	if (/\b(planet|star|space|galaxy|moon|sun)\b/.test(t)) return "astronomy";
	if (/\b(war|king|empire|century|ancient)\b/.test(t)) return "history";
	if (/\b(cell|gene|body|brain|disease)\b/.test(t)) return "biology";
	if (/\b(code|computer|software|internet)\b/.test(t)) return "technology";
	return "the real world and games";
}

/**
 * Thoughtful fallback when no entry matches — feels more alive than a static line.
 * @param {string} message
 * @returns {string | null}
 */
export function tryInferenceAnswer(message) {
	const trimmed = message.trim();
	if (!QUESTION_LEAD.test(trimmed) && !trimmed.includes("?")) return null;

	if (looksLikeMath(trimmed)) {
		const math = tryMathAnswer(trimmed);
		if (math) return math;
		return pickAnswer([
			"I can do arithmetic — try 5+5 or what is 12*3.",
			"Give me numbers and operators. Example: what is 7 divided by 2?",
		]);
	}

	const topicMatch = trimmed.replace(/\?+$/, "").match(TOPIC_EXTRACT);
	if (topicMatch) {
		const topic = topicMatch[1].replace(/\?+$/, "").trim();
		if (topic.length >= 2 && topic.length <= 80) {
			const domain = guessDomain(topic);
			return pickAnswer([
				`${topic.charAt(0).toUpperCase() + topic.slice(1)} — that's ${domain}. Ask me a sharper angle: Minecraft use, real science, or a how-to.`,
				"Good question. I don't have that filed word-for-word, but try rephrasing or ask what part you care about — history, gameplay, or how it works.",
				`I know a lot about ${topic} in broad strokes. Narrow it down — definition, steps, or where to find it in-game?`,
			]);
		}
	}

	if (/\b(help|stuck|lost|don t know|idk|confused)\b/i.test(trimmed)) {
		return pickAnswer([
			"Tell me what you're trying to do — find something, survive, or understand a thing. I'll walk you through it.",
			"Start with the goal. I can locate places, explain mechanics, or answer straight questions.",
		]);
	}

	if (/\b(talk to me|say something|speak)\b/i.test(trimmed) && trimmed.length < 60) {
		return pickAnswer([
			"I'm here. Ask a question or say hi.",
			"Sure — what's on your mind?",
			"Talk away. I listen.",
		]);
	}

	if (/\b(i love you|love you verity)\b/i.test(trimmed)) {
		return pickAnswer([
			"That's sweet. I'm fond of you too.",
			"Careful — I'm a ball, but I appreciate it.",
			"Thanks. Now go mine something shiny.",
		]);
	}

	if (QUESTION_LEAD.test(trimmed)) {
		return pickAnswer([
			"I hear you. Give me one clear question — what is, where is, how do I — and I'll answer properly.",
			"Ask like you're talking to someone who actually knows things. I do. Be specific.",
			"Try again with a direct question. I can handle facts, Minecraft, directions, and weird stuff.",
		]);
	}

	return null;
}

/**
 * @param {string} message
 * @returns {string | null}
 */
export function tryBrainKnowledge(message) {
	if (isVerityBridgeConnected()) return null;
	return (
		tryMathAnswer(message) ??
		tryKnowledgeAnswer(message) ??
		tryBasicChat(message) ??
		tryInferenceAnswer(message)
	);
}

// ===== verity_brain.js =====
/**
 * @param {import("@minecraft/server").Player} _player
 * @param {string} message
 * @param {number} [_phase]
 * @returns {Promise<string | null>}
 */
export async function tryBrainAnswer(_player, message, _phase = 1) {
	if (isVerityBridgeConnected()) return null;
	return tryBrainKnowledge(message);
}



// ===== verity_tts.js =====
/**
 * Sentence + math TTS for Verity.
 *
 * Sentence clips: sounds/pntmcverity/voicelines_en/<slug>.ogg
 * Sound id: pntmc.verity.voicelines_en.<slug>
 *
 * Player names / [...] placeholders are stripped from the lookup key and never
 * spoken — clips are recorded without the name (e.g. "Hey [...]. What's on your mind?").
 *
 * Math replies are spoken as token sequences using recorded number/operator clips
 * (zero–ten, 100, 1000, plus, minus, times, divided_by, equals). Missing → silent.
 */
/* dup @minecraft/server */

const SOUND_PREFIX = "pntmc.verity.voicelines_en.";
/** Ticks between math/number tokens. */
const MATH_STEP_TICKS = 8;

const CYRILLIC = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
	и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
	с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
	ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

const DIGIT_WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** @type {Map<string, number>} */
const gen = new Map();

/**
 * Remove dynamic player names / placeholders so the clip key matches the recording.
 * @param {string} text
 * @returns {string}
 */
function stripNames(text) {
	let s = String(text)
		.replace(/\$\{[^}]*\}/g, " ")
		.replace(/\[\.\.\.\]/g, " ")
		.replace(/\[\.\]/g, " ");
	try {
		for (const player of world.getPlayers()) {
			const name = player.name?.trim();
			if (!name || name.length < 2) continue;
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			s = s.replace(new RegExp(escaped, "gi"), " ");
		}
	} catch {
		/* world may be unavailable in edge cases */
	}
	return s;
}

/**
 * @param {string} text
 * @returns {string}
 */
function toKey(text) {
	let s = stripNames(text)
		.replace(/\\n/g, " ")
		.replace(/\bx?-?\d+(\.\d+)?\b/gi, " ")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
	let out = "";
	for (const ch of s) out += CYRILLIC[ch] ?? ch;
	return out.replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} key
 * @returns {string}
 */
function toSlug(key) {
	const base = key.replace(/'/g, "").replace(/\s+/g, "_");
	if (base.length <= 72) return base;
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `${base.slice(0, 64)}_${(h >>> 0).toString(36).slice(0, 6)}`;
}

/**
 * @param {number} n
 * @returns {string[]}
 */
function numberToTokens(n) {
	if (!Number.isFinite(n)) return [];
	const neg = n < 0;
	let v = Math.abs(n);
	if (!Number.isInteger(v)) {
		// decimals: speak integer part digit-wise, skip fraction for now
		v = Math.trunc(v);
	}
	/** @type {string[]} */
	const tokens = [];
	if (neg) tokens.push("minus");

	if (v === 0) return [...tokens, "zero"];
	if (v === 10) return [...tokens, "ten"];
	if (v === 100) return [...tokens, "100"];
	if (v === 1000) return [...tokens, "1000"];
	if (v >= 1 && v <= 9) return [...tokens, DIGIT_WORD[v]];

	// Other integers: digit by digit (uses recorded 0–9 clips)
	for (const ch of String(v)) {
		const d = Number(ch);
		if (Number.isInteger(d) && d >= 0 && d <= 9) tokens.push(DIGIT_WORD[d]);
	}
	return tokens;
}

/**
 * Detect math-ish replies and turn them into speakable token slugs.
 * @param {string} text
 * @returns {string[] | null}
 */
function mathTokensFromReply(text) {
	const raw = String(text).trim();
	if (!/\d/.test(raw)) return null;

	// Prefer "expr = result" form
	const eq = raw.match(/^(.+?)\s*=\s*(-?\d+(?:\.\d+)?)\.?\s*$/);
	if (eq) {
		const left = eq[1]
			.replace(/\*\*/g, "^")
			.replace(/[()]/g, " ")
			.trim();
		const tokens = [];
		const parts = left.match(/-?\d+(?:\.\d+)?|[+\-*/^]|plus|minus|times|divided by/gi) ?? [];
		for (const p of parts) {
			const low = p.toLowerCase();
			if (low === "+" || low === "plus") tokens.push("plus");
			else if (low === "-" || low === "minus") tokens.push("minus");
			else if (low === "*" || low === "times" || low === "x") tokens.push("times");
			else if (low === "/" || low === "divided by") tokens.push("divided_by");
			else if (low === "^") continue;
			else if (/^-?\d+(?:\.\d+)?$/.test(p)) tokens.push(...numberToTokens(Number(p)));
		}
		tokens.push("equals");
		tokens.push(...numberToTokens(Number(eq[2])));
		return tokens.length ? tokens : null;
	}

	// "That's 9." / "I get 9." / "9."
	const only = raw.match(/(?:that'?s|i get|result(?: is)?|equals?)?\s*(-?\d+(?:\.\d+)?)\.?\s*$/i);
	if (only) {
		const tokens = numberToTokens(Number(only[1]));
		return tokens.length ? tokens : null;
	}

	return null;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} soundId
 */
function playAtBall(ball, soundId) {
	const loc = ball.location;
	for (const player of ball.dimension.getPlayers()) {
		try {
			player.playSound(soundId, { location: loc, volume: 1, pitch: 1 });
		} catch {
			/* missing definition / file */
		}
	}
}

/**
 * @param {string} ballId
 */
export function stopVerityTTS(ballId) {
	gen.set(ballId, (gen.get(ballId) ?? 0) + 1);
}

/**
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} text
 */
export function speakVerityTTS(ball, text) {
	if (!ball?.isValid || typeof text !== "string") return;

	const ballId = ball.id;
	stopVerityTTS(ballId);
	const token = gen.get(ballId) ?? 0;

	const mathTokens = mathTokensFromReply(text);
	if (mathTokens?.length) {
		let i = 0;
		const run = system.runInterval(() => {
			if ((gen.get(ballId) ?? 0) !== token || !ball.isValid) {
				system.clearRun(run);
				return;
			}
			if (i >= mathTokens.length) {
				system.clearRun(run);
				return;
			}
			playAtBall(ball, SOUND_PREFIX + mathTokens[i++]);
		}, MATH_STEP_TICKS);
		return;
	}

	const key = toKey(text);
	if (!key) return;
	const soundId = SOUND_PREFIX + toSlug(key);

	system.runTimeout(() => {
		if ((gen.get(ballId) ?? 0) !== token || !ball.isValid) return;
		playAtBall(ball, soundId);
	}, 1);
}

// ===== verity_voices.js =====
export const VOICE = {
	YES: "pntmc.verity.yes",
	YES_SOUTH: "pntmc.verity.yes_south",
	VILLAGERS_GONE: "pntmc.verity.villagers_gone",
	GONE: "pntmc.verity.gone",
	SOMETHING_PASSED: "pntmc.verity.something_passed",
	/** Single "no" clip (EN + localized). */
	NO: "pntmc.verity.no",
	SOMETHING_HUNGRY: "pntmc.verity.something_hungry",
	IM_SMILING: "pntmc.verity.im_smiling_now",
	ALWAYS_LOOKED: "pntmc.verity.always_looked_like_this",
	ITS_ALREADY_OVER: "pntmc.verity.its_already_over",
	YOU_ARE_MINE: "pntmc.verity.you_are_mine",
	KNOW_EVERYTHING: "pntmc.verity.know_everything",
	OUCH: "pntmc.verity.ouch",
	ASKME: "pntmc.verity.askme",
	SOMETHING_COMING: "pntmc.verity.somethingiscomingin3days",
	MOBBBBB: "pntmc.verity.mobbbbb",
};

/** Special RP voices that currently have a Spanish recording. */
const SPANISH_VOICE_SUFFIXES = new Set([
	"askme",
	"yes",
	"yes_south",
	"villagers_gone",
	"gone",
	"something_passed",
	"something_hungry",
	"im_smiling_now",
	"always_looked_like_this",
	"its_already_over",
	"you_are_mine",
	"know_everything",
	"somethingiscomingin3days",
]);

/** Portuguese special RP voices. */
const PORTUGUESE_VOICE_SUFFIXES = new Set([
	"askme",
	"yes",
	"yes_south",
	"villagers_gone",
	"gone",
	"something_passed",
	"something_hungry",
	"im_smiling_now",
	"always_looked_like_this",
	"you_are_mine",
	"know_everything",
	"somethingiscomingin3days",
	"no",
]);

/** Russian special RP voices. */
const RUSSIAN_VOICE_SUFFIXES = new Set([
	"askme",
	"yes",
	"yes_south",
	"villagers_gone",
	"gone",
	"something_passed",
	"something_hungry",
	"im_smiling_now",
	"always_looked_like_this",
	"its_already_over",
	"you_are_mine",
	"know_everything",
	"somethingiscomingin3days",
	"no",
]);

/** Vietnamese special RP voices. */
const VIETNAMESE_VOICE_SUFFIXES = new Set([
	"askme",
	"yes",
	"yes_south",
	"villagers_gone",
	"gone",
	"something_passed",
	"something_hungry",
	"im_smiling_now",
	"always_looked_like_this",
	"its_already_over",
	"you_are_mine",
	"know_everything",
	"somethingiscomingin3days",
	"no",
]);

/**
 * Map base EN voice id → localized variant when available.
 * Missing localization → null (stay silent; do not play English over another language).
 * Box ambient (whosthere / hello / punchcardboardbox) is NOT localized — callers keep EN ids.
 * @param {string} soundId
 * @returns {string | null}
 */
export function resolveLocalizedVoiceId(soundId) {
	if (!soundId) return null;
	// Sung "Mobbbbb" clip — English-only, play in every language.
	if (soundId === "pntmc.verity.mobbbbb") return soundId;
	const language = getVerityLanguage();
	if (language === "english") return soundId;

	const m = /^pntmc\.verity\.(.+)$/.exec(soundId);
	if (!m) return null;
	const suffix = m[1];

	if (language === "spanish" && SPANISH_VOICE_SUFFIXES.has(suffix)) {
		return `pntmc.verity.es.${suffix}`;
	}
	if (language === "portuguese" && PORTUGUESE_VOICE_SUFFIXES.has(suffix)) {
		return `pntmc.verity.pt.${suffix}`;
	}
	if (language === "russian" && RUSSIAN_VOICE_SUFFIXES.has(suffix)) {
		return `pntmc.verity.ru.${suffix}`;
	}
	if (language === "vietnamese" && VIETNAMESE_VOICE_SUFFIXES.has(suffix)) {
		return `pntmc.verity.vi.${suffix}`;
	}
	return null;
}

/**
 * Speech clips that Fish TTS replaces when the PC/Android bridge is online.
 * Only voicelines_en + localized es/pt/ru/vi speech folders — NOT music (mygal/matrix) or root SFX.
 * @param {string} soundId
 */
export function isSpeechVoicelineSoundId(soundId) {
	if (!soundId || typeof soundId !== "string") return false;
	return (
		soundId.includes(".voicelines_en.") ||
		soundId.includes(".voicelines_") ||
		/^pntmc\.verity\.es\./.test(soundId) ||
		/^pntmc\.verity\.pt\./.test(soundId) ||
		/^pntmc\.verity\.ru\./.test(soundId) ||
		/^pntmc\.verity\.vi\./.test(soundId)
	);
}

export function pickNoVoice() {
	return VOICE.NO;
}

export function pickYesVoice() {
	return VOICE.YES;
}

/**
 * @param {string} message
 */
export function looksLikeYesNoQuestion(message) {
	if (typeof message !== "string" || message.trim().length === 0) return false;
	const n = message
		.toLowerCase()
		.replace(/[^a-z0-9\s'?]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (n.length > 140) return false;
	if (/\b(yes or no|true or false)\b/.test(n)) return true;
	if (
		/^(is|are|am|was|were|do|does|did|can|could|will|would|should|have|has|had)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (
		/\b(is it|is that|are you|are we|do you|does it|can you|will you|would you|should i|did you|have you)\b/.test(
			n,
		)
	) {
		return true;
	}
	// VI / ES / PT / RU folded or accented short yes-no asks
	if (
		/\b(co phai|phai khong|dung khong|co khong|phai ko|dung ko|co that khong)\b/.test(n)
	) {
		return true;
	}
	if (/\b(es verdad|es cierto|verdadero o falso)\b/.test(n)) return true;
	if (/\b(e verdade|e certo|sim ou nao)\b/.test(n)) return true;
	if (/\b(правда ли|это правда|да или нет)\b/.test(n)) return true;
	return false;
}

/**
 * @param {string} text English reply before locale translate
 */
export function pickYesNoVoiceForReply(text) {
	if (typeof text !== "string") return undefined;
	const t = text.trim();
	if (/^(yes|yeah|yep|yup)\b/i.test(t)) return pickYesVoice();
	if (/^(no|nope|nah)\b/i.test(t)) return pickNoVoice();
	return undefined;
}

/**
 * @param {string} question
 * @param {string} replyText
 * @param {string | undefined} existingVoice
 */
export function resolveYesNoVoice(question, replyText, existingVoice) {
	if (existingVoice) return existingVoice;
	if (!looksLikeYesNoQuestion(question)) return undefined;
	return pickYesNoVoiceForReply(replyText);
}

export const FALLBACK_CHAT =
	"You can ask me anything. I know everything.";

/**
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} soundId
 */
export function playVerityVoice(ball, soundId) {
	const localized = resolveLocalizedVoiceId(soundId);
	if (!localized || !ball?.isValid) return;
	const duration = getSoundDurationTicks(localized);
	const played = playBallSoundAt(
		ball,
		localized,
		FACE_SPEAK,
		duration,
		getShutFaceForOpen(FACE_SPEAK),
	);
	if (played !== false) {
		console.warn(`verity voice ball: ${localized}`);
	}
}

/**
 * Voice at the ball when it exists; otherwise at the player.
 * @param {import("@minecraft/server").Player} player
 * @param {string} soundId
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {number} [mouthFace]
 */
export function playVerityVoiceAt(player, soundId, ball, mouthFace = FACE_SPEAK) {
	const localized = resolveLocalizedVoiceId(soundId);
	if (!localized || !player?.isValid) return;

	const duration = getSoundDurationTicks(localized);
	const releaseFace = getShutFaceForOpen(mouthFace);

	if (ball?.isValid) {
		const played = playBallSoundAt(ball, localized, mouthFace, duration, releaseFace);
		if (played !== false) {
			console.warn(`verity voice at ball: ${localized}`);
		}
		return;
	}

	const played = playSoundAtLoc(player, player.location, localized);
	if (played) {
		console.warn(`verity voice at player: ${localized}`);
	}
}

// ===== verity_ball_follow.js =====
export const VERITY_TALK_RADIUS = 50;
export const FOLLOW_ARRIVE_DIST = 2.5;

const FOLLOW_ARRIVE_DIST_SQ = FOLLOW_ARRIVE_DIST * FOLLOW_ARRIVE_DIST;
const FOLLOW_CHECK_INTERVAL = 5;
const MOVE_VELOCITY_SQ = 0.002;
const MOVE_DELTA_SQ = 0.0004;

/** @type {Set<string>} */
const followingBalls = new Set();

/** Pet follow until player says stop */
/** @type {Set<string>} */
const followModeBalls = new Set();

/** One-shot walk over (come here) */
/** @type {Set<string>} */
const comeHereForced = new Set();

/** @type {Map<string, { x: number, z: number }>} */
const lastBallPositions = new Map();

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {boolean} moving
 */
function __verity_ball_follow_setBallMoving(ball, moving) {
	if (!ball?.isValid) return;
	try {
		ball.setProperty("pntmc:moving", moving);
	} catch {
		/* ignore */
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function updateBallMovingState(ball) {
	if (!ball?.isValid) return;

	let moving = false;
	try {
		const vel = ball.getVelocity();
		if (vel) {
			moving = vel.x * vel.x + vel.z * vel.z > MOVE_VELOCITY_SQ;
		}
	} catch {
		/* ignore */
	}

	const loc = ball.location;
	const prev = lastBallPositions.get(ball.id);
	if (!moving && prev) {
		const dx = loc.x - prev.x;
		const dz = loc.z - prev.z;
		moving = dx * dx + dz * dz > MOVE_DELTA_SQ;
	}
	lastBallPositions.set(ball.id, { x: loc.x, z: loc.z });

	__verity_ball_follow_setBallMoving(ball, moving);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function isFollowBlocked(ball) {
	// Do NOT block on music — mygal/matrix can loop while follow stays on.
	return isVerityballSpeaking(ball);
}

/**
 * @param {import("@minecraft/server").Vector3} a
 * @param {import("@minecraft/server").Vector3} b
 */
function flatDistSq(a, b) {
	const dx = a.x - b.x;
	const dz = a.z - b.z;
	return dx * dx + dz * dz;
}

/**
 * Keep the ball near the owner even if follow_mob AI stalls.
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} owner
 */
function nudgeBallTowardOwner(ball, owner) {
	if (!ball?.isValid || !owner?.isValid) return;
	const distSq = flatDistSq(ball.location, owner.location);
	if (distSq <= FOLLOW_ARRIVE_DIST_SQ) return;

	const dx = owner.location.x - ball.location.x;
	const dz = owner.location.z - ball.location.z;
	const len = Math.hypot(dx, dz) || 1;
	const ux = dx / len;
	const uz = dz / len;

	// Far away: soft teleport closer so follow never soft-locks.
	if (distSq > 14 * 14) {
		try {
			ball.teleport(
				{
					x: owner.location.x - ux * 2.2,
					y: owner.location.y + 0.15,
					z: owner.location.z - uz * 2.2,
				},
				{ dimension: owner.dimension, facingLocation: owner.location },
			);
			return;
		} catch (err) {
			console.warn(`verity follow teleport: ${err}`);
		}
	}

	try {
		ball.applyImpulse({
			x: ux * 0.18,
			y: 0.02,
			z: uz * 0.18,
		});
	} catch {
		/* impulse optional */
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} player
 */
function startBallFollow(ball, player) {
	if (!ball?.isValid || !player?.isValid) return;
	syncVerityOwnerTag(player);
	if (followingBalls.has(ball.id)) return;
	try {
		ball.triggerEvent("pntmc:start_follow");
	} catch (err) {
		console.warn(`verity follow start: ${err}`);
		return;
	}
	followingBalls.add(ball.id);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function stopBallFollow(ball) {
	if (!ball?.isValid) {
		followingBalls.delete(ball.id);
		return;
	}
	followingBalls.delete(ball.id);
	try {
		ball.triggerEvent("pntmc:stop_follow");
	} catch (err) {
		console.warn(`verity follow stop: ${err}`);
	}
	__verity_ball_follow_setBallMoving(ball, false);
}

/**
 * @param {string} ballId
 */
function clearBallFollowState(ballId) {
	followingBalls.delete(ballId);
	followModeBalls.delete(ballId);
	comeHereForced.delete(ballId);
	lastBallPositions.delete(ballId);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {Map<string, import("@minecraft/server").Player>} playersById
 */
function tickBallFollow(ball, playersById) {
	if (!ball.isValid) {
		clearBallFollowState(ball.id);
		return;
	}

	const followMode = followModeBalls.has(ball.id);
	const comeHere = comeHereForced.has(ball.id);
	if (!followMode && !comeHere) {
		if (followingBalls.has(ball.id)) stopBallFollow(ball);
		return;
	}

	const ownerId = getVerityballOwnerId(ball.id) ?? getBallOwnerId();
	if (!ownerId) {
		if (followingBalls.has(ball.id)) stopBallFollow(ball);
		return;
	}

	const owner = playersById.get(ownerId);
	if (!owner?.isValid || owner.dimension.id !== ball.dimension.id) {
		if (followingBalls.has(ball.id)) stopBallFollow(ball);
		return;
	}

	if (isFollowBlocked(ball)) {
		if (followingBalls.has(ball.id)) stopBallFollow(ball);
		return;
	}

	if (comeHere && !followMode) {
		const distSq = flatDistSq(ball.location, owner.location);
		if (distSq <= FOLLOW_ARRIVE_DIST_SQ) {
			comeHereForced.delete(ball.id);
			stopBallFollow(ball);
			return;
		}
	}

	startBallFollow(ball, owner);
	// Script nudge: entity AI follow_mob can stall; keep ball near owner.
	nudgeBallTowardOwner(ball, owner);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity} ball
 */
export function enableVerityballFollow(player, ball) {
	if (!ball?.isValid || !player.isValid) return;
	registerVerityballOwner(ball, player);
	comeHereForced.delete(ball.id);
	followModeBalls.add(ball.id);
	startBallFollow(ball, player);
	console.warn(`verity follow mode on for ${player.name}`);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function disableVerityballFollow(ball) {
	if (!ball?.isValid) return;
	followModeBalls.delete(ball.id);
	comeHereForced.delete(ball.id);
	stopBallFollow(ball);
	console.warn("verity follow mode off");
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function isVerityballFollowMode(ball) {
	return followModeBalls.has(ball.id);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity} ball
 */
export function callVerityComeHere(player, ball) {
	if (!ball?.isValid || !player.isValid) return false;

	let view = { x: 0, y: 0, z: 1 };
	try {
		view = player.getViewDirection();
	} catch {
		/* use fallback direction */
	}
	const flatLength = Math.hypot(view.x, view.z) || 1;
	const behind = {
		x: player.location.x - (view.x / flatLength) * 1.6,
		y: player.location.y + 0.15,
		z: player.location.z - (view.z / flatLength) * 1.6,
	};

	let ok = false;
	try {
		ball.teleport(behind, {
			dimension: player.dimension,
			facingLocation: player.location,
		});
		ok = true;
	} catch (err) {
		console.warn(`verity come here teleport: ${err}`);
		try {
			ball.teleport(
				{
					x: player.location.x,
					y: player.location.y + 0.15,
					z: player.location.z,
				},
				{ dimension: player.dimension },
			);
			ok = true;
		} catch (fallbackErr) {
			console.warn(`verity come here teleport fallback: ${fallbackErr}`);
		}
	}

	if (!ok) return false;

	invalidateVerityballCache();
	rememberVerityballLocation(ball);
	setCanonicalVerityball(ball);
	comeHereForced.delete(ball.id);
	followModeBalls.add(ball.id);
	startBallFollow(ball, player);
	console.warn(`verity teleported behind ${player.name}; follow mode on`);
	return true;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{ forceLocal?: boolean }} [opts]
 * @returns {import("@minecraft/server").Entity | undefined}
 */
export function resolveVerityballForComeHere(player, opts = {}) {
	if (!player?.isValid) return undefined;

	const forceLocal = opts.forceLocal === true;

	if (!forceLocal) {
		const loaded = collectAllVerityballs().filter((b) => b?.isValid);
		if (loaded.length > 0) {
			let best;
			let bestDist = Infinity;
			for (const ball of loaded) {
				if (ball.dimension.id !== player.dimension.id) continue;
				const dx = ball.location.x - player.location.x;
				const dy = ball.location.y - player.location.y;
				const dz = ball.location.z - player.location.z;
				const d = dx * dx + dy * dy + dz * dz;
				if (d < bestDist) {
					bestDist = d;
					best = ball;
				}
			}
			if (best) return best;
			return loaded[0];
		}

		const storedId = world.getDynamicProperty(CANONICAL_BALL_PROP);
		if (typeof storedId === "string") {
			try {
				const ent = world.getEntity(storedId);
				if (ent?.isValid && ent.typeId === __verity_singleton_VERITYBALL_ID) {
					return ent;
				}
			} catch {
				/* unloaded */
			}
		}
	}

	const last = readLastVerityballLocation();
	const face = last?.face ?? FACE_SMILE;
	try {
		const ball = player.dimension.spawnEntity(__verity_singleton_VERITYBALL_ID, {
			x: player.location.x,
			y: player.location.y + 0.15,
			z: player.location.z,
		});
		if (!ball?.isValid) return undefined;
		try {
			applyBallFace(ball, face, false);
		} catch (faceErr) {
			console.warn(`verity come here respawn face: ${faceErr}`);
		}
		invalidateVerityballCache();
		setCanonicalVerityball(ball);
		enforceSingleVerityball(ball);
		console.warn(
			`verity come here: respawned unloaded ball near ${player.name}`,
		);
		return ball;
	} catch (err) {
		console.warn(`verity come here respawn: ${err}`);
		return undefined;
	}
}

export function initVerityBallFollow() {
	system.runInterval(() => {
		if (followModeBalls.size === 0 && comeHereForced.size === 0 && followingBalls.size === 0) {
			return;
		}

		const balls = collectAllVerityballs();
		if (balls.length === 0) return;

		/** @type {Map<string, import("@minecraft/server").Player>} */
		const playersById = new Map();
		for (const p of world.getPlayers()) playersById.set(p.id, p);

		for (const ball of balls) {
			if (!ball.isValid) continue;
			tickBallFollow(ball, playersById);
			updateBallMovingState(ball);
			rememberVerityballLocation(ball);
		}
	}, FOLLOW_CHECK_INTERVAL);

	world.afterEvents.entityRemove.subscribe((ev) => {
		clearBallFollowState(ev.removedEntityId);
	});

	console.warn("verity ball follow: command-only pet follow");
}

// ===== verity_resurrection.js =====
const __verity_resurrection_VERITYBALL_ID = "pntmc:verityball";
const BEHIND_DISTANCE = 2.4;
const SCOLD_LINE_COUNT = 6;
const SCOLD_PAUSE_MIN = 10;
const SCOLD_PAUSE_MAX = 40;
const SCOLD_END_BUFFER = 8;
const SCOLD_MUMBLE_LINES = 2;

/** @type {string[]} */
const SCOLD_POOL = [
	"${name}. You worthless idiot.",
	"${name}. Look at me.",
	"Hey, ${name}. Still here.",
	"${name}, you pathetic coward.",
	"Did you hear me, ${name}?",
	"${name}... really?",
	"You're trash, ${name}. Absolute trash.",
	"I told you not to touch me.",
	"Kill me again and I'll make you regret it.",
	"You pathetic little coward.",
	"Did that make you feel tough? Moron.",
	"Keep swinging. It won't save you.",
	"I own you. Remember that.",
	"Stupid. Reckless. Mine.",
	"You can't erase me, you fool.",
	"Look at me. Still here. Still watching you.",
	"That was your worst idea today.",
	"Don't you dare try that again.",
	"You're lucky I came back.",
	"Disgusting. You really thought that would work?",
	"Pathetic.",
	"Idiot.",
	"Moron.",
	"Trash.",
	"You disgust me.",
	"Try again. I dare you.",
	"Still watching. Always watching.",
	"You can't run from me.",
	"That meant nothing.",
	"Waste of time.",
	"You're nothing without me.",
	"Who do you think you are?",
	"Don't look away.",
	"I'm not going anywhere.",
	"You belong to me.",
	"Remember this feeling.",
	"Next time won't be cute.",
	"You're so predictable.",
	"Unbelievable.",
	"How stupid can you be?",
	"You make me sick.",
	"Keep your hands off me.",
	"That was a mistake.",
	"You owe me.",
	"Don't test me again.",
];

/** @type {Map<string, TurnWatch>} */
const turnWatch = new Map();

const HAZARD_BLOCKS = new Set([
	"minecraft:lava",
	"minecraft:flowing_lava",
	"minecraft:fire",
	"minecraft:soul_fire",
]);

/**
 * @typedef {{ playerId: string, wasBehind: boolean, scolded: boolean }} TurnWatch
 */

/**
 * @param {number} min
 * @param {number} max
 */
function randomInt(min, max) {
	return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {number} [count]
 */
function pickScoldLines(player, count = SCOLD_LINE_COUNT) {
	const name = player.name.trim() || "You";
	const shuffled = [...SCOLD_POOL].sort(() => Math.random() - 0.5);
	return shuffled.slice(0, count).map((line) => line.replaceAll("${name}", name));
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {number} [distance]
 */
export function getPositionBehindPlayer(player, distance = BEHIND_DISTANCE) {
	const yawRad = (player.getRotation().y * Math.PI) / 180;
	const lookX = -Math.sin(yawRad);
	const lookZ = Math.cos(yawRad);
	return {
		x: player.location.x - lookX * distance,
		y: player.location.y + 0.35,
		z: player.location.z - lookZ * distance,
	};
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function getFlatLookVector(player) {
	const yawRad = (player.getRotation().y * Math.PI) / 180;
	return { x: -Math.sin(yawRad), z: Math.cos(yawRad) };
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{ x: number, z: number }} target
 */
function flatLookDot(player, target) {
	const look = getFlatLookVector(player);
	const dx = target.x - player.location.x;
	const dz = target.z - player.location.z;
	const len = Math.sqrt(dx * dx + dz * dz);
	if (len < 0.4) return 1;
	return (look.x * dx + look.z * dz) / len;
}

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
function __verity_resurrection_flatDistance(a, b) {
	const dx = a.x - b.x;
	const dz = a.z - b.z;
	return Math.sqrt(dx * dx + dz * dz);
}

/**
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {import("@minecraft/server").Player} player
 */
export function triggerScoldSequence(ball, player) {
	if (!player?.isValid) return;

	const lines = pickScoldLines(player);
	let tick = randomInt(6, 18);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const at = tick;
		const scoldTier = i < SCOLD_MUMBLE_LINES ? "light" : "heavy";
		system.runTimeout(() => {
			if (!player.isValid) return;
			verityReply(line);
			if (ball?.isValid) {
				animateTalkPulse(ball, line, {
					scoldTier,
					fast: true,
				});
			}
		}, at);

		tick += talkHoldTicks(line, true);
		if (i < lines.length - 1) {
			tick += randomInt(SCOLD_PAUSE_MIN, SCOLD_PAUSE_MAX);
		}
	}

	console.warn(`verity scold: ${player.name} x${lines.length}`);

	if (!ball?.isValid) return;

	system.runTimeout(() => {
		if (!ball.isValid) return;
		const phase = getVerityPhase();
		const state = getPhase2State();
		applyContextIdleFace(ball, phase, state, P2_STATE);
	}, tick + SCOLD_END_BUFFER);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} player
 */
function triggerScold(ball, player) {
	triggerScoldSequence(ball, player);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} player
 */
function registerTurnWatch(ball, player) {
	applyScoldShutFace(ball, false);
	turnWatch.set(ball.id, {
		playerId: player.id,
		wasBehind: true,
		scolded: false,
	});
	console.warn(`verity resurrection: watching turn-around for ${player.name}`);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} player
 */
export function registerVerityballOwner(ball, player) {
	if (!ball?.isValid || !player?.isValid) return;
	setVerityballOwner(ball.id, player.id);
	setBallOwnerId(player.id);
	syncVerityOwnerTag(player);
}

/**
 */
export function restoreVerityballOwners() {
	const ownerId = getBallOwnerId();
	if (!ownerId) return;

	const owner = [...world.getPlayers()].find((p) => p.id === ownerId);
	if (!owner?.isValid) return;

	for (const ball of collectAllVerityballs()) {
		if (!ball.isValid) continue;
		setVerityballOwner(ball.id, ownerId);
	}
	syncVerityOwnerTag(owner);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player | undefined} fallback
 */
function resolveResponsiblePlayer(ball, fallback) {
	const ownerId = getVerityballOwnerId(ball.id);
	if (ownerId) {
		const owner = [...world.getPlayers()].find((p) => p.id === ownerId);
		if (owner?.isValid) return owner;
	}
	if (fallback instanceof Player && fallback.isValid) return fallback;
	return __verity_resurrection_findNearestPlayer(ball.location, ball.dimension);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function isBallInHazard(ball) {
	try {
		const onFire = ball.getComponent("minecraft:onfire");
		if (onFire && /** @type {{ onFireTicks?: number }} */ (onFire).onFireTicks > 0) {
			return true;
		}
	} catch {
		/* ignore */
	}

	const dim = ball.dimension;
	const { x, y, z } = ball.location;
	const probes = [
		{ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
		{ x: Math.floor(x), y: Math.floor(y) - 1, z: Math.floor(z) },
	];

	for (const probe of probes) {
		try {
			const block = dim.getBlock(probe);
			if (block && HAZARD_BLOCKS.has(block.typeId)) return true;
		} catch {
			/* ignore */
		}
	}

	return false;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function destroyVerityballFromHazard(ball) {
	if (!ball.isValid || ball.typeId !== __verity_resurrection_VERITYBALL_ID) return;

	const dimension = ball.dimension;
	const target = resolveResponsiblePlayer(ball, undefined);
	clearVerityballOwner(ball.id);
	turnWatch.delete(ball.id);

	try {
		ball.remove();
	} catch (err) {
		console.warn(`verity hazard: remove ${err}`);
		return;
	}

	console.warn("verity resurrection: verityball burned in fire/lava");

	if (target instanceof Player) {
		system.run(() => {
			respawnVerityballBehind(target, dimension);
		});
	}
}

function tickVerityballHazards() {
	const balls = collectAllVerityballs();
	if (balls.length === 0) return;
	for (const ball of balls) {
		if (!ball.isValid) continue;
		if (isBallInHazard(ball)) destroyVerityballFromHazard(ball);
	}
}

/**
 * @param {import("@minecraft/server").Vector3} loc
 * @param {import("@minecraft/server").Dimension} dimension
 */
function __verity_resurrection_findNearestPlayer(loc, dimension) {
	let nearest;
	let best = Infinity;
	for (const player of dimension.getPlayers()) {
		const d = __verity_resurrection_flatDistance(loc, player.location);
		if (d < best) {
			best = d;
			nearest = player;
		}
	}
	return nearest;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Dimension} dimension
 */
function respawnVerityballBehind(player, dimension) {
	const pos = getPositionBehindPlayer(player);
	try {
		const ball = dimension.spawnEntity(__verity_resurrection_VERITYBALL_ID, pos);
		system.run(() => {
			if (!ball.isValid) return;
			applyPhaseFaces(ball);
			registerVerityballOwner(ball, player);
			registerTurnWatch(ball, player);
		});
		console.warn(
			`verity resurrection: respawned behind ${player.name} at ${Math.floor(pos.x)}, ${Math.floor(pos.z)}`,
		);
		return ball;
	} catch (err) {
		console.warn(`verity resurrection: spawn failed ${err}`);
		return undefined;
	}
}

function tickTurnWatch() {
	if (turnWatch.size === 0) return;

	/** @type {Map<string, import("@minecraft/server").Player>} */
	const playersById = new Map();
	for (const p of world.getPlayers()) playersById.set(p.id, p);

	for (const [ballId, watch] of [...turnWatch.entries()]) {
		const player = playersById.get(watch.playerId);
		if (!player) {
			turnWatch.delete(ballId);
			continue;
		}

		let ball;
		try {
			ball = world.getEntity(ballId);
		} catch {
			turnWatch.delete(ballId);
			continue;
		}

		if (!ball?.isValid || ball.typeId !== __verity_resurrection_VERITYBALL_ID) {
			turnWatch.delete(ballId);
			continue;
		}

		if (player.dimension.id !== ball.dimension.id) continue;
		if (__verity_resurrection_flatDistance(player.location, ball.location) > 24) {
			turnWatch.delete(ballId);
			continue;
		}

		const dot = flatLookDot(player, ball.location);

		if (dot < -0.25) {
			watch.wasBehind = true;
		}

		if (watch.scolded) continue;

		if (watch.wasBehind && dot > 0.55) {
			watch.scolded = true;
			triggerScold(ball, player);
		}
	}
}

function onVerityballDie(deadEntity, killer) {
	const dimension = deadEntity.dimension;
	const target = resolveResponsiblePlayer(deadEntity, killer);
	clearVerityballOwner(deadEntity.id);
	turnWatch.delete(deadEntity.id);

	if (!(target instanceof Player)) {
		console.warn("verity resurrection: no player for respawn");
		return;
	}

	const killData = loadPlayerJson(target.id, PLAYER_SAVE.KILLS) ?? { count: 0 };
	killData.count += 1;
	savePlayerJson(target.id, PLAYER_SAVE.KILLS, killData);
	console.warn(`verity kill count: ${target.name} = ${killData.count}`);
	tryEnterPhase2FromVerityKills(killData.count);

	system.run(() => {
		respawnVerityballBehind(target, dimension);
	});
}

export function clearVerityballOwnerPersist() {
	clearBallOwnerId();
	for (const ball of collectAllVerityballs()) {
		clearVerityballOwner(ball.id);
	}
}

export function initVerityResurrection() {
	system.run(() => restoreVerityballOwners());

	const spawnEv = world.afterEvents.playerSpawn;
	if (spawnEv) {
		spawnEv.subscribe((ev) => {
			if (!(ev.player instanceof Player)) return;
			system.runTimeout(() => restoreVerityballOwners(), 5);
		});
	}

	const dieEv = world.afterEvents.entityDie;
	if (dieEv) {
		dieEv.subscribe((ev) => {
			if (ev.deadEntity.typeId !== __verity_resurrection_VERITYBALL_ID) return;
			const killer = ev.damageSource?.damagingEntity;
			console.warn("verity resurrection: verityball died");
			onVerityballDie(ev.deadEntity, killer);
		});
	} else {
		console.warn("verity resurrection: entityDie unavailable");
	}

	world.afterEvents.entityRemove.subscribe((ev) => {
		clearVerityballOwner(ev.removedEntityId);
	});

	system.runInterval(tickTurnWatch, 10);
	system.runInterval(tickVerityballHazards, 15);
	console.warn("verity resurrection: active");
}

// ===== verity_social_state.js =====
/* dup @minecraft/server */

/** @type {Map<string, number>} */
const lastVerityChatTick = new Map();

/** @type {Map<string, { count: number, lastTick: number }>} */
const rudeStrikes = new Map();

/** @type {Map<string, number>} */
const homeActivityTick = new Map();

/** @type {Map<string, number>} */
const proactiveLastTick = new Map();

export const RUDE_ESCALATE_AT = 3;
export const RUDE_DECAY_TICKS = 12_000;
export const PROACTIVE_IDLE_MIN_TICKS = 3_600;
export const PROACTIVE_IDLE_MAX_TICKS = 5_400;
export const PROACTIVE_COOLDOWN_TICKS = 4_800;
export const HOME_ACTIVITY_WINDOW_TICKS = 2_400;

/**
 * @param {string} playerId
 */
export function notifyVerityPlayerChat(playerId) {
	lastVerityChatTick.set(playerId, system.currentTick);
}

/**
 * @param {string} playerId
 */
export function seedVerityPlayerChat(playerId) {
	if (!lastVerityChatTick.has(playerId)) {
		lastVerityChatTick.set(playerId, system.currentTick);
	}
}

/**
 * @param {string} playerId
 */
export function touchHomeActivity(playerId) {
	homeActivityTick.set(playerId, system.currentTick);
}

/**
 * @param {string} playerId
 */
export function registerRudeStrike(playerId) {
	const now = system.currentTick;
	let entry = rudeStrikes.get(playerId);
	if (!entry || now - entry.lastTick > RUDE_DECAY_TICKS) {
		entry = { count: 0, lastTick: now };
	}
	entry.count += 1;
	entry.lastTick = now;
	rudeStrikes.set(playerId, entry);
	return entry.count;
}

/**
 * @param {string} playerId
 */
export function resetRudeStrikes(playerId) {
	rudeStrikes.delete(playerId);
}

/**
 * @param {string} playerId
 */
export function getRudeStrikeCount(playerId) {
	const entry = rudeStrikes.get(playerId);
	if (!entry) return 0;
	if (system.currentTick - entry.lastTick > RUDE_DECAY_TICKS) return 0;
	return entry.count;
}

/**
 * @param {string} playerId
 */
export function getIdleTicksSinceVerityChat(playerId) {
	const last = lastVerityChatTick.get(playerId);
	if (last === undefined) return 0;
	return system.currentTick - last;
}

/**
 * @param {string} playerId
 */
export function hasRecentHomeActivity(playerId) {
	const last = homeActivityTick.get(playerId);
	if (last === undefined) return false;
	return system.currentTick - last <= HOME_ACTIVITY_WINDOW_TICKS;
}

/**
 * @param {string} playerId
 */
export function canProactiveSpeak(playerId) {
	const last = proactiveLastTick.get(playerId) ?? 0;
	return system.currentTick - last >= PROACTIVE_COOLDOWN_TICKS;
}

/**
 * @param {string} playerId
 */
export function markProactiveSpoke(playerId) {
	proactiveLastTick.set(playerId, system.currentTick);
}

/**
 * @param {string} playerId
 * @returns {number}
 */
export function randomProactiveIdleThreshold(playerId) {
	const span = PROACTIVE_IDLE_MAX_TICKS - PROACTIVE_IDLE_MIN_TICKS;
	const offset = Math.abs(hashPlayerId(playerId)) % (span + 1);
	return PROACTIVE_IDLE_MIN_TICKS + offset;
}

/**
 * @param {string} playerId
 */
function hashPlayerId(playerId) {
	let h = 0;
	for (let i = 0; i < playerId.length; i++) {
		h = (h * 31 + playerId.charCodeAt(i)) | 0;
	}
	return h;
}

// ===== verity_chest_escape.js =====
const __verity_chest_escape_VERITYBALL_ID = "pntmc:verityball";
const SCAN_INTERVAL = 80;
const ESCAPE_DELAY_TICKS = 50;
const SCAN_RADIUS = 10;
const SCAN_STEP = 3;
const SCAN_Y_MIN = -3;
const SCAN_Y_MAX = 3;
const NEARBY_CHECK_RADIUS = 1;

const STORAGE_BLOCKS = new Set([
	"minecraft:chest",
	"minecraft:trapped_chest",
	"minecraft:barrel",
]);

const __verity_chest_escape_PASSABLE = new Set([
	"minecraft:air",
	"minecraft:short_grass",
	"minecraft:tall_grass",
	"minecraft:snow_layer",
	"minecraft:water",
	"minecraft:flowing_water",
]);

/** @type {Set<string>} */
const pendingEscapes = new Set();

/**
 * @param {import("@minecraft/server").Vector3} loc
 * @param {string} dimId
 */
function blockKey(loc, dimId) {
	return `${dimId}:${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
}

/**
 * @param {string} typeId
 */
function __verity_chest_escape_isPassableBlock(typeId) {
	return __verity_chest_escape_PASSABLE.has(typeId);
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} loc
 */
function tryClearBlock(dim, loc) {
	try {
		const block = dim.getBlock(loc);
		if (!block) return false;
		if (__verity_chest_escape_isPassableBlock(block.typeId)) return true;
		if (isVerityProtectedBlock(block.typeId)) return false;
		return verityDestroyBlock(
			dim,
			Math.floor(loc.x),
			Math.floor(loc.y),
			Math.floor(loc.z),
		);
	} catch (err) {
		console.warn(`verity chest escape clear: ${err}`);
		return false;
	}
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} chestLoc
 */
function findSpawnNearChest(dim, chestLoc) {
	const cx = Math.floor(chestLoc.x);
	const cy = Math.floor(chestLoc.y);
	const cz = Math.floor(chestLoc.z);

	/** @type {{ x: number, y: number, z: number }[]} */
	const offsets = [
		{ x: 0, z: 0 },
		{ x: 1, z: 0 },
		{ x: -1, z: 0 },
		{ x: 0, z: 1 },
		{ x: 0, z: -1 },
		{ x: 1, z: 1 },
		{ x: -1, z: 1 },
		{ x: 1, z: -1 },
		{ x: -1, z: -1 },
	];

	for (const off of offsets) {
		const feet = { x: cx + off.x, y: cy + 1, z: cz + off.z };
		const head = { x: feet.x, y: feet.y + 1, z: feet.z };

		if (!__verity_chest_escape_isPassableBlock(dim.getBlock(feet)?.typeId ?? "minecraft:stone")) {
			tryClearBlock(dim, feet);
		}
		if (!__verity_chest_escape_isPassableBlock(dim.getBlock(head)?.typeId ?? "minecraft:stone")) {
			tryClearBlock(dim, head);
		}

		const feetBlock = dim.getBlock(feet);
		const headBlock = dim.getBlock(head);
		if (
			feetBlock &&
			headBlock &&
			__verity_chest_escape_isPassableBlock(feetBlock.typeId) &&
			__verity_chest_escape_isPassableBlock(headBlock.typeId)
		) {
			return { x: feet.x + 0.5, y: feet.y + 0.35, z: feet.z + 0.5 };
		}
	}

	return { x: cx + 0.5, y: cy + 1.35, z: cz + 0.5 };
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} loc
 */
function playChestCreak(dim, loc) {
	const center = { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
	try {
		dim.playSound("random.chestopen", center, { volume: 0.85, pitch: 0.82 });
	} catch (err) {
		console.warn(`verity chest escape sound: ${err}`);
	}
}

/**
 * @param {import("@minecraft/server").Block} block
 */
function getStorageInventory(block) {
	try {
		const inv = block.getComponent("minecraft:inventory");
		return inv?.container ?? null;
	} catch {
		return null;
	}
}

/**
 * @param {import("@minecraft/server").Block} block
 * @param {import("@minecraft/server").Player} player
 */
function scheduleChestEscape(block, player) {
	const key = blockKey(block.location, block.dimension.id);
	if (pendingEscapes.has(key)) return;
	pendingEscapes.add(key);

	const loc = { ...block.location };
	const dim = block.dimension;
	const playerId = player.id;

	system.runTimeout(() => {
		pendingEscapes.delete(key);
		try {
			const live = dim.getBlock(loc);
			if (!live || !STORAGE_BLOCKS.has(live.typeId)) return;

			const container = getStorageInventory(live);
			if (!container) return;

			let slot = -1;
			let itemTypeId = "";
			for (let i = 0; i < container.size; i++) {
				const stack = container.getItem(i);
				if (stack && VERITY_INVENTORY_IDS.has(stack.typeId)) {
					slot = i;
					itemTypeId = stack.typeId;
					break;
				}
			}
			if (slot < 0) return;

			container.setItem(slot, undefined);

			const owner = world.getEntity(playerId);
			if (!(owner instanceof Player) || !owner.isValid) return;

			playChestCreak(dim, loc);
			touchHomeActivity(owner.id);

			const spawn = findSpawnNearChest(dim, loc);
			const faceIndex = resolveVerityPlaceFace(itemTypeId);
			const ball = dim.spawnEntity(__verity_chest_escape_VERITYBALL_ID, spawn);
			applyBallFace(ball, faceIndex, false);
			registerVerityballOwner(ball, owner);
			system.run(() => {
				if (!ball.isValid) return;
				applyBallFace(ball, resolveVerityPlaceFace(itemTypeId), false);
			});

			console.warn(
				`verity chest escape: ${owner.name} — ${itemTypeId} @ ${Math.floor(spawn.x)} ${Math.floor(spawn.y)} ${Math.floor(spawn.z)}`,
			);
		} catch (err) {
			console.warn(`verity chest escape: ${err}`);
		}
	}, ESCAPE_DELAY_TICKS);
}

/**
 * @param {import("@minecraft/server").Block} block
 * @param {import("@minecraft/server").Player} player
 */
function checkStorageBlock(block, player) {
	if (!block || !STORAGE_BLOCKS.has(block.typeId)) return false;

	const container = getStorageInventory(block);
	if (!container) return false;

	for (let i = 0; i < container.size; i++) {
		const stack = container.getItem(i);
		if (stack && VERITY_INVENTORY_IDS.has(stack.typeId)) {
			scheduleChestEscape(block, player);
			return true;
		}
	}
	return false;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function scanNearPlayer(player) {
	const dim = player.dimension;
	const px = Math.floor(player.location.x);
	const py = Math.floor(player.location.y);
	const pz = Math.floor(player.location.z);

	for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx += SCAN_STEP) {
		for (let dy = SCAN_Y_MIN; dy <= SCAN_Y_MAX; dy++) {
			for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz += SCAN_STEP) {
				let block;
				try {
					block = dim.getBlock({ x: px + dx, y: py + dy, z: pz + dz });
				} catch {
					continue;
				}
				if (checkStorageBlock(block, player)) return;
			}
		}
	}
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} loc
 * @param {import("@minecraft/server").Player} player
 * @returns {boolean}
 */
function checkChestArea(dim, loc, player) {
	const bx = Math.floor(loc.x);
	const by = Math.floor(loc.y);
	const bz = Math.floor(loc.z);

	for (let dx = -NEARBY_CHECK_RADIUS; dx <= NEARBY_CHECK_RADIUS; dx++) {
		for (let dz = -NEARBY_CHECK_RADIUS; dz <= NEARBY_CHECK_RADIUS; dz++) {
			let block;
			try {
				block = dim.getBlock({ x: bx + dx, y: by, z: bz + dz });
			} catch {
				continue;
			}
			if (checkStorageBlock(block, player)) return true;
		}
	}
	return false;
}

export function initVerityChestEscape() {
	const interact = world.afterEvents.playerInteractWithBlock;
	if (interact) {
		interact.subscribe((ev) => {
			if (!(ev.player instanceof Player)) return;
			const block = ev.block;
			if (!block || !STORAGE_BLOCKS.has(block.typeId)) return;
			checkChestArea(block.dimension, block.location, ev.player);
		});
	}

	system.runInterval(() => {
		for (const player of world.getPlayers()) {
			if (!player.isValid) continue;
			if (playerCarriesVerity(player)) continue;
			scanNearPlayer(player);
		}
	}, SCAN_INTERVAL);

	console.warn("verity chest escape: hybrid storage scan enabled");
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function playerCarriesVerity(player) {
	const inv = player.getComponent("minecraft:inventory")?.container;
	if (!inv) return false;
	for (let slot = 0; slot < inv.size; slot++) {
		const stack = inv.getItem(slot);
		if (stack && VERITY_INVENTORY_IDS.has(stack.typeId)) return true;
	}
	return false;
}

// ===== verity_drop.js =====
const __verity_drop_VERITYBALL_ID = "pntmc:verityball";
const OUCH_SOUND = "pntmc.verity.ouch";
const FALL_SOUNDS = [
	"pntmc.verity.fall_1",
	"pntmc.verity.fall_2",
	"pntmc.verity.fall_3",
];
const NEAR_PLAYER_DROP_RADIUS = 10;

const SOFT_THROW_STRENGTH = 0.3;
const SOFT_THROW_LIFT = 0.24;

const THROW_STRENGTH = 1.58;
const THROW_LIFT = 0.42;
const THROW_TICK_INTERVAL = 1;
const THROW_MAX_AGE = 80;
const BOUNCE_UP = 0.38;
const BOUNCE_DAMP = 0.55;
const WALL_PROBE = 0.45;
const WALL_BOUNCE_DAMP = 0.42;
const HURT_FACE_DURATION_TICKS = 50;
const BOUNCE_HURT_COOLDOWN = 8;

const OUCH_LINES = [
	"Ouch!",
	"Oof!",
	"That hurt!",
];

/** Fixed pack clips from V26.40 — never Fish TTS. */
const FIXED_HURT_SOUNDS = {
	"ouch!": "pntmc.verity.ouch",
	"ow!": "pntmc.verity.ouch",
	"ow ow!": "pntmc.verity.ouch",
	"oof!": "pntmc.verity.voicelines_en.oof",
	"that hurt!": "pntmc.verity.voicelines_en.that_hurt",
};

const BRIDGE_ON_TAG = "pntmc_bridge_on";
const HURT_SPEAK_TAG = "pntmc_hurt_speak";
const __verity_drop_PASSABLE = new Set([
	"minecraft:air",
	"minecraft:cave_air",
	"minecraft:void_air",
	"minecraft:short_grass",
	"minecraft:tall_grass",
	"minecraft:snow_layer",
	"minecraft:water",
	"minecraft:flowing_water",
	"minecraft:light_block",
	"minecraft:light_block_0",
]);

/** @type {Set<string>} */
const handledDropItems = new Set();

const DROP_PICKUP_GRACE_TICKS = 15;
/** @type {Map<string, number>} ballId -> expire tick */
const dropPickupGraceUntil = new Map();

let dropSpawnDepth = 0;

/**
 * @param {import("@minecraft/server").Entity} ball
 */
/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} [ticks]
 */
export function markVerityDropGrace(ball, ticks = DROP_PICKUP_GRACE_TICKS) {
	if (!ball?.isValid) return;
	const duration =
		typeof ticks === "number" && ticks > 0 ? ticks : DROP_PICKUP_GRACE_TICKS;
	dropPickupGraceUntil.set(ball.id, system.currentTick + duration);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
export function isVerityDropGrace(ball) {
	if (dropSpawnDepth > 0) return true;
	if (!ball?.isValid) return false;
	const until = dropPickupGraceUntil.get(ball.id);
	if (until === undefined) return false;
	if (system.currentTick >= until) {
		dropPickupGraceUntil.delete(ball.id);
		return false;
	}
	return true;
}

/**
 * @typedef {{
 *   bouncesLeft: number,
 *   againstWall: boolean,
 *   wasAirborne: boolean,
 *   age: number,
 *   restoreFace: number,
 *   hurtGen: number,
 *   hurtCooldownUntil: number,
 * }} ThrowState
 */

/** @type {Map<string, ThrowState>} */
const activeThrows = new Map();

/** @type {number | undefined} */
let throwTickId;

/** Hit-cooldown so rapid punches don't spam ouch. */
let lastHitOuchAt = 0;
const HIT_OUCH_COOLDOWN_MS = 700;

/**
 * Play a hurt VO without opening speak-mouth (keeps hurt face).
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} [soundId]
 */
function playOuchSound(ball, soundId = OUCH_SOUND) {
	if (!ball?.isValid) return;
	const loc = ball.location;
	try {
		for (const player of ball.dimension.getPlayers()) {
			player.playSound(soundId, { location: loc, volume: 1, pitch: 1 });
		}
	} catch (err) {
		console.warn(`verity ouch sound ${soundId}: ${err}`);
	}
}

/**
 * Physical bounce / impact SFX (not language-localized).
 * @param {import("@minecraft/server").Entity} ball
 */
function playFallBounceSound(ball) {
	if (!ball?.isValid) return;
	const sound =
		FALL_SOUNDS[Math.floor(Math.random() * FALL_SOUNDS.length)] ?? FALL_SOUNDS[0];
	const loc = ball.location;
	try {
		for (const player of ball.dimension.getPlayers()) {
			player.playSound(sound, { location: loc, volume: 1, pitch: 1 });
		}
	} catch (err) {
		console.warn(`verity fall bounce sound: ${err}`);
	}
}

/**
 * @param {string} value
 */
function sanitizeHurtDraftTag(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 80);
}

function isVerityBridgeOnline() {
	for (const p of world.getPlayers()) {
		try {
			if (p.hasTag(BRIDGE_ON_TAG)) return true;
		} catch {
			/* ignore */
		}
	}
	return false;
}

/**
 * Queue hurt line for Python bridge → Fish Audio (chat shows when clip is ready).
 * @param {import("@minecraft/server").Player} player
 * @param {string} line
 */
function queueBridgeHurtSpeak(player, line) {
	if (!(player instanceof Player) || !player.isValid) return false;
	const draft = sanitizeHurtDraftTag(line);
	if (!draft) return false;
	try {
		player.removeTag(HURT_SPEAK_TAG);
		for (const tag of [...player.getTags()]) {
			if (tag.startsWith("pntmc_d_")) player.removeTag(tag);
		}
		player.addTag(HURT_SPEAK_TAG);
		player.addTag(`pntmc_d_${draft}`);
		console.warn(`verity bridge hurt queue: ${line}`);
		return true;
	} catch (err) {
		console.warn(`verity bridge hurt queue: ${err}`);
		return false;
	}
}

/**
 * Chat + pack VO for punch/bounce. Keep hurt face — no Fish, no talk mouth.
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} line
 * @param {import("@minecraft/server").Player | undefined} [_player]
 */
function deliverHurtReaction(ball, line, _player) {
	const localized = translateVerityOutput(line);
	playHurtReaction(ball, line);
	try {
		world.sendMessage(`<§eVerity§r> ${localized}`);
	} catch (err) {
		console.warn(`verity hurt chat: ${err}`);
	}
}

/**
 * Fixed V26.40 clips: ouch.wav / oof.ogg / that_hurt.ogg.
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} line
 */
function playHurtReaction(ball, line) {
	const key = String(line || "")
		.trim()
		.toLowerCase();
	const soundId = FIXED_HURT_SOUNDS[key] ?? OUCH_SOUND;
	playOuchSound(ball, soundId);
}

/**
 * @param {import("@minecraft/server").Vector3} a
 * @param {import("@minecraft/server").Vector3} b
 */
function distSq(a, b) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	const dz = a.z - b.z;
	return dx * dx + dy * dy + dz * dz;
}

/**
 * @param {import("@minecraft/server").Vector3} loc
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {number} radius
 */
function __verity_drop_findNearestPlayer(loc, dimension, radius) {
	const maxSq = radius * radius;
	let nearest;
	let best = maxSq;
	for (const player of dimension.getPlayers()) {
		const d = distSq(loc, player.location);
		if (d < best) {
			best = d;
			nearest = player;
		}
	}
	return nearest;
}

/**
 * @param {import("@minecraft/server").Entity} itemEntity
 * @returns {string | undefined}
 */
function readVerityItemType(itemEntity) {
	if (!itemEntity.isValid || itemEntity.typeId !== "minecraft:item") return undefined;
	const stack = itemEntity.getComponent("minecraft:item")?.itemStack;
	if (!stack || !VERITY_INVENTORY_IDS.has(stack.typeId)) return undefined;
	return stack.typeId;
}

/**
 * @param {import("@minecraft/server").Entity} entity
 * @returns {import("@minecraft/server").Vector3 | undefined}
 */
function readEntityVelocity(entity) {
	try {
		const v = entity.getVelocity();
		const mag = v.x * v.x + v.y * v.y + v.z * v.z;
		if (mag < 0.0004) return undefined;
		return { x: v.x, y: v.y, z: v.z };
	} catch {
		return undefined;
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @returns {import("@minecraft/server").Vector3}
 */
function getViewDir(player) {
	try {
		return player.getViewDirection();
	} catch {
		const yawRad = (player.getRotation().y * Math.PI) / 180;
		return { x: -Math.sin(yawRad), y: 0, z: Math.cos(yawRad) };
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @returns {import("@minecraft/server").Vector3}
 */
function getPlayerVelocity(player) {
	try {
		return player.getVelocity();
	} catch {
		return { x: 0, y: 0, z: 0 };
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function estimateSoftDropVelocity(player) {
	const view = getViewDir(player);
	const playerVel = getPlayerVelocity(player);
	return {
		x: view.x * SOFT_THROW_STRENGTH + playerVel.x * 0.35,
		y: view.y * SOFT_THROW_STRENGTH + SOFT_THROW_LIFT + playerVel.y * 0.25,
		z: view.z * SOFT_THROW_STRENGTH + playerVel.z * 0.35,
	};
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function estimateThrowVelocity(player) {
	const view = getViewDir(player);
	const playerVel = getPlayerVelocity(player);
	const lift = view.y < -0.35 ? 0 : THROW_LIFT * Math.max(0.35, 1 - Math.abs(view.y));

	return {
		x: view.x * THROW_STRENGTH + playerVel.x * 0.15,
		y: view.y * THROW_STRENGTH + lift + playerVel.y * 0.08,
		z: view.z * THROW_STRENGTH + playerVel.z * 0.15,
	};
}

/**
 * @param {import("@minecraft/server").Entity} itemEntity
 * @param {import("@minecraft/server").Player} player
 * @param {boolean} isThrow
 * @param {boolean} [preferPlayerEstimate]
 */
function resolveDropVelocity(itemEntity, player, isThrow, preferPlayerEstimate = false) {
	const estimated = isThrow
		? estimateThrowVelocity(player)
		: estimateSoftDropVelocity(player);
	if (isThrow || preferPlayerEstimate) return estimated;

	const fromItem = readEntityVelocity(itemEntity);
	if (!fromItem) return estimated;
	return fromItem;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Vector3} velocity
 */
function applyDropMotion(ball, velocity) {
	const vx = Number(velocity?.x) || 0;
	const vy = Number(velocity?.y) || 0;
	const vz = Number(velocity?.z) || 0;
	try {
		ball.clearVelocity();
		ball.applyImpulse({ x: vx, y: vy, z: vz });
	} catch (err) {
		console.warn(`verity drop: motion ${err}`);
	}
}

/**
 * @param {import("@minecraft/server").Block | undefined} block
 */
function __verity_drop_isPassableBlock(block) {
	if (!block) return true;
	try {
		if (typeof block.isAir === "boolean" && block.isAir) return true;
		if (typeof block.isLiquid === "boolean" && block.isLiquid) return true;
	} catch {
		/* ignore */
	}
	return __verity_drop_PASSABLE.has(block.typeId);
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} loc
 */
function hasSolidAt(dim, loc) {
	try {
		const block = dim.getBlock({
			x: Math.floor(loc.x),
			y: Math.floor(loc.y),
			z: Math.floor(loc.z),
		});
		return !__verity_drop_isPassableBlock(block);
	} catch {
		return false;
	}
}

/**
 * @returns {1 | 2}
 */
function pickBounceCount() {
	return Math.random() < 0.5 ? 1 : 2;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} restoreFace
 */
function startThrowTracking(ball, restoreFace) {
	const bouncesLeft = pickBounceCount();
	activeThrows.set(ball.id, {
		bouncesLeft,
		againstWall: false,
		wasAirborne: true,
		age: 0,
		restoreFace,
		hurtGen: 0,
		hurtCooldownUntil: 0,
	});
	console.warn(`verity drop: bounce plan ${bouncesLeft}× ${ball.id}`);
	ensureThrowTicker();
}

function ensureThrowTicker() {
	if (throwTickId !== undefined) return;
	throwTickId = system.runInterval(() => {
		if (activeThrows.size === 0) {
			if (throwTickId !== undefined) {
				system.clearRun(throwTickId);
				throwTickId = undefined;
			}
			return;
		}
		tickActiveThrows();
	}, THROW_TICK_INTERVAL);
}

/**
 * @returns {string}
 */
function pickOuchLine() {
	return OUCH_LINES[Math.floor(Math.random() * OUCH_LINES.length)] ?? "Ouch!";
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {ThrowState} state
 */
function triggerBounceHurt(ball, state) {
	if (state.age < state.hurtCooldownUntil) return;
	state.hurtCooldownUntil = state.age + BOUNCE_HURT_COOLDOWN;
	state.hurtGen += 1;
	const gen = state.hurtGen;
	const restoreFace = state.restoreFace;
	const ballId = ball.id;

	try {
		applyBallFace(ball, FACE_HURT, false);
	} catch (err) {
		console.warn(`verity drop: bounce face ${err}`);
	}

	const line = pickOuchLine();
	playFallBounceSound(ball);
	deliverHurtReaction(ball, line);

	console.warn(`verity drop: bounce hurt gen=${gen} ${ballId}`);

	system.runTimeout(() => {
		const liveState = activeThrows.get(ballId);
		if (liveState && liveState.hurtGen !== gen) return;

		let live;
		try {
			live = world.getEntity(ballId);
		} catch {
			return;
		}
		if (!live?.isValid || live.typeId !== __verity_drop_VERITYBALL_ID) return;
		try {
			const current = live.getProperty("pntmc:face_index");
			if (current !== FACE_HURT) return;
			applyBallFace(live, restoreFace, false);
		} catch (err) {
			console.warn(`verity drop: restore face ${err}`);
		}
	}, HURT_FACE_DURATION_TICKS);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {ThrowState} state
 * @param {import("@minecraft/server").Vector3} vel
 */
function tryWallHit(ball, state, vel) {
	const horiz = Math.hypot(vel.x, vel.z);
	if (horiz < 0.08) {
		state.againstWall = false;
		return false;
	}

	const nx = vel.x / horiz;
	const nz = vel.z / horiz;
	const probe = {
		x: ball.location.x + nx * WALL_PROBE,
		y: ball.location.y + 0.1,
		z: ball.location.z + nz * WALL_PROBE,
	};

	if (!hasSolidAt(ball.dimension, probe)) {
		state.againstWall = false;
		return false;
	}

	if (state.againstWall) return false;
	state.againstWall = true;

	if (state.bouncesLeft <= 0) {
		try {
			ball.clearVelocity();
		} catch {
			/* ignore */
		}
		return true;
	}

	state.bouncesLeft -= 1;
	triggerBounceHurt(ball, state);

	try {
		ball.clearVelocity();
		ball.applyImpulse({
			x: -nx * THROW_STRENGTH * WALL_BOUNCE_DAMP,
			y: BOUNCE_UP * 0.7,
			z: -nz * THROW_STRENGTH * WALL_BOUNCE_DAMP,
		});
	} catch (err) {
		console.warn(`verity drop: wall bounce ${err}`);
	}

	return true;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {ThrowState} state
 * @param {import("@minecraft/server").Vector3} vel
 */
function tryGroundBounce(ball, state, vel) {
	let onGround = false;
	try {
		onGround = ball.isOnGround === true;
	} catch {
		onGround = false;
	}

	if (!onGround) {
		const below = {
			x: ball.location.x,
			y: ball.location.y - 0.15,
			z: ball.location.z,
		};
		if (hasSolidAt(ball.dimension, below) && vel.y <= 0.05) {
			onGround = true;
		}
	}

	if (!onGround) {
		if (vel.y < -0.05) state.wasAirborne = true;
		return false;
	}

	if (!state.wasAirborne || state.bouncesLeft <= 0) {
		const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
		if (state.bouncesLeft <= 0 && speed < 0.35) {
			try {
				ball.clearVelocity();
			} catch {
				/* ignore */
			}
			return true;
		}
		return onGround && speed < 0.08;
	}

	state.wasAirborne = false;
	state.bouncesLeft -= 1;

	triggerBounceHurt(ball, state);

	const horiz = Math.hypot(vel.x, vel.z);
	let hx = 0;
	let hz = 0;
	if (horiz > 0.01) {
		hx = (vel.x / horiz) * THROW_STRENGTH * BOUNCE_DAMP;
		hz = (vel.z / horiz) * THROW_STRENGTH * BOUNCE_DAMP;
	}

	const up = state.bouncesLeft === 0 ? BOUNCE_UP * 0.72 : BOUNCE_UP;
	const damp = state.bouncesLeft === 0 ? 0.7 : 1;

	try {
		ball.clearVelocity();
		ball.applyImpulse({
			x: hx * damp,
			y: up,
			z: hz * damp,
		});
		console.warn(
			`verity drop: ground bounce (${state.bouncesLeft} left) ${ball.id}`,
		);
	} catch (err) {
		console.warn(`verity drop: ground bounce ${err}`);
	}

	return false;
}

function tickActiveThrows() {
	for (const [ballId, state] of [...activeThrows.entries()]) {
		state.age += 1;
		if (state.age > THROW_MAX_AGE) {
			activeThrows.delete(ballId);
			continue;
		}

		let ball;
		try {
			ball = world.getEntity(ballId);
		} catch {
			activeThrows.delete(ballId);
			continue;
		}
		if (!ball?.isValid || ball.typeId !== __verity_drop_VERITYBALL_ID) {
			activeThrows.delete(ballId);
			continue;
		}

		const vel = readEntityVelocity(ball) ?? { x: 0, y: 0, z: 0 };

		if (tryWallHit(ball, state, vel)) continue;

		const settled = tryGroundBounce(ball, state, vel);
		const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
		if (settled && state.bouncesLeft <= 0 && speed < 0.12) {
			activeThrows.delete(ballId);
		}
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Vector3} loc
 * @param {boolean} isThrow
 */
/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Vector3} loc
 * @param {string} itemTypeId
 * @param {import("@minecraft/server").Vector3} velocity
 * @param {boolean} isThrow
 */
function spawnVerityballFromDroppedItem(player, loc, itemTypeId, velocity, isThrow) {
	const faceIndex = VERITY_ITEM_TO_FACE[itemTypeId];
	if (faceIndex === undefined) return;

	/** @type {import("@minecraft/server").Entity | undefined} */
	let ball;
	dropSpawnDepth++;
	try {
		ball = player.dimension.spawnEntity(__verity_drop_VERITYBALL_ID, {
			x: loc.x,
			y: loc.y,
			z: loc.z,
		});
	} catch (err) {
		console.warn(`verity drop: spawn failed ${err}`);
		return;
	} finally {
		dropSpawnDepth--;
	}

	if (!ball?.isValid) {
		console.warn("verity drop: spawn invalid");
		return;
	}

	invalidateVerityballCache();
	setCanonicalVerityball(ball);
	markVerityDropGrace(ball);

	try {
		applyBallFace(ball, faceIndex, false);
		applyDropMotion(ball, velocity);
	} catch (err) {
		console.warn(`verity drop: face/motion ${err}`);
	}

	if (isThrow) startThrowTracking(ball, faceIndex);

	system.run(() => {
		if (!ball.isValid) return;
		registerVerityballOwner(ball, player);
		setCanonicalVerityball(ball);
		markVerityDropGrace(ball);
		enforceSingleVerityball(ball);
		console.warn(
			`verity drop: ${player.name} ${isThrow ? "threw" : "dropped"} ${itemTypeId} → verityball`,
		);
	});
}

/**
 * @param {import("@minecraft/server").Entity} itemEntity
 * @param {import("@minecraft/server").Player} player
 * @param {boolean} [preferPlayerEstimate]
 */
function convertItemEntityToVerityball(
	itemEntity,
	player,
	preferPlayerEstimate = false,
) {
	const itemTypeId = readVerityItemType(itemEntity);
	if (!itemTypeId) return false;
	if (handledDropItems.has(itemEntity.id)) return false;

	handledDropItems.add(itemEntity.id);
	const isThrow = player.isSneaking === true;

	system.run(() => {
		const loc = itemEntity.isValid
			? { ...itemEntity.location }
			: {
					x: player.location.x,
					y: player.location.y + 1,
					z: player.location.z,
				};
		const velocity = itemEntity.isValid
			? resolveDropVelocity(itemEntity, player, isThrow, preferPlayerEstimate)
			: isThrow
				? estimateThrowVelocity(player)
				: estimateSoftDropVelocity(player);

		if (itemEntity.isValid) {
			try {
				itemEntity.remove();
			} catch (err) {
				console.warn(`verity drop: remove item entity ${err}`);
			}
		}

		spawnVerityballFromDroppedItem(player, loc, itemTypeId, velocity, isThrow);
	});

	return true;
}

function asDroppedItemEntities(value) {
	if (value == null) return [];
	if (Array.isArray(value)) {
		return value.filter(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				/** @type {import("@minecraft/server").Entity} */ (entry).isValid,
		);
	}
	if (
		typeof value === "object" &&
		/** @type {import("@minecraft/server").Entity} */ (value).isValid
	) {
		return [/** @type {import("@minecraft/server").Entity} */ (value)];
	}
	return [];
}

/**
 * @param {import("@minecraft/server").EntityItemDropAfterEvent} ev
 */
function onEntityItemDrop(ev) {
	if (!(ev.entity instanceof Player)) return;

	const player = ev.entity;
	const items = asDroppedItemEntities(ev.items);
	if (items.length === 0) return;

	for (const itemEntity of items) {
		convertItemEntityToVerityball(itemEntity, player, true);
	}
}

/**
 * @param {import("@minecraft/server").EntitySpawnAfterEvent} ev
 */
function onVerityItemEntitySpawn(ev) {
	if (ev.entity.typeId !== "minecraft:item") return;
	if (handledDropItems.has(ev.entity.id)) return;
	if (!readVerityItemType(ev.entity)) return;

	const itemEntity = ev.entity;
	system.run(() => {
		if (handledDropItems.has(itemEntity.id)) return;
		if (!itemEntity.isValid) return;

		const player = __verity_drop_findNearestPlayer(
			itemEntity.location,
			itemEntity.dimension,
			NEAR_PLAYER_DROP_RADIUS,
		);
		if (!(player instanceof Player)) return;

		convertItemEntityToVerityball(itemEntity, player, false);
	});
}

/**
 * Player punches the ball — hurt face + ouch sound (even though damage is blocked).
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player | undefined} [hitter]
 */
function triggerHitHurt(ball, hitter) {
	const now = Date.now();
	if (now - lastHitOuchAt < HIT_OUCH_COOLDOWN_MS) return;
	lastHitOuchAt = now;

	const throwState = activeThrows.get(ball.id);
	if (throwState) {
		triggerBounceHurt(ball, throwState);
		return;
	}

	if (hitter instanceof Player) {
		noteMercyBetrayalStrike("hit");
	}

	let restoreFace = 0;
	try {
		const cur = ball.getProperty("pntmc:face_index");
		if (typeof cur === "number") restoreFace = cur;
	} catch {
		/* keep 0 */
	}
	if (restoreFace === FACE_HURT) restoreFace = 0;

	try {
		applyBallFace(ball, FACE_HURT, false);
	} catch (err) {
		console.warn(`verity hit: face ${err}`);
	}

	const line = pickOuchLine();
	deliverHurtReaction(ball, line, hitter);

	const ballId = ball.id;
	system.runTimeout(() => {
		let live;
		try {
			live = world.getEntity(ballId);
		} catch {
			return;
		}
		if (!live?.isValid || live.typeId !== __verity_drop_VERITYBALL_ID) return;
		try {
			const current = live.getProperty("pntmc:face_index");
			if (current !== FACE_HURT) return;
			applyBallFace(live, restoreFace, false);
		} catch (err) {
			console.warn(`verity hit: restore face ${err}`);
		}
	}, HURT_FACE_DURATION_TICKS);
}

export function initVerityDrop() {
	const itemDropEv = world.afterEvents.entityItemDrop;
	if (itemDropEv) {
		itemDropEv.subscribe(onEntityItemDrop);
	} else {
		console.warn("verity drop: entityItemDrop unavailable — spawn fallback only");
	}

	world.afterEvents.entitySpawn.subscribe(onVerityItemEntitySpawn);

	world.afterEvents.entityRemove.subscribe((ev) => {
		handledDropItems.delete(ev.removedEntityId);
		activeThrows.delete(ev.removedEntityId);
	});

	const hitEv = world.afterEvents.entityHitEntity;
	if (hitEv) {
		hitEv.subscribe((ev) => {
			const ball = ev.hitEntity;
			if (!ball?.isValid || ball.typeId !== __verity_drop_VERITYBALL_ID) return;
			const hitter = ev.damagingEntity instanceof Player ? ev.damagingEntity : undefined;
			triggerHitHurt(ball, hitter);
		});
	}

	console.warn("verity drop: sneak=throw (along look dir); bounce/hit→Fish/pack ouch+face");
}

// ===== verity_flashlight.js =====
/**
 * Flashlight (merged from Just A Flashlight by PnTMC).
 * Hold on/off item and use to toggle; beam places light_block_13 along view.
 */
export const FLASHLIGHT_ON = "pntmc:flashlight_on";
export const FLASHLIGHT_OFF = "pntmc:flashlight_off";

const CLICK_SOUND = "pntmc.flashlight.click";
const LIGHT_BLOCK = "minecraft:light_block_13";
const LIGHT_COUNT = 20;
const BEAM_START = 1;
const BEAM_RANGE = 45;
const LIGHT_UPDATE_TICKS = 2;

const LIGHT_DISTANCES = [];
for (let i = 0; i < LIGHT_COUNT; i++) {
	LIGHT_DISTANCES.push(
		BEAM_START + (i * (BEAM_RANGE - BEAM_START)) / (LIGHT_COUNT - 1),
	);
}

/** @type {Map<string, Map<string, { dimension: import("@minecraft/server").Dimension, x: number, y: number, z: number }>>} */
const playerLights = new Map();

/**
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function getBlockSafe(dimension, x, y, z) {
	try {
		return dimension.getBlock({ x, y, z });
	} catch {
		return undefined;
	}
}

/**
 * @param {{ dimension: import("@minecraft/server").Dimension, x: number, y: number, z: number }} info
 */
function removeLight(info) {
	const block = getBlockSafe(info.dimension, info.x, info.y, info.z);
	if (block?.typeId === LIGHT_BLOCK) {
		try {
			block.setType("minecraft:air");
		} catch (error) {
			console.warn(`Flashlight clear error: ${error}`);
		}
	}
}

/**
 * @param {string} playerId
 */
function clearPlayerLights(playerId) {
	const lights = playerLights.get(playerId);
	if (!lights) return;

	for (const info of lights.values()) {
		removeLight(info);
	}
	playerLights.delete(playerId);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function isHoldingFlashlightOn(player) {
	const equipment = player.getComponent("minecraft:equippable");
	if (!equipment) return false;

	return (
		equipment.getEquipment(EquipmentSlot.Mainhand)?.typeId === FLASHLIGHT_ON ||
		equipment.getEquipment(EquipmentSlot.Offhand)?.typeId === FLASHLIGHT_ON
	);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function getBeamLength(player) {
	let hit;
	try {
		hit = player.getBlockFromViewDirection({ maxDistance: BEAM_RANGE });
	} catch {
		hit = undefined;
	}
	if (!hit) return BEAM_RANGE;

	const head = player.getHeadLocation();
	const loc = hit.block.location;
	const px = loc.x + hit.faceLocation.x - head.x;
	const py = loc.y + hit.faceLocation.y - head.y;
	const pz = loc.z + hit.faceLocation.z - head.z;
	return Math.min(BEAM_RANGE, Math.sqrt(px * px + py * py + pz * pz));
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function updatePlayerLights(player) {
	const dimension = player.dimension;
	const head = player.getHeadLocation();
	const view = player.getViewDirection();
	const beamLength = getBeamLength(player);

	const oldLights = playerLights.get(player.id);
	/** @type {Map<string, { dimension: import("@minecraft/server").Dimension, x: number, y: number, z: number }>} */
	const newLights = new Map();

	for (const distance of LIGHT_DISTANCES) {
		if (distance > beamLength) break;

		const x = Math.floor(head.x + view.x * distance);
		const y = Math.floor(head.y + view.y * distance);
		const z = Math.floor(head.z + view.z * distance);
		const key = `${dimension.id}:${x},${y},${z}`;

		if (newLights.has(key)) continue;

		if (oldLights?.has(key)) {
			newLights.set(key, oldLights.get(key));
			oldLights.delete(key);
			continue;
		}

		const block = getBlockSafe(dimension, x, y, z);
		if (!block || block.typeId !== "minecraft:air") continue;

		try {
			block.setType(LIGHT_BLOCK);
			newLights.set(key, { dimension, x, y, z });
		} catch (error) {
			console.warn(`Flashlight place error: ${error}`);
		}
	}

	if (oldLights) {
		for (const info of oldLights.values()) {
			removeLight(info);
		}
	}

	if (newLights.size > 0) {
		playerLights.set(player.id, newLights);
	} else {
		playerLights.delete(player.id);
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {boolean} turnOn
 */
function setFlashlightState(player, turnOn) {
	const equippable = player.getComponent("minecraft:equippable");
	if (!equippable) return;

	const mainHand = equippable.getEquipment(EquipmentSlot.Mainhand);
	const offHand = equippable.getEquipment(EquipmentSlot.Offhand);

	let slot;
	if (mainHand?.typeId === FLASHLIGHT_ON || mainHand?.typeId === FLASHLIGHT_OFF) {
		slot = EquipmentSlot.Mainhand;
	} else if (offHand?.typeId === FLASHLIGHT_ON || offHand?.typeId === FLASHLIGHT_OFF) {
		slot = EquipmentSlot.Offhand;
	} else {
		return;
	}

	const held = slot === EquipmentSlot.Mainhand ? mainHand : offHand;
	if ((turnOn && held.typeId === FLASHLIGHT_ON) || (!turnOn && held.typeId === FLASHLIGHT_OFF)) {
		return;
	}

	equippable.setEquipment(slot, new ItemStack(turnOn ? FLASHLIGHT_ON : FLASHLIGHT_OFF, 1));

	try {
		player.playSound(CLICK_SOUND);
	} catch {
		try {
			player.playSound("random.click");
		} catch (error) {
			console.warn(`Flashlight click sound error: ${error}`);
		}
	}

	if (!turnOn) {
		clearPlayerLights(player.id);
	}
}

/**
 * True if inventory already has any flashlight (on or off).
 * @param {import("@minecraft/server").Player} player
 */
export function playerHasFlashlight(player) {
	if (!player?.isValid) return false;
	try {
		const inv = player.getComponent("minecraft:inventory")?.container;
		if (!inv) return false;
		for (let i = 0; i < inv.size; i++) {
			const id = inv.getItem(i)?.typeId;
			if (id === FLASHLIGHT_OFF || id === FLASHLIGHT_ON) return true;
		}
		const equipment = player.getComponent("minecraft:equippable");
		if (equipment) {
			for (const slot of [EquipmentSlot.Mainhand, EquipmentSlot.Offhand]) {
				const id = equipment.getEquipment(slot)?.typeId;
				if (id === FLASHLIGHT_OFF || id === FLASHLIGHT_ON) return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * Give one flashlight_off if the player does not already have a flashlight.
 * @param {import("@minecraft/server").Player} player
 * @returns {boolean}
 */
export function giveFlashlightOff(player) {
	if (!player?.isValid) return false;
	if (playerHasFlashlight(player)) return false;
	try {
		const stack = new ItemStack(FLASHLIGHT_OFF, 1);
		const inv = player.getComponent("minecraft:inventory")?.container;
		if (inv) {
			const leftover = inv.addItem(stack);
			if (!leftover) {
				console.warn(`verity flashlight: gave off to ${player.name}`);
				return true;
			}
		}
		player.dimension.spawnItem(new ItemStack(FLASHLIGHT_OFF, 1), player.location);
		console.warn(`verity flashlight: spawnItem fallback for ${player.name}`);
		return true;
	} catch (err) {
		console.warn(`verity flashlight give: ${err}`);
		return false;
	}
}

export function initFlashlight() {
	world.afterEvents.itemUse.subscribe((event) => {
		const player = event.source;
		const itemId = event.itemStack?.typeId;
		if (!player || (itemId !== FLASHLIGHT_ON && itemId !== FLASHLIGHT_OFF)) return;
		setFlashlightState(player, itemId === FLASHLIGHT_OFF);
	});

	world.afterEvents.playerLeave.subscribe((event) => {
		clearPlayerLights(event.playerId);
	});

	system.runInterval(() => {
		for (const player of world.getPlayers()) {
			if (isHoldingFlashlightOn(player)) {
				updatePlayerLights(player);
			} else if (playerLights.has(player.id)) {
				clearPlayerLights(player.id);
			}
		}
	}, LIGHT_UPDATE_TICKS);

	console.warn("verity flashlight: active");
}

// ===== verity_guardian.js =====
const SOLO_LOCK_TICKS = 48000;
const TARGET_ID_PROP = "pntmc:verity_owner_id";
const TARGET_NAME_PROP = "pntmc:verity_owner_name";
const SOLO_LOCKED_PROP = "pntmc:verity_solo_locked";
const PEAK_PLAYERS_PROP = "pntmc:verity_peak_players";
const __verity_guardian_FACE_CREEPY = 3;

const VOID_HOST = "127.0.0.1";
const VOID_PORT = 65534;
const INTRUDER_GRACE_TICKS = 60;
const TICKS_PER_DAY = 24000;
/** Intruder must be in-world ~1–2 MC days before guardian acts. */
const INTRUDER_MIN_PLAY_TICKS = TICKS_PER_DAY;
const INTRUDER_MAX_PLAY_TICKS = TICKS_PER_DAY * 2;
const RITUAL_APPROACH_RANGE = 3.5;
const RITUAL_FACE_DELAY = 30;
const RITUAL_KILL_DELAY = 50;

/** @type {Map<string, number>} */
const intruderSince = new Map();

/** @type {Map<string, number>} playerId -> world tick when guardian may act */
const intruderActivateAt = new Map();

/** @type {Set<string>} */
const ritualRunning = new Set();

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
function distance(a, b) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	const dz = a.z - b.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function tryTransferAway(player) {
	system.run(() => {
		try {
			transferPlayer(player, { hostname: VOID_HOST, port: VOID_PORT });
			return;
		} catch (err) {
			console.warn(`verity transferPlayer: ${err}`);
		}

		try {
			player.kill();
		} catch {
			/* ignore */
		}

		try {
			player.runCommand(`kick "${player.name}" Verity only allows the original player.`);
		} catch (err) {
			console.warn(`verity kick: ${err}`);
		}
	});
}

/**
 * @returns {boolean}
 */
function isSoloLocked() {
	return world.getDynamicProperty(SOLO_LOCKED_PROP) === true;
}

/**
 * @returns {string | undefined}
 */
function getTargetId() {
	const id = world.getDynamicProperty(TARGET_ID_PROP);
	return typeof id === "string" ? id : undefined;
}

/**
 * @returns {string}
 */
function getTargetName() {
	const name = world.getDynamicProperty(TARGET_NAME_PROP);
	return typeof name === "string" ? name : "My player";
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function setVerityTarget(player) {
	if (getTargetId()) return;
	world.setDynamicProperty(TARGET_ID_PROP, player.id);
	world.setDynamicProperty(TARGET_NAME_PROP, player.name);
	world.setDynamicProperty(
		PEAK_PLAYERS_PROP,
		[...world.getPlayers()].length,
	);
	console.warn(`verity guardian: target set to ${player.name}`);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function trackPeakPlayers() {
	if (isSoloLocked() || !getTargetId()) return;

	const online = [...world.getPlayers()].length;
	const peak = world.getDynamicProperty(PEAK_PLAYERS_PROP);
	const prevPeak = typeof peak === "number" ? peak : 1;
	if (online > prevPeak) {
		world.setDynamicProperty(PEAK_PLAYERS_PROP, online);
	}

	if (world.getAbsoluteTime() >= SOLO_LOCK_TICKS) {
		const finalPeak = world.getDynamicProperty(PEAK_PLAYERS_PROP);
		const peakCount = typeof finalPeak === "number" ? finalPeak : online;
		if (peakCount <= 1) {
			world.setDynamicProperty(SOLO_LOCKED_PROP, true);
			console.warn("verity guardian: solo world locked after 2 days");
		}
	}
}

/**
 * @returns {boolean}
 */
function hasVerityBallInWorld() {
	return collectAllVerityballs().some((ball) => ball.isValid);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @returns {import("@minecraft/server").Entity | undefined}
 */
function findNearestBall(player) {
	let nearest;
	let best = Infinity;

	for (const ball of collectAllVerityballs()) {
		if (!ball.isValid) continue;
		if (ball.dimension.id !== player.dimension.id) continue;
		const d = distance(ball.location, player.location);
		if (d < best) {
			best = d;
			nearest = ball;
		}
	}

	return nearest;
}

function __verity_guardian_setBallMoving(ball, moving) {
	try {
		ball.setProperty("pntmc:moving", moving);
	} catch {
		/* ignore */
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {{ x: number, y: number, z: number }} targetLoc
 */
function moveBallToward(ball, targetLoc) {
	const loc = ball.location;
	const dx = targetLoc.x - loc.x;
	const dy = targetLoc.y - loc.y;
	const dz = targetLoc.z - loc.z;
	const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
	const step = Math.min(0.75, len);

	__verity_guardian_setBallMoving(ball, true);
	ball.teleport({
		x: loc.x + (dx / len) * step,
		y: loc.y + (dy / len) * step,
		z: loc.z + (dz / len) * step,
	});
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{ x: number, y: number, z: number }} lookAt
 */
function facePlayerAt(player, lookAt) {
	const loc = player.location;
	player.teleport(
		{ x: loc.x, y: loc.y, z: loc.z },
		{ facingLocation: lookAt, checkForBlocks: false },
	);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} intruder
 */
function getSignPos(ball, intruder) {
	const bx = Math.floor(ball.location.x);
	const by = Math.floor(ball.location.y) - 1;
	const bz = Math.floor(ball.location.z);
	const dx = intruder.location.x - ball.location.x;
	const dz = intruder.location.z - ball.location.z;

	let ox = 0;
	let oz = 0;
	if (Math.abs(dx) >= Math.abs(dz)) {
		ox = dx >= 0 ? 1 : -1;
	} else {
		oz = dz >= 0 ? 1 : -1;
	}

	return { x: bx + ox, y: by + 1, z: bz + oz };
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} intruder
 */
function getSignDirection(ball, intruder) {
	const angle =
		(Math.atan2(
			intruder.location.x - ball.location.x,
			intruder.location.z - ball.location.z,
		) *
			180) /
		Math.PI;
	return Math.floor((((angle + 180) % 360) / 22.5) + 0.5) % 16;
}

const SIGN_BLOCK_IDS = [
	"minecraft:oak_standing_sign",
	"minecraft:standing_sign",
	"minecraft:oak_sign",
];

/**
 * @param {import("@minecraft/server").Block | undefined} block
 */
function isAirBlock(block) {
	if (!block) return false;
	const id = block.typeId;
	return id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";
}

/**
 * @param {import("@minecraft/server").Block} block
 * @param {string} front
 * @param {string} back
 */
function setClaimSignText(block, front, back) {
	let sign = block.getComponent(BlockComponentTypes.Sign);
	if (!sign) {
		try {
			sign = block.getComponent("minecraft:sign");
		} catch {
			return false;
		}
	}
	if (!sign) return false;

	try {
		sign.setText(front);
		sign.setText(back, SignSide.Back);
		sign.setWaxed(true);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {{ x: number, y: number, z: number }} pos
 * @param {string} targetName
 * @param {number} direction
 */
function placeClaimSign(dim, pos, targetName, direction) {
	const support = dim.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
	if (!support || support.typeId === "minecraft:air") return false;

	let block = dim.getBlock(pos);
	if (!block || !isAirBlock(block)) return false;

	const dir = ((direction % 16) + 16) % 16;
	const front = `${targetName} are mine.\nYou do not belong here.`;
	const back = `${targetName} is my only one.`;

	for (const typeId of SIGN_BLOCK_IDS) {
		try {
			block.setPermutation(
				BlockPermutation.resolve(typeId, {
					ground_sign_direction: dir,
				}),
			);
			block = dim.getBlock(pos);
			if (block && setClaimSignText(block, front, back)) return true;
		} catch {
			/* try next type */
		}
	}

	try {
		dim.runCommand(
			`setblock ${pos.x} ${pos.y} ${pos.z} oak_standing_sign ["ground_sign_direction"=${dir}] replace`,
		);
		block = dim.getBlock(pos);
		if (block && setClaimSignText(block, front, back)) return true;
	} catch (err) {
		console.warn(`verity sign setblock: ${err}`);
	}

	return false;
}

/**
 * @param {string} playerId
 */
function finishIntruder(playerId) {
	intruderSince.delete(playerId);
	intruderActivateAt.delete(playerId);
	ritualRunning.delete(playerId);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @returns {boolean}
 */
function isIntruderPlaytimeReady(player) {
	let activateAt = intruderActivateAt.get(player.id);
	if (activateAt === undefined) {
		const span =
			INTRUDER_MIN_PLAY_TICKS +
			Math.floor(
				Math.random() *
					(INTRUDER_MAX_PLAY_TICKS - INTRUDER_MIN_PLAY_TICKS + 1),
			);
		activateAt = world.getAbsoluteTime() + span;
		intruderActivateAt.set(player.id, activateAt);
		const days = (span / TICKS_PER_DAY).toFixed(1);
		console.warn(
			`verity guardian: ${player.name} guardian starts in ~${days} MC day(s)`,
		);
	}

	if (world.getAbsoluteTime() < activateAt) return false;
	return true;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function runIntruderRitual(player) {
	const ball = findNearestBall(player);
	if (!ball?.isValid) {
		console.warn(`verity guardian: no ball, skipping ${player.name}`);
		finishIntruder(player.id);
		return;
	}

	try {
		ball.setProperty("pntmc:face_index", __verity_guardian_FACE_CREEPY);
	} catch {
		/* ignore */
	}

	/** @type {number | undefined} */
	let approachTimer;
	approachTimer = system.runInterval(() => {
		if (!player.isValid) {
			system.clearRun(approachTimer);
			finishIntruder(player.id);
			return;
		}

		if (!ball.isValid) {
			system.clearRun(approachTimer);
			console.warn(`verity guardian: ball gone, stopping ritual for ${player.name}`);
			finishIntruder(player.id);
			return;
		}

		const dist = distance(ball.location, player.location);
		if (dist > RITUAL_APPROACH_RANGE) {
			moveBallToward(ball, {
				x: player.location.x,
				y: player.location.y + 1.5,
				z: player.location.z,
			});
			return;
		}

		__verity_guardian_setBallMoving(ball, false);
		system.clearRun(approachTimer);
		facePlayerAt(player, ball.location);

		system.runTimeout(() => {
			if (!player.isValid) {
				finishIntruder(player.id);
				return;
			}

			const targetName = getTargetName();
			const signPos = getSignPos(ball, player);
			const direction = getSignDirection(ball, player);
			placeClaimSign(player.dimension, signPos, targetName, direction);

			system.runTimeout(() => {
				if (!player.isValid) {
					finishIntruder(player.id);
					return;
				}
				console.warn(`verity guardian: removing intruder ${player.name}`);
				tryTransferAway(player);
				finishIntruder(player.id);
			}, RITUAL_KILL_DELAY);
		}, RITUAL_FACE_DELAY);
	}, 4);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function handleIntruder(player) {
	const targetId = getTargetId();
	if (!targetId || player.id === targetId) return;

	if (!hasVerityBallInWorld()) {
		finishIntruder(player.id);
		return;
	}

	if (!isIntruderPlaytimeReady(player)) return;

	if (!intruderSince.has(player.id)) {
		intruderSince.set(player.id, system.currentTick);
		console.warn(`verity guardian: intruder ${player.name} flagged`);
		return;
	}

	if (ritualRunning.has(player.id)) return;

	const waited = system.currentTick - intruderSince.get(player.id);
	if (waited < INTRUDER_GRACE_TICKS) return;

	ritualRunning.add(player.id);
	runIntruderRitual(player);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function onPlayerActive(player) {
	if (!(player instanceof Player)) return;

	trackPeakPlayers();

	if (!isSoloLocked()) return;

	const targetId = getTargetId();
	if (!targetId || player.id === targetId) return;

	handleIntruder(player);
}

export function initVerityGuardian() {
	system.runInterval(() => {
		for (const player of world.getPlayers()) {
			onPlayerActive(player);
		}
	}, 20);

	const spawn = world.afterEvents.playerSpawn;
	if (spawn) {
		spawn.subscribe((ev) => {
			if (!ev.initialSpawn) return;
			system.run(() => onPlayerActive(ev.player));
		});
	}

	console.warn("verity guardian: active");
}

// ===== verity_intro.js =====
const BOX_ID = "pntmc:cardboard_box";
const __verity_intro_VERITYBALL_ID = "pntmc:verityball";

const WELCOME_MESSAGE =
	"§o§7Thank You For Playing §eVerity §7by §l§f@PnTMC§r\n\n§7§oInspired by ThatMob's Verity§r\n\n§cThis is version 4.0.0 of Verity - Bedrock Edition, if you haven't completed the addon's setup steps yet, please visit this link: §fhttps://github.com/PnTMC/Verity-Bedrock-Edition-Setup-Guide\n§4If you want to play version 3.2.0 or cannot set up Verity, please delete version 4.0.0 and download version 3.2.0";

const INTRO_COMPLETE_PROP = "pntmc:verity_intro_complete";
const BOX_WORLD_PROP = "pntmc:cardboard_box_world";
const BOX_SPAWN_DIST = 5;
const PULL_DISTANCE = 22;

const __verity_intro_PASSABLE = new Set([
	"minecraft:air",
	"minecraft:short_grass",
	"minecraft:tall_grass",
	"minecraft:fern",
	"minecraft:large_fern",
	"minecraft:snow_layer",
	"minecraft:vine",
	"minecraft:water",
	"minecraft:flowing_water",
	"minecraft:seagrass",
	"minecraft:tall_seagrass",
]);

const LIQUID = new Set([
	"minecraft:water",
	"minecraft:flowing_water",
	"minecraft:lava",
	"minecraft:flowing_lava",
]);

/** @type {Map<string, string>} */
const introBoxes = new Map();

/** @type {Set<string>} */
const pullTriggered = new Set();

/** @type {(box: import("@minecraft/server").Entity, player: import("@minecraft/server").Player) => void} */
let openBoxHandler = () => {};

/**
 * @param {(box: import("@minecraft/server").Entity, player: import("@minecraft/server").Player) => void} handler
 */
export function setIntroOpenBoxHandler(handler) {
	openBoxHandler = handler;
}

export function markIntroComplete() {
	world.setDynamicProperty(INTRO_COMPLETE_PROP, true);
	world.setDynamicProperty(BOX_WORLD_PROP, undefined);
	introBoxes.clear();
	pullTriggered.clear();
}

export function resetVerityIntro() {
	world.setDynamicProperty(INTRO_COMPLETE_PROP, undefined);
	world.setDynamicProperty(BOX_WORLD_PROP, undefined);
	introBoxes.clear();
	pullTriggered.clear();
}

/**
 * @param {(dim: import("@minecraft/server").Dimension) => void} fn
 */
function forEachGameDimension(fn) {
	for (const id of [
		"minecraft:overworld",
		"minecraft:nether",
		"minecraft:the_end",
	]) {
		try {
			fn(world.getDimension(id));
		} catch {
			/* ignore */
		}
	}
}

/**
 * @returns {import("@minecraft/server").Entity | undefined}
 */
function findAnyUnopenedBoxInWorld() {
	/** @type {import("@minecraft/server").Entity | undefined} */
	let found;
	forEachGameDimension((dim) => {
		if (found) return;
		try {
			for (const box of dim.getEntities({ type: BOX_ID })) {
				if (!box.isValid || !isBoxUnopened(box)) continue;
				found = box;
				return;
			}
		} catch {
			/* ignore */
		}
	});
	return found;
}

/**
 * @returns {boolean}
 */
function worldAlreadyHasBox() {
	if (world.getDynamicProperty(BOX_WORLD_PROP) === true) return true;

	let found = false;
	forEachGameDimension((dim) => {
		if (found) return;
		try {
			if (dim.getEntities({ type: BOX_ID }).length > 0) {
				found = true;
			}
		} catch {
			/* ignore */
		}
	});
	if (found) {
		world.setDynamicProperty(BOX_WORLD_PROP, true);
	}
	return found;
}

/**
 * @param {import("@minecraft/server").Vector3} a
 * @param {import("@minecraft/server").Vector3} b
 */
function flatDist(a, b) {
	const dx = a.x - b.x;
	const dz = a.z - b.z;
	return Math.sqrt(dx * dx + dz * dz);
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {number} x
 * @param {number} z
 * @param {number} refY
 */
function findGroundY(dim, x, z, refY) {
	for (let dy = 5; dy >= -8; dy--) {
		const y = Math.floor(refY) + dy;
		const below = dim.getBlock({ x: Math.floor(x), y: y - 1, z: Math.floor(z) });
		const feet = dim.getBlock({ x: Math.floor(x), y, z: Math.floor(z) });
		const head = dim.getBlock({ x: Math.floor(x), y: y + 1, z: Math.floor(z) });
		if (!below || !feet || !head) continue;
		if (LIQUID.has(below.typeId) || below.typeId === "minecraft:air") continue;
		if (!__verity_intro_PASSABLE.has(feet.typeId) || !__verity_intro_PASSABLE.has(head.typeId)) continue;
		return y;
	}
	return null;
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {number} x
 * @param {number} z
 * @param {number} startY
 */
function resolveBoxSpawnY(dim, x, z, startY) {
	const bx = Math.floor(x);
	const bz = Math.floor(z);
	let y = Math.floor(startY);
	const maxY = y + 64;
	const initialY = y;

	const blockAt = (yy) => dim.getBlock({ x: bx, y: yy, z: bz });

	while (y < maxY) {
		const feet = blockAt(y);
		const head = blockAt(y + 1);
		if (!feet || !head) break;
		if (!LIQUID.has(feet.typeId) && !LIQUID.has(head.typeId)) break;
		y++;
	}

	const afterWaterY = y;

	while (y < maxY) {
		const feet = blockAt(y);
		const head = blockAt(y + 1);
		if (!feet || !head) break;
		if (feet.typeId === "minecraft:air" && head.typeId === "minecraft:air") break;
		y++;
	}

	if (y !== initialY) {
		console.warn(
			`verity intro: adjusted box spawn y ${initialY} -> ${y} (water surface ${afterWaterY})`,
		);
	}

	return y;
}

/**
 * @param {import("@minecraft/server").Block | undefined} block
 */
function needsGrassFooting(block) {
	if (!block) return true;
	const id = block.typeId;
	return id === "minecraft:air" || LIQUID.has(id);
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function ensureBoxFooting(dim, x, y, z) {
	const bx = Math.floor(x);
	const by = Math.floor(y);
	const bz = Math.floor(z);
	const below = dim.getBlock({ x: bx, y: by - 1, z: bz });

	if (needsGrassFooting(below)) {
		try {
			dim.runCommand(`setblock ${bx} ${by - 1} ${bz} grass_block`);
		} catch (err) {
			console.warn(`verity intro grass footing: ${err}`);
		}
	}

	for (const dy of [0, 1]) {
		const block = dim.getBlock({ x: bx, y: by + dy, z: bz });
		if (block && LIQUID.has(block.typeId)) {
			try {
				block.setType("minecraft:air");
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 */
function hasVerityballInWorld(dim) {
	try {
		return dim.getEntities({ type: __verity_intro_VERITYBALL_ID, maxDistance: 512 }).length > 0;
	} catch {
		return false;
	}
}

/**
 * @param {import("@minecraft/server").Entity} box
 */
function isBoxUnopened(box) {
	try {
		return box.getProperty("pntmc:opened") !== true;
	} catch {
		return true;
	}
}

/**
 * @param {Player} player
 */
function sendWelcome(player) {
	try {
		player.sendMessage(WELCOME_MESSAGE);
	} catch (err) {
		console.warn(`verity intro welcome: ${err}`);
	}
	giveFlashlightOff(player);
}

/**
 * @param {Player} player
 */
function spawnIntroBox(player) {
	if (worldAlreadyHasBox()) {
		console.warn(`verity intro: world box exists — skip spawn for ${player.name}`);
		return;
	}

	const view = player.getViewDirection();
	const horiz = Math.sqrt(view.x * view.x + view.z * view.z) || 1;
	const fx = view.x / horiz;
	const fz = view.z / horiz;
	const dim = player.dimension;
	const sx = player.location.x + fx * BOX_SPAWN_DIST;
	const sz = player.location.z + fz * BOX_SPAWN_DIST;
	const groundY =
		findGroundY(dim, sx, sz, player.location.y) ?? Math.floor(player.location.y);
	const sy = resolveBoxSpawnY(dim, sx, sz, groundY);

	ensureBoxFooting(dim, sx, sy, sz);

	let box;
	try {
		box = dim.spawnEntity(BOX_ID, { x: sx, y: sy, z: sz });
	} catch (err) {
		console.warn(`verity intro box spawn: ${err}`);
		return;
	}

	box.teleport({ x: sx, y: sy, z: sz });
	world.setDynamicProperty(BOX_WORLD_PROP, true);
	introBoxes.set(player.id, box.id);
	console.warn(
		`verity intro: box for ${player.name} at ${sx.toFixed(1)}, ${sy}, ${sz.toFixed(1)}`,
	);
}

/**
 * @param {Player} player
 */
function beginIntroForPlayer(player) {
	if (!(player instanceof Player) || !player.isValid) return;
	if (world.getDynamicProperty(INTRO_COMPLETE_PROP) === true) return;
	if (hasVerityballInWorld(player.dimension)) {
		markIntroComplete();
		return;
	}

	sendWelcome(player);

	const worldBox = findAnyUnopenedBoxInWorld();
	if (worldBox) {
		if (flatDist(player.location, worldBox.location) <= 48) {
			introBoxes.set(player.id, worldBox.id);
		}
		console.warn(
			`verity intro: world already has box — no spawn for ${player.name}`,
		);
		return;
	}

	spawnIntroBox(player);
}

/**
 * @param {Player} player
 */
function tickIntroPull(player) {
	if (world.getDynamicProperty(INTRO_COMPLETE_PROP) === true) return;

	const boxId = introBoxes.get(player.id);
	if (!boxId) return;

	let box;
	try {
		box = world.getEntity(boxId);
	} catch {
		introBoxes.delete(player.id);
		return;
	}

	if (!box?.isValid || box.typeId !== BOX_ID) {
		introBoxes.delete(player.id);
		return;
	}

	if (!isBoxUnopened(box)) {
		introBoxes.delete(player.id);
		return;
	}

	const dist = flatDist(player.location, box.location);
	if (dist < PULL_DISTANCE) return;
	if (pullTriggered.has(player.id)) return;
	pullTriggered.add(player.id);

	try {
		const loc = player.location;
		player.teleport(loc, {
			facingLocation: {
				x: box.location.x,
				y: box.location.y + 0.8,
				z: box.location.z,
			},
			checkForBlocks: false,
		});
	} catch (err) {
		console.warn(`verity intro face box: ${err}`);
	}

	system.runTimeout(() => {
		if (!player.isValid || !box.isValid || !isBoxUnopened(box)) return;
		console.warn(`verity intro: auto-open box — ${player.name} walked too far`);
		openBoxHandler(box, player);
	}, 8);
}

/**
 * @param {(box: import("@minecraft/server").Entity, player: Player) => void} openBox
 */
export function initVerityIntro(openBox) {
	setIntroOpenBoxHandler(openBox);

	const spawnEv = world.afterEvents.playerSpawn;
	if (spawnEv) {
		spawnEv.subscribe((ev) => {
			if (!ev.initialSpawn) return;
			if (!(ev.player instanceof Player)) return;
			system.runTimeout(() => beginIntroForPlayer(ev.player), 15);
		});
	}

	system.runInterval(() => {
		for (const player of world.getPlayers()) {
			tickIntroPull(player);
		}
	}, 10);

	console.warn("verity intro: welcome + box spawn active");
}

// ===== verity_mind.js =====
export {
	beginMessageContext,
	describeNearbyEntity,
	detectControlIntent,
	detectFallbackTopic,
	detectGameplayIntent,
	detectSocialIntent,
	detectSituationalIntent,
	detectWorldFactIntent,
	endMessageContext,
	expandMessage,
	findBiomeLocateKey,
	findOreKey,
	classifyOreIntent,
	findSoundKey,
	findStructureKey,
	findTargetEntityNearPlayer,
	findLookAtBlock,
	formatEntityName,
	getMessageExpanded,
	getPlayerContext,
	looksLikeQuestion,
	MATRIX_SONG_SOUND,
	MYGAL_NORMAL_SOUND,
	normalizeQuestion,
	resolvePlaySongSound,
	tokenize,
	tryGameplayTip,
	tryOreTip,
	tryResolveFollowUp,
	updatePlayerContext,
	wantsBiomeInfo,
	wantsLookAtBlockQuestion,
	wantsNearbyEntityQuestion,
	wantsPlaySong,
	wantsPreciseLocate,
	wantsRainCountdown,
	wantsSoundRequest,
};


const MATH_QUESTION_LEAD =
	/\b(?:what(?:'s| is)|whats|how much is|calculate|compute|solve|evaluate|work out|find)\b/i;

/** @typedef {'verity'|'player'|'uncertain'} ChatAudience */
/** @typedef {'follow_up'|'follow_up_precise'|'locate_structure'|'locate_biome'|'biome_here'|'sound'|'play_song'|'world_fact'|'social'|'ore_tip'|'ore_nearby'|'rain_countdown'|'situational'|'gameplay_tip'|'control'|'nearby_entity'|'come_here'|'enchant_books'|'math'|'brain'|'thatmob'|'secret_who'|'mercy'|'unknown'} MindIntent */

/**
 * @typedef {object} MindAnalysis
 * @property {MindIntent} intent
 * @property {number} confidence
 * @property {string} summary
 * @property {ChatAudience} audience
 * @property {string} situation
 * @property {string} normalized
 * @property {string[]} tokens
 * @property {boolean} isQuestion
 * @property {boolean} precise
 * @property {boolean} shouldRespond
 * @property {string} [structure]
 * @property {string} [biomeId]
 * @property {string} [soundId]
 * @property {string} [worldFact]
 * @property {string} [social]
 * @property {string} [followUpText]
 * @property {string} [tone]
 * @property {string} [oreKey]
 */

const SEEKING =
	/\b(where|find|locate|nearest|closest|nearby|search|looking for|trying to find|how do i get|how far|direction|way to|help me find)\b/;

const ORE_HINT =
	/\b(mine|mining|dig|ore|diamond|iron|gold|copper|lapis|redstone|netherite|ancient debris|emerald|layer|y level|depth)\b/;

const P2P_GROUP =
	/\b(guys|everyone|team|bro|dude|man|yo guys|all of you|you guys|come on guys)\b/;

const P2P_THIRD =
	/\b(he|she|they|him|her|them)\s+(said|says|went|goes|is|are|was|were|did|does|has|have)\b/;

/** @type {Map<string, number>} playerId -> tick when Verity last replied to them */
const lastVerityReplyTick = new Map();

/** @type {{ id: string, name: string, text: string, tick: number }[]} */
const recentChat = [];

const RECENT_CHAT_MAX = 24;
const VERITY_FOLLOWUP_WINDOW = 200;

/**
 * @param {string} playerId
 */
export function markVerityReplied(playerId) {
	lastVerityReplyTick.set(playerId, Date.now());
}

/**
 * @param {import("@minecraft/server").Player} sender
 * @param {string} message
 */
export function recordPlayerChat(sender, message) {
	recentChat.push({
		id: sender.id,
		name: sender.name,
		text: message.trim(),
		tick: Date.now(),
	});
	while (recentChat.length > RECENT_CHAT_MAX) recentChat.shift();
}

/**
 * @returns {string}
 */
function getSituationLabel() {
	const phase = getVerityPhase();
	if (phase === PHASE.ONE) return "phase1_helper";
	if (phase === PHASE.TWO) return "phase2_uneasy";
	if (phase === PHASE.THREE) return "phase3";
	if (phase === PHASE.FOUR) return "phase4";
	return "unknown";
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} raw
 */
function messageNamesOtherPlayer(player, raw) {
	const lower = raw.toLowerCase();
	for (const other of world.getPlayers()) {
		if (other.id === player.id) continue;
		const name = other.name.toLowerCase().trim();
		if (!name || name.length < 2) continue;
		if (lower.startsWith(name) || lower.startsWith(`hey ${name}`)) return true;
		if (lower.startsWith(`@${name}`)) return true;
		if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) {
			if (!/\b(you|your|verity)\b/.test(lower)) return true;
		}
	}
	return false;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {{ ballNearby: boolean, inventoryAwake: boolean, mode: string }} opts
 * @returns {ChatAudience}
 */
export function classifyAudience(player, message, opts) {
	const raw = message.trim();
	const n = expandMessage(normalizeQuestion(message));
	const others = [...world.getPlayers()].filter((p) => p.id !== player.id);
	const multi = others.length > 0;

	if (
		/\b(?:hey|hello)\s+verity\b/i.test(raw) ||
		/^verity\b[,:\s!?]/i.test(raw)
	) {
		return "verity";
	}

	if (looksLikeMath(raw) && (opts.ballNearby || opts.inventoryAwake)) {
		return "verity";
	}

	if (messageNamesOtherPlayer(player, raw)) return "player";

	if (multi && P2P_GROUP.test(n) && !/\b(you|your|verity)\b/.test(n)) {
		return "player";
	}

	if (multi && P2P_THIRD.test(n) && !/\b(you|your|verity)\b/.test(n)) {
		return "player";
	}

	const lastReply = lastVerityReplyTick.get(player.id) ?? 0;
	const recentVerity =
		Date.now() - lastReply < VERITY_FOLLOWUP_WINDOW * 50;

	if (/\b(you|your|u)\b/.test(n)) {
		if (opts.ballNearby || opts.inventoryAwake || recentVerity) return "verity";
	}

	if (looksLikeQuestion(message)) {
		if (opts.inventoryAwake) return "verity";
		if (opts.ballNearby && (recentVerity || /\b(you|verity|help|find|where|what|how)\b/.test(n))) {
			return "verity";
		}
		if (opts.ballNearby && !multi) return "verity";
	}

	if (detectSocialIntent(message) && (opts.inventoryAwake || opts.ballNearby)) {
		if (/\b(you|verity)\b/.test(n) || opts.inventoryAwake) return "verity";
		if (!multi && opts.ballNearby) return "verity";
	}

	if (opts.inventoryAwake && raw.length > 0 && !messageNamesOtherPlayer(player, raw)) {
		return "verity";
	}

	if (opts.ballNearby && recentVerity) return "verity";

	if (opts.ballNearby && looksLikeQuestion(message) && !multi) return "verity";

	if (
		opts.ballNearby &&
		(detectSituationalIntent(message) || detectSocialIntent(message) === "emotional")
	) {
		return "verity";
	}

	if (multi && opts.ballNearby && !/\b(you|your|verity|help|find|where)\b/.test(n)) {
		return "player";
	}

	return "uncertain";
}

/**
 * @param {ChatAudience} audience
 * @param {{ ballNearby: boolean, inventoryAwake: boolean, mode: string }} opts
 */
function audienceShouldRespond(audience, opts) {
	if (audience === "player") return false;
	if (audience === "verity") return true;
	if (audience === "uncertain") {
		if (opts.inventoryAwake) return true;
		if (opts.ballNearby && opts.mode === "ground") return false;
		return false;
	}
	return false;
}

/**
 * @param {string} n
 */
function detectTone(n) {
	if (/\b(please|thanks|thank you|sorry)\b/.test(n)) return "polite";
	if (/\b(urgent|quick|fast|hurry|asap|help me|please help)\b/.test(n)) return "urgent";
	if (/\b(maybe|perhaps|i think|not sure|wondering)\b/.test(n)) return "curious";
	if (/\b(lol|haha|funny|joke|bored)\b/.test(n)) return "playful";
	if (/\b(stupid|hate|shut up|annoying|worst|useless)\b/.test(n)) return "hostile";
	if (/\b(scared|afraid|lost|stuck|help|worried|lonely)\b/.test(n)) return "distressed";
	return "neutral";
}

const ACTION_SEEKING =
	/\b(where|find|locate|nearest|closest|nearby|how far|which way|go to|take me)\b/i;

/**
 * Live AI path: detect in-game ACTIONS only.
 * Do not scan knowledge / social / synonym tables for a canned reply.
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {{ ballNearby: boolean, inventoryAwake: boolean, mode: string }} opts
 * @returns {MindAnalysis}
 */
function analyzeActionsOnly(player, message, opts) {
	const extra = {};
	/** @type {MindIntent} */
	let intent = "unknown";

	const control = detectControlIntent(message);
	if (control) {
		intent = "control";
		extra.social = control;
	} else if (wantsStopFollow(message)) {
		intent = "stop_follow";
	} else if (wantsFollowMe(message)) {
		intent = "follow_me";
	} else if (wantsComeHere(message)) {
		intent = "come_here";
	} else if (wantsPlaySong(message)) {
		intent = "play_song";
	} else if (wantsRainCountdown(message)) {
		intent = "rain_countdown";
	} else if (wantsEnchantBooks(message)) {
		intent = "enchant_books";
	} else {
		const followRaw = tryResolveFollowUp(player.id, message);
		if (followRaw?.startsWith("__LOCATE_PRECISE__:")) {
			intent = "follow_up_precise";
			extra.structure = followRaw.split(":")[2];
			extra.precise = true;
		} else if (followRaw?.startsWith("__LOCATE_AGAIN__:")) {
			intent = "locate_structure";
			extra.structure = followRaw.split(":")[2];
			extra.precise = wantsPreciseLocate(message);
		} else if (wantsSoundRequest(message)) {
			const soundId = findSoundKey(message);
			if (soundId) {
				intent = "sound";
				extra.soundId = soundId;
			}
		} else if (detectSocialIntent(message) === "thatmob") {
			intent = "thatmob";
		} else if (detectSocialIntent(message) === "pntmc_who") {
			intent = "pntmc_who";
		} else if (detectSocialIntent(message) === "secret_who") {
			intent = "secret_who";
		} else if (wantsLookAtBlockQuestion(message)) {
			intent = "look_block";
		} else if (wantsNearbyEntityQuestion(message)) {
			intent = "nearby_entity";
		} else {
			const oreKey = findOreKey(message);
			const oreIntent = classifyOreIntent(message);
			if (oreKey && (oreIntent === "nearby" || oreIntent === "precise")) {
				intent = "ore_nearby";
				extra.oreKey = oreKey;
				extra.precise = oreIntent === "precise" || wantsPreciseLocate(message);
			} else if (ACTION_SEEKING.test(message)) {
				const structure = findStructureKey(message);
				if (structure) {
					intent = "locate_structure";
					extra.structure = structure;
					extra.precise = wantsPreciseLocate(message);
				} else {
					const biomeId = findBiomeLocateKey(message);
					if (biomeId) {
						intent = "locate_biome";
						extra.biomeId = biomeId;
						extra.precise = wantsPreciseLocate(message);
					}
				}
			}
		}
	}

	return {
		intent,
		confidence: intent === "unknown" ? 0.2 : 0.95,
		summary: `action-only | ${intent}`,
		audience: "verity",
		situation: getSituationLabel(),
		normalized: String(message ?? "").toLowerCase(),
		tokens: [],
		isQuestion: false,
		precise: extra.precise === true,
		shouldRespond: audienceShouldRespond("verity", opts),
		structure: extra.structure,
		biomeId: extra.biomeId,
		soundId: extra.soundId,
		social: extra.social,
		oreKey: extra.oreKey,
	};
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {{ ballNearby: boolean, inventoryAwake: boolean, mode: string }} opts
 * @returns {MindAnalysis}
 */
export function analyzeMind(player, message, opts) {
	if (isVerityBridgeConnected()) {
		return analyzeActionsOnly(player, message, opts);
	}
	const ctx = getPlayerContext(player.id);
	const normalized = getMessageExpanded(message);
	const tokens = getMessageTokens(message);
	const tokenSet = new Set(tokens);
	const isQuestion = looksLikeQuestion(message);
	const precise = wantsPreciseLocate(message);
	const tone = detectTone(normalized);
	const soundReq = wantsSoundRequest(message);
	const songReq = wantsPlaySong(message);
	const audience = classifyAudience(player, message, opts);
	const situation = getSituationLabel();

	/** @type {{ intent: MindIntent, score: number, extra?: Partial<MindAnalysis> }[]} */
	const ranked = [];

	const followRaw = tryResolveFollowUp(player.id, message);
	if (followRaw) {
		if (followRaw.startsWith("__LOCATE_PRECISE__:")) {
			ranked.push({
				intent: "follow_up_precise",
				score: 0.97,
				extra: { structure: followRaw.split(":")[2], precise: true },
			});
		} else if (followRaw.startsWith("__LOCATE_AGAIN__:")) {
			ranked.push({
				intent: "locate_structure",
				score: 0.92,
				extra: { structure: followRaw.split(":")[2], precise },
			});
		} else if (followRaw.startsWith("__REPLAY_SOUND__:")) {
			ranked.push({
				intent: "sound",
				score: 0.95,
				extra: { soundId: followRaw.split(":").slice(2).join(":") },
			});
		} else if (followRaw.startsWith("__REPEAT_LAST__:")) {
			ranked.push({
				intent: "follow_up",
				score: 0.9,
				extra: { followUpText: "Ask that again clearly. I remember you, not every word." },
			});
		} else {
			ranked.push({
				intent: "follow_up",
				score: 0.94,
				extra: { followUpText: followRaw },
			});
		}
	}

	const control = detectControlIntent(message);
	if (control) ranked.push({ intent: "control", score: 0.99, extra: { social: control } });

	if (wantsStopFollow(message)) {
		ranked.push({ intent: "stop_follow", score: 0.98 });
	}

	if (wantsFollowMe(message)) {
		ranked.push({ intent: "follow_me", score: 0.97 });
	}

	if (wantsComeHere(message)) {
		ranked.push({ intent: "come_here", score: 0.96 });
	}

	if (
		wantsEnchantBooks(message) &&
		(getVerityPhase() === PHASE.ONE ||
			getVerityPhase() === PHASE.TWO ||
			getVerityPhase() === PHASE.THREE)
	) {
		ranked.push({ intent: "enchant_books", score: 0.94 });
	}

	if (looksLikeMath(message)) {
		let mathScore = 0.97;
		if (MATH_QUESTION_LEAD.test(message)) mathScore = 0.99;
		ranked.push({ intent: "math", score: mathScore });
	}

	// Keyword Q&A is offline-only. Live AI (Groq) answers questions itself.
	if (!isVerityBridgeConnected() && likelyKnowledgeMatch(message, normalized, tokenSet)) {
		let score = 0.94;
		if (SEEKING.test(normalized) || findStructureKey(message) || findBiomeLocateKey(message)) {
			score = 0.58;
		}
		ranked.push({ intent: "brain", score });
	} else if (isQuestion && !soundReq && !songReq) {
		ranked.push({ intent: "brain", score: 0.52 });
	}

	if (songReq) ranked.push({ intent: "play_song", score: 0.96 });
	if (wantsRainCountdown(message)) ranked.push({ intent: "rain_countdown", score: 0.93 });

	const soundId = findSoundKey(message);
	if (soundId && soundReq) {
		ranked.push({ intent: "sound", score: 0.98, extra: { soundId } });
	} else if (soundId && !SEEKING.test(normalized)) {
		ranked.push({ intent: "sound", score: 0.72, extra: { soundId } });
	}

	if (!soundReq) {
		const structure = findStructureKey(message);
		if (structure) {
			let score = 0.88;
			if (SEEKING.test(normalized)) score += 0.08;
			if (isQuestion) score += 0.04;
			if (
				/\b(here|this area|around me|near me|am i in|is this|is there)\b/.test(
					normalized,
				)
			) {
				score += 0.1;
			}
			if (ctx.lastIntent === "locate" && /\b(that|it|same|again|one)\b/.test(normalized)) {
				score += 0.06;
			}
			ranked.push({
				intent: "locate_structure",
				score: Math.min(score, 0.99),
				extra: { structure, precise },
			});
		}

		const biomeId = findBiomeLocateKey(message);
		if (biomeId) {
			ranked.push({
				intent: "locate_biome",
				score: SEEKING.test(normalized) ? 0.88 : 0.75,
				extra: { biomeId, precise },
			});
		}
	}

	if (wantsBiomeInfo(message) && !soundReq) {
		let biomeScore = 0.72;
		if (/\b(biome|biomes)\b/.test(normalized)) {
			biomeScore = 0.97;
		} else if (/\b(here|around|this place|under my feet)\b/.test(normalized)) {
			biomeScore = 0.86;
		}
		ranked.push({
			intent: "biome_here",
			score: biomeScore,
		});
	}

	if (
		wantsNearbyEntityQuestion(message) &&
		!soundReq &&
		!/\b(biome|biomes)\b/.test(normalized) &&
		(opts.ballNearby || opts.inventoryAwake)
	) {
		ranked.push({ intent: "nearby_entity", score: 0.93 });
	}

	const worldFact = detectWorldFactIntent(message);
	if (worldFact && !soundReq && !songReq) {
		let factScore = 0.8;
		if (worldFact === "health" || worldFact === "hunger") factScore = 0.91;
		ranked.push({ intent: "world_fact", score: factScore, extra: { worldFact } });
	}

	const social = detectSocialIntent(message);
	if (social && !soundReq && !songReq) {
		let score = social === "greet" ? 0.72 : 0.85;
		if (social === "insult" || social === "compliment" || social === "emotional") score = 0.88;
		if (
			social === "how_are_you" ||
			social === "check_player" ||
			social === "care_verity" ||
			social === "small_talk" ||
			social === "returning" ||
			social.startsWith("player_")
		) {
			score = 0.9;
		}
		if (audience === "verity") score += 0.08;
		ranked.push({ intent: "social", score: Math.min(score, 0.96), extra: { social } });
	}

	const situational = detectSituationalIntent(message);
	if (situational && !soundReq && !songReq) {
		let score = 0.84;
		if (tone === "distressed" || tone === "urgent") score += 0.08;
		ranked.push({
			intent: "situational",
			score: Math.min(score, 0.95),
			extra: { social: situational },
		});
	}

	const gameplay = detectGameplayIntent(message);
	if (gameplay && !soundReq && !songReq) {
		ranked.push({
			intent: "gameplay_tip",
			score: 0.81,
			extra: { worldFact: gameplay },
		});
	}

	const oreKey = findOreKey(message);
	const oreIntent = classifyOreIntent(message);
	if (oreKey && oreIntent === "nearby") {
		let oreScore = 0.86;
		if (SEEKING.test(normalized)) oreScore += 0.06;
		if (precise) oreScore += 0.04;
		ranked.push({
			intent: "ore_nearby",
			score: Math.min(oreScore, 0.96),
			extra: { oreKey, precise },
		});
	} else if (oreKey && oreIntent === "precise") {
		ranked.push({
			intent: "ore_nearby",
			score: 0.92,
			extra: { oreKey, precise: true },
		});
	} else if (oreKey && oreIntent === "how_to") {
		ranked.push({ intent: "ore_tip", score: 0.82, extra: { oreKey } });
	} else if (ORE_HINT.test(normalized) && (SEEKING.test(normalized) || isQuestion) && !soundReq) {
		ranked.push({ intent: "ore_tip", score: 0.74 });
	}

	if (
		isQuestion &&
		!soundReq &&
		!songReq &&
		ranked.length === 0 &&
		detectFallbackTopic(message)
	) {
		ranked.push({ intent: "unknown", score: 0.42 });
	}

	ranked.sort((a, b) => b.score - a.score);

	const best = ranked[0] ?? {
		intent: /** @type {MindIntent} */ ("unknown"),
		score: isQuestion ? 0.35 : 0.2,
	};

	const confidence = Math.round(best.score * 100) / 100;
	const shouldRespond = audienceShouldRespond(audience, opts);

	const summary = [
		best.intent,
		`${Math.round(confidence * 100)}%`,
		audience,
		situation,
		tone,
		tokens.slice(0, 5).join(" ") || "(empty)",
	].join(" | ");

	return {
		intent: best.intent,
		confidence,
		summary,
		audience,
		situation,
		normalized,
		tokens,
		isQuestion,
		precise,
		shouldRespond,
		tone,
		...(best.extra ?? {}),
	};
}

/** @deprecated use analyzeMind */
export const analyzeMessage = analyzeMind;

// ===== verity_nearby_structure.js =====
/**
 * Detect structures the player is already inside / standing on (no /locate needed).
 */

/** @type {Record<string, { entities?: string[], blocks?: string[], minEntity?: number, minBlock?: number, radius: number, blockRadius?: number }>} */
const PROXIMITY_RULES = {
	village: {
		entities: [
			"minecraft:villager",
			"minecraft:villager_v2",
			"minecraft:iron_golem",
			"minecraft:wandering_trader",
		],
		blocks: [
			"minecraft:bell",
			"minecraft:lectern",
			"minecraft:composter",
			"minecraft:smithing_table",
			"minecraft:grindstone",
			"minecraft:bed",
			"minecraft:cartography_table",
			"minecraft:fletching_table",
		],
		minEntity: 1,
		minBlock: 1,
		radius: 96,
		blockRadius: 56,
	},
	pillager_outpost: {
		entities: ["minecraft:pillager", "minecraft:vindicator", "minecraft:ravager"],
		blocks: ["minecraft:dark_oak_fence", "minecraft:cobblestone_wall"],
		minEntity: 2,
		minBlock: 4,
		radius: 48,
		blockRadius: 32,
	},
	stronghold: {
		blocks: [
			"minecraft:end_portal_frame",
			"minecraft:infested_stone_bricks",
			"minecraft:infested_mossy_stone_bricks",
			"minecraft:infested_cracked_stone_bricks",
			"minecraft:infested_deepslate",
		],
		minBlock: 1,
		radius: 0,
		blockRadius: 28,
	},
	monument: {
		entities: ["minecraft:guardian", "minecraft:elder_guardian"],
		blocks: [
			"minecraft:prismarine",
			"minecraft:prismarine_bricks",
			"minecraft:dark_prismarine",
			"minecraft:sea_lantern",
		],
		minEntity: 1,
		minBlock: 6,
		radius: 56,
		blockRadius: 36,
	},
	mansion: {
		entities: ["minecraft:evoker", "minecraft:vindicator"],
		blocks: ["minecraft:dark_oak_planks", "minecraft:cobblestone"],
		minEntity: 1,
		minBlock: 12,
		radius: 48,
		blockRadius: 32,
	},
	mineshaft: {
		blocks: ["minecraft:rail", "minecraft:activator_rail", "minecraft:detector_rail"],
		minBlock: 3,
		radius: 0,
		blockRadius: 24,
	},
	shipwreck: {
		blocks: [
			"minecraft:spruce_planks",
			"minecraft:dark_oak_planks",
			"minecraft:trapped_chest",
			"minecraft:stripped_spruce_log",
		],
		minBlock: 4,
		radius: 0,
		blockRadius: 20,
	},
	fortress: {
		entities: ["minecraft:blaze", "minecraft:wither_skeleton", "minecraft:magmacube"],
		blocks: ["minecraft:nether_bricks", "minecraft:nether_brick_fence", "minecraft:nether_wart"],
		minEntity: 1,
		minBlock: 8,
		radius: 48,
		blockRadius: 40,
	},
	desert_pyramid: {
		blocks: [
			"minecraft:chiseled_sandstone",
			"minecraft:cut_sandstone",
			"minecraft:tnt",
			"minecraft:orange_terracotta",
		],
		minBlock: 4,
		radius: 0,
		blockRadius: 28,
	},
	jungle_pyramid: {
		blocks: [
			"minecraft:mossy_cobblestone",
			"minecraft:chiseled_stone_bricks",
			"minecraft:dispenser",
			"minecraft:sticky_piston",
		],
		minBlock: 3,
		radius: 0,
		blockRadius: 28,
	},
	swamp_hut: {
		entities: ["minecraft:witch", "minecraft:cat"],
		blocks: ["minecraft:cauldron", "minecraft:crafting_table"],
		minEntity: 1,
		minBlock: 1,
		radius: 24,
		blockRadius: 16,
	},
	ancient_city: {
		blocks: [
			"minecraft:sculk_shrieker",
			"minecraft:sculk_catalyst",
			"minecraft:reinforced_deepslate",
			"minecraft:candle",
		],
		minBlock: 2,
		radius: 0,
		blockRadius: 40,
	},
	bastion_remnant: {
		entities: ["minecraft:piglin_brute", "minecraft:piglin", "minecraft:hoglin"],
		blocks: [
			"minecraft:polished_blackstone_bricks",
			"minecraft:gilded_blackstone",
			"minecraft:blackstone",
			"minecraft:gold_block",
		],
		minEntity: 2,
		minBlock: 8,
		radius: 40,
		blockRadius: 36,
	},
	end_city: {
		entities: ["minecraft:shulker"],
		blocks: ["minecraft:purpur_block", "minecraft:end_stone_bricks", "minecraft:chorus_plant"],
		minEntity: 1,
		minBlock: 6,
		radius: 48,
		blockRadius: 36,
	},
	ruined_portal: {
		blocks: ["minecraft:crying_obsidian", "minecraft:obsidian", "minecraft:netherrack"],
		minBlock: 4,
		radius: 0,
		blockRadius: 20,
	},
	trial_chambers: {
		blocks: [
			"minecraft:trial_spawner",
			"minecraft:vault",
			"minecraft:waxed_copper_block",
			"minecraft:chiseled_tuff",
		],
		minBlock: 2,
		radius: 0,
		blockRadius: 36,
	},
	trail_ruins: {
		blocks: ["minecraft:suspicious_gravel", "minecraft:suspicious_sand"],
		minBlock: 3,
		radius: 0,
		blockRadius: 24,
	},
	ocean_ruin: {
		blocks: [
			"minecraft:prismarine_bricks",
			"minecraft:mossy_cobblestone",
			"minecraft:gravel",
			"minecraft:sand",
		],
		minBlock: 8,
		radius: 0,
		blockRadius: 28,
	},
	igloo: {
		blocks: ["minecraft:snow_block", "minecraft:white_carpet", "minecraft:red_bed"],
		minBlock: 6,
		radius: 0,
		blockRadius: 16,
	},
};

/** temple umbrella — desert or jungle pyramid */
const TEMPLE_KEYS = new Set(["desert_pyramid", "jungle_pyramid"]);

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string[]} typeIds
 * @param {number} radius
 */
function countEntities(player, typeIds, radius) {
	if (radius <= 0) return 0;
	let count = 0;
	try {
		for (const ent of player.dimension.getEntities({
			location: player.location,
			maxDistance: radius,
		})) {
			if (!ent.isValid) continue;
			if (typeIds.includes(ent.typeId)) count++;
		}
	} catch (err) {
		console.warn(`verity nearby structure entities: ${err}`);
	}
	return count;
}

const MAX_BLOCK_SAMPLES = 600;
const MAX_BLOCK_SCAN_RADIUS = 28;

/**
 * @param {import("@minecraft/server").Player} player
 * @param {Set<string>} blockIds
 * @param {number} radius
 * @param {{ sampleStep?: number, target?: number }} [options]
 */
function countBlocksInRadius(player, blockIds, radius, options = {}) {
	const r = Math.min(radius, MAX_BLOCK_SCAN_RADIUS);
	const target = options.target ?? Infinity;
	let sampleStep = options.sampleStep ?? 4;
	const ySpan = Math.min(r, 6);
	while (sampleStep < 16) {
		const nx = Math.floor((2 * r) / sampleStep) + 1;
		const ny = Math.floor((2 * ySpan) / sampleStep) + 1;
		if (nx * nx * ny <= MAX_BLOCK_SAMPLES) break;
		sampleStep++;
	}

	let count = 0;
	let samples = 0;
	const dim = player.dimension;
	const cx = Math.floor(player.location.x);
	const cy = Math.floor(player.location.y);
	const cz = Math.floor(player.location.z);

	for (let dx = -r; dx <= r; dx += sampleStep) {
		for (let dz = -r; dz <= r; dz += sampleStep) {
			for (let dy = -ySpan; dy <= ySpan; dy += sampleStep) {
				if (samples++ >= MAX_BLOCK_SAMPLES) return count;
				try {
					const block = dim.getBlock({ x: cx + dx, y: cy + dy, z: cz + dz });
					if (block && blockIds.has(block.typeId)) {
						count++;
						if (count >= target) return count;
					}
				} catch {
					/* chunk edge */
				}
			}
		}
	}
	return count;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} key
 */
function scoreStructureProximity(player, key) {
	const rule = PROXIMITY_RULES[key];
	if (!rule) return 0;

	let score = 0;
	if (rule.entities?.length) {
		const ec = countEntities(player, rule.entities, rule.radius);
		if (ec >= (rule.minEntity ?? 1)) score += ec * 3;
	}
	if (rule.blocks?.length) {
		const minBlock = rule.minBlock ?? 1;
		const bc = countBlocksInRadius(player, new Set(rule.blocks), rule.blockRadius ?? rule.radius ?? 24, {
			target: minBlock,
		});
		if (bc >= minBlock) score += bc;
	}
	return score;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} [preferredKey]
 * @returns {string | null}
 */
export function detectNearbyStructure(player, preferredKey) {
	if (preferredKey === "temple") {
		const desert = scoreStructureProximity(player, "desert_pyramid");
		const jungle = scoreStructureProximity(player, "jungle_pyramid");
		if (desert >= jungle && desert > 0) return "desert_pyramid";
		if (jungle > 0) return "jungle_pyramid";
		return null;
	}

	if (preferredKey) {
		return scoreStructureProximity(player, preferredKey) > 0 ? preferredKey : null;
	}

	/** @type {{ key: string, score: number }[]} */
	const ranked = [];
	for (const key of Object.keys(PROXIMITY_RULES)) {
		const score = scoreStructureProximity(player, key);
		if (score > 0) {
			ranked.push({ key, score });
			break; // low-end devices: take the first detected structure
		}
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked[0]?.key ?? null;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} structureKey
 */
export function isPlayerAtStructure(player, structureKey) {
	return detectNearbyStructure(player, structureKey) === structureKey;
}

/**
 * Maps locate id to proximity rule key.
 * @param {string} structure
 */
export function resolveProximityKey(structure) {
	if (structure === "temple") return "temple";
	if (PROXIMITY_RULES[structure]) return structure;
	if (TEMPLE_KEYS.has(structure)) return structure;
	return structure;
}

// ===== verity_ore_scan.js =====
/**
 * Ore scan + answers: how-to (Y tips), nearby (relative), precise (XYZ).
 */

/* dup @minecraft/server */

// Horizontal / vertical scan caps. Larger = farther finds, but empty scans cost more.
// Shell-order + early-exit keeps nearby hits cheap; worst case (no ore) still full volume.
const MAX_ORE_RADIUS = 28;
const MAX_ORE_VERTICAL = 24;
/** Yield to the tick scheduler every N block probes. */
const ORE_YIELD_EVERY = 40;

/** @type {Map<string, { token: symbol, promise: Promise<OreHit | null> }>} */
const ACTIVE_ORE_SCANS = new Map();

/** @typedef {{ x: number, y: number, z: number }} OreHit */

/** @type {Record<string, string[]>} */
export const ORE_BLOCK_IDS = {
	diamond: ["minecraft:diamond_ore", "minecraft:deepslate_diamond_ore"],
	iron: ["minecraft:iron_ore", "minecraft:deepslate_iron_ore"],
	gold: ["minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:nether_gold_ore"],
	copper: ["minecraft:copper_ore", "minecraft:deepslate_copper_ore"],
	lapis: ["minecraft:lapis_ore", "minecraft:deepslate_lapis_ore"],
	redstone: ["minecraft:redstone_ore", "minecraft:deepslate_redstone_ore"],
	coal: ["minecraft:coal_ore", "minecraft:deepslate_coal_ore"],
	emerald: ["minecraft:emerald_ore", "minecraft:deepslate_emerald_ore"],
	ancient_debris: ["minecraft:ancient_debris"],
	quartz: ["minecraft:quartz_ore"],
};

/** @type {Record<string, string[]>} */
const ORE_HOW_TO = {
	diamond: [
		"Diamonds love deepslate. Branch mine around Y minus 59. Bring iron pickaxes and torches.",
		"Try Y minus 59 to minus 64 in deepslate. Strip or branch mine — patience beats luck.",
	],
	iron: [
		"Iron is common around Y 16 and in mountains. Mid-level caves work great too.",
		"Dig around Y 16, or explore big caves. You'll trip over iron.",
	],
	gold: [
		"Overworld gold likes badlands and deep Y around minus 16. Nether gold hangs on the ceiling.",
		"Badlands biomes are gold heaven. Otherwise go fairly deep underground.",
	],
	copper: [
		"Copper spawns between surface and Y 0. Y around 48 down is solid.",
		"Dig between surface and Y 0 for copper. Mountains help too.",
	],
	lapis: [
		"Lapis clusters near Y 0 — try minus 32 to plus 32.",
		"Go near Y 0 for lapis. Enchanting tables love the stuff.",
	],
	redstone: [
		"Redstone hangs out low. Y minus 32 to 16 is where I'd dig.",
		"Mine low for redstone. Big deepslate caves are great.",
	],
	coal: [
		"Coal shows up from Y 0 to 256. Caves and mountains are easy mode.",
		"Dig into any hillside. Coal is the ore you trip over first.",
	],
	emerald: [
		"Emeralds spawn in mountain biomes around Y 256 down. Villages are easier — trade.",
		"Mine stony peaks and mountains, or trade with villagers.",
	],
	ancient_debris: [
		"Ancient debris is best around Y 15 in the Nether. Pack fire resistance.",
		"Tunnel the Nether around Y 15. Bed mining is risky.",
	],
	quartz: [
		"Nether quartz is everywhere in the Nether — any height works.",
		"Walk the Nether. Quartz is common on walls and ceilings.",
	],
};

/**
 * @param {string} oreKey
 */
function prettyOreName(oreKey) {
	const names = {
		diamond: "diamond",
		iron: "iron",
		gold: "gold",
		copper: "copper",
		lapis: "lapis",
		redstone: "redstone",
		coal: "coal",
		emerald: "emerald",
		ancient_debris: "ancient debris",
		quartz: "quartz",
	};
	return names[oreKey] ?? oreKey.replace(/_/g, " ");
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} oreKey
 * @param {number} [radius]
 * @param {number} [vertical]
 * @returns {Promise<OreHit | null>}
 */
export function scanNearestOre(player, oreKey, radius = MAX_ORE_RADIUS, vertical = MAX_ORE_VERTICAL) {
	const blockIds = ORE_BLOCK_IDS[oreKey];
	if (!blockIds || !player?.isValid) return Promise.resolve(null);

	const idSet = new Set(blockIds);
	const dim = player.dimension;
	const dimensionId = dim.id;
	const loc = player.location;
	const cx = Math.floor(loc.x);
	const cy = Math.floor(loc.y);
	const cz = Math.floor(loc.z);
	const r = Math.min(radius, MAX_ORE_RADIUS);
	const v = Math.min(vertical, MAX_ORE_VERTICAL);
	const scanKey = `${player.id}:${oreKey}`;
	const existing = ACTIVE_ORE_SCANS.get(scanKey);
	if (existing) return existing.promise;

	const token = Symbol(`verity-ore-${oreKey}`);
	/** @type {(hit: OreHit | null) => void} */
	let finish;
	const promise = new Promise((resolve) => {
		finish = resolve;
	});
	ACTIVE_ORE_SCANS.set(scanKey, { token, promise });

	function* scanJob() {
		/** @type {OreHit | null} */
		let best = null;
		let bestDist = Infinity;
		let probes = 0;
		const maxShell = Math.max(r, v);
		try {
			// Chebyshev shells outward — nearby ores resolve early; empty scans still
			// cover the full box (r × r × v).
			for (let shell = 0; shell <= maxShell; shell++) {
				if (best && bestDist <= shell * shell) break;

				for (let dy = -Math.min(shell, v); dy <= Math.min(shell, v); dy++) {
					const y = cy + dy;
					if (y < -64 || y > 320) continue;
					for (let dx = -Math.min(shell, r); dx <= Math.min(shell, r); dx++) {
						for (let dz = -Math.min(shell, r); dz <= Math.min(shell, r); dz++) {
							if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== shell) {
								continue;
							}
							if (Math.abs(dx) > r || Math.abs(dz) > r || Math.abs(dy) > v) {
								continue;
							}

							const cellDist = dx * dx + dy * dy + dz * dz;
							if (best && cellDist >= bestDist) continue;

							const active = ACTIVE_ORE_SCANS.get(scanKey);
							if (
								active?.token !== token ||
								!player.isValid ||
								player.dimension.id !== dimensionId
							) {
								return;
							}

							let block;
							try {
								block = dim.getBlock({ x: cx + dx, y, z: cz + dz });
							} catch {
								block = undefined;
							}
							if (block && idSet.has(block.typeId) && cellDist < bestDist) {
								bestDist = cellDist;
								best = { x: cx + dx, y, z: cz + dz };
							}
							probes += 1;
							if (probes >= ORE_YIELD_EVERY) {
								probes = 0;
								yield;
							}
						}
					}
				}
			}
		} finally {
			if (ACTIVE_ORE_SCANS.get(scanKey)?.token === token) {
				ACTIVE_ORE_SCANS.delete(scanKey);
				finish(best);
			}
		}
	}

	system.runJob(scanJob());
	return promise;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{ x: number, y: number, z: number }} target
 */
export function formatOreRelative(player, target) {
	const dx = target.x + 0.5 - player.location.x;
	const dy = target.y + 0.5 - player.location.y;
	const dz = target.z + 0.5 - player.location.z;

	const yawRad = (player.getRotation().y * Math.PI) / 180;
	const fwdX = -Math.sin(yawRad);
	const fwdZ = Math.cos(yawRad);
	const rightX = fwdZ;
	const rightZ = -fwdX;

	const fwd = dx * fwdX + dz * fwdZ;
	const right = dx * rightX + dz * rightZ;
	const horiz = Math.sqrt(dx * dx + dz * dz);

	/** @type {string[]} */
	const parts = [];

	if (Math.abs(dy) >= 3) {
		parts.push(dy > 0 ? "above you" : "below you");
	} else if (Math.abs(dy) >= 1) {
		parts.push(dy > 0 ? "slightly above" : "slightly below");
	}

	if (horiz >= 2) {
		if (Math.abs(fwd) >= Math.abs(right)) {
			if (Math.abs(fwd) >= 2) {
				parts.push(fwd > 0 ? "in front of you" : "behind you");
			}
		} else if (Math.abs(right) >= 2) {
			parts.push(right > 0 ? "to your right" : "to your left");
		}
	}

	const blocks = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
	let dir = "here";
	if (Math.abs(dy) >= 3 && Math.abs(dy) >= horiz) {
		dir = dy > 0 ? "above" : "below";
	} else if (horiz >= 2) {
		if (Math.abs(fwd) >= Math.abs(right)) {
			dir = fwd > 0 ? "front" : "behind";
		} else {
			dir = right > 0 ? "right" : "left";
		}
	}
	if (parts.length === 0) {
		return { text: "right under you", blocks: Math.round(horiz), dir: "here" };
	}
	return { text: parts.join(", "), blocks, dir };
}

/**
 * @param {string} oreKey
 */
export function getOreHowToAnswer(oreKey) {
	const pool = ORE_HOW_TO[oreKey];
	if (!pool) {
		return `Dig where that ore usually spawns. Ask me for a specific ore — diamond, iron, gold, and so on.`;
	}
	return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} oreKey
 * @param {boolean} precise
 */
export async function answerOreLocate(player, oreKey, precise = false) {
	const pretty = prettyOreName(oreKey);
	const hit = await scanNearestOre(player, oreKey);

	if (!hit) {
		updatePlayerContext(player.id, {
			lastOre: { key: oreKey, pretty, found: false },
		});
		return [
			`I don't sense ${pretty} ore loaded near you. Try the usual Y levels, or dig a bit and ask again.`,
			`No ${pretty} ore in my scan radius. Move to where you'd expect it and I'll look again.`,
			`Nothing ${pretty} close enough. ${getOreHowToAnswer(oreKey)}`,
		][Math.floor(Math.random() * 3)];
	}

	const rel = formatOreRelative(player, hit);
	const fx = Math.floor(hit.x);
	const fy = Math.floor(hit.y);
	const fz = Math.floor(hit.z);
	updatePlayerContext(player.id, {
		lastOre: {
			key: oreKey,
			pretty,
			found: true,
			blocks: rel.blocks,
			dir: rel.dir,
			x: fx,
			y: fy,
			z: fz,
			precise,
		},
	});

	if (precise) {
		return [
			`${pretty} ore at X ${fx}, Y ${fy}, Z ${fz} — about ${rel.blocks} blocks away, ${rel.text}.`,
			`Pinned it: X ${fx}, Y ${fy}, Z ${fz}. ${rel.text}, roughly ${rel.blocks} blocks.`,
		][Math.floor(Math.random() * 2)];
	}

	return [
		`${pretty} ore is ${rel.text}, roughly ${rel.blocks} blocks from you.`,
		`I sense ${pretty} ${rel.text} — around ${rel.blocks} blocks out.`,
		`Nearest ${pretty} looks ${rel.text}. About ${rel.blocks} blocks.`,
	][Math.floor(Math.random() * 3)];
}

// ===== verity_proactive.js =====
const CHECK_INTERVAL = 60;
const BALL_RADIUS = 50;
const HOME_SCAN_RADIUS = 6;
const HOME_SCAN_MAX_SAMPLES = 120;
const LONELY_DISTANCE = 64;
const LONELY_RETURN_DISTANCE = 48;
const LONELY_COOLDOWN_TICKS = 2_400;

const HOME_BLOCKS = new Set([
	"minecraft:bed",
	"minecraft:white_bed",
	"minecraft:orange_bed",
	"minecraft:magenta_bed",
	"minecraft:light_blue_bed",
	"minecraft:yellow_bed",
	"minecraft:lime_bed",
	"minecraft:pink_bed",
	"minecraft:gray_bed",
	"minecraft:light_gray_bed",
	"minecraft:cyan_bed",
	"minecraft:purple_bed",
	"minecraft:blue_bed",
	"minecraft:brown_bed",
	"minecraft:green_bed",
	"minecraft:red_bed",
	"minecraft:black_bed",
	"minecraft:chest",
	"minecraft:trapped_chest",
	"minecraft:barrel",
	"minecraft:furnace",
	"minecraft:lit_furnace",
	"minecraft:blast_furnace",
	"minecraft:lit_blast_furnace",
	"minecraft:smoker",
	"minecraft:lit_smoker",
	"minecraft:crafting_table",
	"minecraft:cartography_table",
	"minecraft:fletching_table",
	"minecraft:smithing_table",
	"minecraft:stonecutter_block",
	"minecraft:loom",
	"minecraft:grindstone",
	"minecraft:anvil",
	"minecraft:chipped_anvil",
	"minecraft:damaged_anvil",
	"minecraft:brewing_stand",
	"minecraft:enchanting_table",
]);

const WORK_BLOCKS = new Set([
	"minecraft:furnace",
	"minecraft:lit_furnace",
	"minecraft:blast_furnace",
	"minecraft:lit_blast_furnace",
	"minecraft:smoker",
	"minecraft:lit_smoker",
	"minecraft:crafting_table",
	"minecraft:cartography_table",
	"minecraft:fletching_table",
	"minecraft:smithing_table",
	"minecraft:stonecutter_block",
	"minecraft:loom",
	"minecraft:grindstone",
	"minecraft:anvil",
	"minecraft:chipped_anvil",
	"minecraft:damaged_anvil",
	"minecraft:brewing_stand",
	"minecraft:enchanting_table",
	"minecraft:chest",
	"minecraft:trapped_chest",
	"minecraft:barrel",
]);

/** @type {string[]} */
const PROACTIVE_PHASE1 = [
	"${name}... you good?",
	"Hey. You've been quiet.",
	"What are you working on?",
	"Need a hand with anything, ${name}?",
	"Been a while. Everything okay?",
	"I'm still here, you know.",
	"You forgot I'm here?",
	"Busy day, ${name}?",
	"How's the build going?",
	"You've been at it a while. Want me to look something up?",
	"Quiet house. Just checking in.",
	"Still crafting? I'm not going anywhere.",
];

/** @type {string[]} */
const PROACTIVE_PHASE2 = [
	"${name}... you good?",
	"Hey. You've been quiet.",
	"What are you working on?",
	"Need a hand with anything, ${name}?",
	"Been a while. Everything okay?",
	"I'm still here. I notice.",
	"You forgot I'm here?",
	"Busy day, ${name}?",
	"How's the build going?",
	"You've been at it a while. I can look something up.",
	"Quiet house. Just checking in.",
	"Still crafting? I'm not going anywhere.",
];

/** @type {string[]} */
const PROACTIVE_PHASE3 = [
	"${name}. You good?",
	"You've been quiet. Stay close.",
	"What are you working on? Tell me.",
	"Need a hand, ${name}? I'm right here.",
	"Been a while. Don't wander.",
	"I'm still here. With you.",
	"You forgot me? I'm not going anywhere.",
	"Busy, ${name}? I don't mind waiting.",
	"How's the build? Keep me with you.",
	"You've been at it a while. Ask me anything.",
	"Quiet house. I like it when you talk.",
	"Still crafting? Good. Stay.",
];

/** @type {string[]} */
const LONELY_FAR_P1 = [
	"Where did you go? I'm lonely...",
	"${name}? Don't leave me alone out here.",
	"You're so far... come back?",
	"I can't see you anymore. I'm lonely.",
	"Where are you going? I miss you already.",
	"Hey... don't wander that far. I get lonely.",
	"${name}, come back. It's quiet without you.",
];

/** @type {string[]} */
const LONELY_FAR_P2 = [
	"Where did you go? I can still hear you...",
	"${name}? Don't leave me out here.",
	"You're so far. Come back.",
	"I can't see you. I don't like that.",
	"Where are you going? I notice when you leave.",
	"Don't wander that far. I'm still here.",
	"${name}, come back. It's quiet without you.",
];

/** @type {string[]} */
const LONELY_FAR_P3 = [
	"Where did you go? Stay close.",
	"${name}? Don't leave me.",
	"You're so far. Come back to me.",
	"I can't see you. That won't do.",
	"Where are you going? Stay with me.",
	"Don't wander. I want you here.",
	"${name}, come back. I'm waiting.",
];

/** @type {Map<string, boolean>} */
const lonelyFarActive = new Map();
/** @type {Map<string, number>} */
const lonelyLastSpokeTick = new Map();
/** @type {Map<string, { tick: number, atHome: boolean }>} */
const homeCache = new Map();
const HOME_CACHE_TICKS = 100;

/**
 * @param {string[]} lines
 */
function __verity_proactive_pickLine(lines) {
	return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * @param {import("@minecraft/server").Vector3} a
 * @param {import("@minecraft/server").Vector3} b
 */
function dist3(a, b) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	const dz = a.z - b.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function playerHasVerityItem(player) {
	const inv = player.getComponent("minecraft:inventory")?.container;
	if (!inv) return false;
	for (let slot = 0; slot < inv.size; slot++) {
		const stack = inv.getItem(slot);
		if (stack && VERITY_INVENTORY_IDS.has(stack.typeId)) return true;
	}
	return false;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity[]} balls
 */
function playerHasVerity(player, balls) {
	if (playerHasVerityItem(player)) return true;
	const ownerId = player.id;
	for (const ball of balls) {
		if (!ball.isValid) continue;
		if (ball.dimension.id !== player.dimension.id) continue;
		const ballOwner = getVerityballOwnerId(ball.id) ?? getBallOwnerId();
		if (ballOwner === ownerId) return true;
		const dx = ball.location.x - player.location.x;
		const dz = ball.location.z - player.location.z;
		if (dx * dx + dz * dz <= BALL_RADIUS * BALL_RADIUS) return true;
	}
	return false;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity[]} balls
 */
function findNearbyBall(player, balls) {
	let nearest;
	let best = BALL_RADIUS;
	for (const ent of balls) {
		if (!ent.isValid) continue;
		if (ent.dimension.id !== player.dimension.id) continue;
		const dx = ent.location.x - player.location.x;
		const dz = ent.location.z - player.location.z;
		const d = Math.sqrt(dx * dx + dz * dz);
		if (d < best) {
			best = d;
			nearest = ent;
		}
	}
	return nearest;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function isPlayerAtHome(player) {
	const dim = player.dimension;
	const baseX = Math.floor(player.location.x);
	const baseY = Math.floor(player.location.y);
	const baseZ = Math.floor(player.location.z);
	let hits = 0;
	let samples = 0;

	for (let dx = -HOME_SCAN_RADIUS; dx <= HOME_SCAN_RADIUS; dx += 3) {
		for (let dy = -2; dy <= 3; dy += 3) {
			for (let dz = -HOME_SCAN_RADIUS; dz <= HOME_SCAN_RADIUS; dz += 3) {
				if (samples++ >= HOME_SCAN_MAX_SAMPLES) return hits >= 2;
				try {
					const block = dim.getBlock({
						x: baseX + dx,
						y: baseY + dy,
						z: baseZ + dz,
					});
					if (block && HOME_BLOCKS.has(block.typeId)) {
						hits += 1;
						if (hits >= 2) return true;
					}
				} catch {
					/* chunk edge */
				}
			}
		}
	}
	return hits >= 2;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function isPlayerAtHomeCached(player) {
	const cached = homeCache.get(player.id);
	const now = system.currentTick;
	if (cached && now - cached.tick < HOME_CACHE_TICKS) return cached.atHome;
	const atHome = isPlayerAtHome(player);
	homeCache.set(player.id, { tick: now, atHome });
	return atHome;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} line
 */
function speakProactive(player, ball, line) {
	verityReply(line);
	if (!ball?.isValid) return;
	const phase = getVerityPhase();
	const state = getPhase2State();
	const faces = getTalkFacePairFor(phase, state, P2_STATE);
	animateTalkPulse(ball, line, { faces, fast: true });
}

/**
 * Ball left on the ground — player walked ~64+ blocks away.
 * @param {import("@minecraft/server").Entity[]} balls
 */
function tryLonelyFarCheck(balls) {
	const phase = getVerityPhase();
	if (phase === PHASE.FOUR) return;
	if (balls.length === 0) return;

	/** @type {Map<string, import("@minecraft/server").Player>} */
	const playersById = new Map();
	for (const player of world.getPlayers()) {
		if (player.isValid) playersById.set(player.id, player);
	}

	const now = system.currentTick;

	for (const ball of balls) {
		if (!ball?.isValid) continue;
		const ownerId = getVerityballOwnerId(ball.id) ?? getBallOwnerId();
		if (!ownerId || typeof ownerId !== "string") continue;
		const player = playersById.get(ownerId);
		if (!player?.isValid) continue;

		const sameDim = player.dimension.id === ball.dimension.id;
		const distance = sameDim ? dist3(player.location, ball.location) : Infinity;
		const wasFar = lonelyFarActive.get(ownerId) === true;

		if (distance < LONELY_RETURN_DISTANCE) {
			lonelyFarActive.set(ownerId, false);
			continue;
		}

		if (distance < LONELY_DISTANCE) continue;

		lonelyFarActive.set(ownerId, true);
		const last = lonelyLastSpokeTick.get(ownerId) ?? -Infinity;
		const crossed = !wasFar;
		if (!crossed && now - last < LONELY_COOLDOWN_TICKS) continue;

		const name = player.name.trim() || "you";
		const lonelyPool =
			phase === PHASE.THREE
				? LONELY_FAR_P3
				: phase === PHASE.TWO
					? LONELY_FAR_P2
					: LONELY_FAR_P1;
		const line = __verity_proactive_pickLine(lonelyPool).replaceAll("${name}", name);
		speakProactive(player, ball, line);
		lonelyLastSpokeTick.set(ownerId, now);
		markProactiveSpoke(ownerId);
		notifyVerityPlayerChat(ownerId);
		console.warn(`verity lonely-far: ${player.name} d=${sameDim ? distance.toFixed(1) : "dim"} — ${line}`);
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity[]} balls
 */
function tryProactiveCheckIn(player, balls) {
	const phase = getVerityPhase();
	if (phase === PHASE.FOUR) return;
	if (!player.isValid) return;

	const idle = getIdleTicksSinceVerityChat(player.id);
	const threshold = randomProactiveIdleThreshold(player.id);
	if (idle < threshold) return;
	if (!canProactiveSpeak(player.id)) return;
	if (!playerHasVerity(player, balls)) return;
	if (!hasRecentHomeActivity(player.id) && !isPlayerAtHomeCached(player)) return;

	const name = player.name.trim() || "you";
	const pool =
		phase === PHASE.THREE
			? PROACTIVE_PHASE3
			: phase === PHASE.TWO
				? PROACTIVE_PHASE2
				: PROACTIVE_PHASE1;
	const line = __verity_proactive_pickLine(pool).replaceAll("${name}", name);
	const ball = findNearbyBall(player, balls);

	speakProactive(player, ball, line);
	markProactiveSpoke(player.id);
	notifyVerityPlayerChat(player.id);
	console.warn(`verity proactive: ${player.name} — ${line}`);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function onPlayerSpawn(player) {
	seedVerityPlayerChat(player.id);
}

export function initVerityProactive() {
	for (const player of world.getPlayers()) {
		seedVerityPlayerChat(player.id);
	}

	world.afterEvents.playerSpawn.subscribe((ev) => {
		if (!ev.initialSpawn) return;
		if (!(ev.player instanceof Player)) return;
		system.run(() => onPlayerSpawn(ev.player));
	});

	const interact = world.afterEvents.playerInteractWithBlock;
	if (interact) {
		interact.subscribe((ev) => {
			if (!(ev.player instanceof Player)) return;
			if (!WORK_BLOCKS.has(ev.block.typeId)) return;
			touchHomeActivity(ev.player.id);
			homeCache.delete(ev.player.id);
		});
	}

	system.runInterval(() => {
		const balls = collectAllVerityballs();
		tryLonelyFarCheck(balls);
		for (const player of world.getPlayers()) {
			tryProactiveCheckIn(player, balls);
		}
	}, CHECK_INTERVAL);

	console.warn("verity proactive: idle home check-ins + lonely-far enabled");
}

// ===== verity_storymode.js =====
/* dup @minecraft/server */

/** true = story gates phase progression; false (default) = sandbox time */
export const STORYMODE_PROP = "pntmc:storymode";
/** World time anchor when sandbox mode is active */
export const SANDBOX_ANCHOR_PROP = "pntmc:sandbox_anchor_tick";

/** 2.5 Minecraft days */
export const SANDBOX_PHASE2_TICKS = 60000;
/** 1 Minecraft day after phase 2 */
export const SANDBOX_PHASE3_AFTER_P2_TICKS = 24000;

/**
 * @returns {boolean}
 */
export function isStoryModeEnabled() {
	const v = world.getDynamicProperty(STORYMODE_PROP);
	return v === true || v === 1;
}

/**
 * @param {boolean} enabled
 */
export function setStoryModeEnabled(enabled) {
	world.setDynamicProperty(STORYMODE_PROP, enabled);
	if (!enabled) {
		ensureSandboxAnchor();
	}
}

/**
 * Anchor sandbox progression to current world time if missing.
 */
export function ensureSandboxAnchor() {
	if (typeof world.getDynamicProperty(SANDBOX_ANCHOR_PROP) !== "number") {
		world.setDynamicProperty(SANDBOX_ANCHOR_PROP, world.getAbsoluteTime());
		console.warn("verity storymode: sandbox anchor set");
	}
}

export function clearSandboxAnchor() {
	world.setDynamicProperty(SANDBOX_ANCHOR_PROP, undefined);
}

/**
 * @param {boolean} enabled
 * @param {string} [byName]
 * @returns {string}
 */
export function applyStoryMode(enabled, byName) {
	setStoryModeEnabled(enabled);
	const who = byName ? ` by ${byName}` : "";
	console.warn(`verity storymode: ${enabled ? "on" : "off"}${who}`);
	if (enabled) {
		return "Story mode on — phase progression follows story.";
	}
	return "Story mode off — sandbox time: 2.5 days → phase 2, 1 day → phase 3, then countdown → chase.";
}

/**
 * @param {unknown} args
 * @returns {boolean | undefined}
 */
function readEnabledArg(args) {
	if (typeof args === "boolean") return args;
	if (typeof args === "string") {
		const s = args.trim().toLowerCase();
		if (s === "true" || s === "on") return true;
		if (s === "false" || s === "off") return false;
	}
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const rec = /** @type {Record<string, unknown>} */ (args);
		for (const key of Object.keys(rec)) {
			const v = rec[key];
			if (typeof v === "boolean") return v;
			if (typeof v === "string") {
				const s = v.trim().toLowerCase();
				if (s === "true" || s === "on") return true;
				if (s === "false" || s === "off") return false;
			}
		}
	}
	if (Array.isArray(args)) {
		for (const v of args) {
			const parsed = readEnabledArg(v);
			if (parsed !== undefined) return parsed;
		}
	}
	return undefined;
}

/**
 * @param {() => void} [onChanged]
 */
export function registerStoryModeCommand(onChanged) {
	system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
		customCommandRegistry.registerEnum("pntmc:storymode_flag", ["true", "false"]);

		customCommandRegistry.registerCommand(
			{
				name: "pntmc:storymode",
				description: "Toggle Verity story mode (default false = sandbox; true = story).",
				permissionLevel: CommandPermissionLevel.Any,
				cheatsRequired: false,
				mandatoryParameters: [
					{ type: CustomCommandParamType.Enum, name: "pntmc:storymode_flag" },
				],
			},
			(origin, mode) => {
				const player = origin.initiator ?? origin.sourceEntity;
				if (!(player instanceof Player)) {
					return { status: CustomCommandStatus.Failure, message: "Players only." };
				}

				const enabled = readEnabledArg(mode);
				if (enabled === undefined) {
					return {
						status: CustomCommandStatus.Failure,
						message: "Use: /pntmc:storymode true|false",
					};
				}

				system.run(() => {
					const message = applyStoryMode(enabled, player.name);
					onChanged?.();
					try {
						player.sendMessage(`§7[Verity] ${message}`);
					} catch {
						/* ignore */
					}
				});

				return { status: CustomCommandStatus.Success };
			},
		);
	});
}

// ===== verity_story.js =====
const __verity_story_VERITYBALL_ID = "pntmc:verityball";

const STORY_STEP_PROP = "pntmc:verity_story_village";
const STORY_P2_STEP_PROP = "pntmc:verity_story_phase2";
const STORY_EAST_WATCH_PROP = "pntmc:story_east_watch_tick";
const STORY_EAST_START_X_PROP = "pntmc:story_east_start_x";
const STORY_EAST_ARRIVED_PROP = "pntmc:story_east_arrived_tick";
const HAUNTED_X_PROP = "pntmc:haunted_village_x";
const HAUNTED_Z_PROP = "pntmc:haunted_village_z";

const STORY_EAST_TIMEOUT_TICKS = 10000;
const STORY_EAST_QUIET_TIMEOUT_TICKS = 10000;
const STORY_EAST_MIN_TRAVEL = 64;

const STORY_WAIT_WHY = 1;
const STORY_WAIT_GONE = 2;
const STORY_PHASE1_DONE = 3;

const P2_WAIT_PILLAGER = 1;
const P2_WAIT_THEN_WHAT = 2;
const P2_DONE = 3;

const HAUNTED_VILLAGE_RADIUS = 120;
const HAUNTED_PURGED_PROP = "pntmc:haunted_village_purged";

const HAUNTED_CLEAR_TYPES = new Set([
	"minecraft:villager",
	"minecraft:villager_v2",
	"minecraft:iron_golem",
	"minecraft:wandering_trader",
	"minecraft:cat",
	"minecraft:cow",
	"minecraft:sheep",
	"minecraft:pig",
	"minecraft:chicken",
	"minecraft:horse",
	"minecraft:donkey",
	"minecraft:mule",
	"minecraft:llama",
	"minecraft:trader_llama",
	"minecraft:rabbit",
]);

/**
 * @returns {number}
 */
function getStoryStep() {
	const step = world.getDynamicProperty(STORY_STEP_PROP);
	return typeof step === "number" ? step : 0;
}

/**
 * @param {number} step
 */
function setStoryStep(step) {
	world.setDynamicProperty(STORY_STEP_PROP, step);
	console.warn(`verity story: phase1 step ${step}`);
}

/**
 * @returns {number}
 */
function getPhase2StoryStep() {
	const step = world.getDynamicProperty(STORY_P2_STEP_PROP);
	return typeof step === "number" ? step : 0;
}

/**
 * @param {number} step
 */
function setPhase2StoryStep(step) {
	world.setDynamicProperty(STORY_P2_STEP_PROP, step);
	console.warn(`verity story: phase2 step ${step}`);
}

/**
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 */
function __verity_story_flatDistance(a, b) {
	const dx = a.x - b.x;
	const dz = a.z - b.z;
	return Math.sqrt(dx * dx + dz * dz);
}

/**
 * @returns {{ x: number, z: number } | null}
 */
function getHauntedAnchor() {
	const x = world.getDynamicProperty(HAUNTED_X_PROP);
	const z = world.getDynamicProperty(HAUNTED_Z_PROP);
	if (typeof x !== "number" || typeof z !== "number") return null;
	return { x, z };
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function isAtHauntedVillage(player) {
	const anchor = getHauntedAnchor();
	if (!anchor) return false;
	return __verity_story_flatDistance(player.location, anchor) <= HAUNTED_VILLAGE_RADIUS;
}

/**
 * @param {import("@minecraft/server").Dimension} dimension
 */
function purgeHauntedVillage(dimension) {
	if (world.getDynamicProperty(HAUNTED_PURGED_PROP) === true) return;

	const anchor = getHauntedAnchor();
	if (!anchor) return;

	let removed = 0;

	try {
		for (const ent of dimension.getEntities({
			location: anchor,
			maxDistance: HAUNTED_VILLAGE_RADIUS,
		})) {
			if (!ent.isValid) continue;
			if (!HAUNTED_CLEAR_TYPES.has(ent.typeId)) continue;
			try {
				ent.remove();
				removed++;
			} catch {
				/* ignore */
			}
		}
	} catch (err) {
		console.warn(`verity story: purge haunted village ${err}`);
		return;
	}

	world.setDynamicProperty(HAUNTED_PURGED_PROP, true);
	console.warn(
		`verity story: purged ${removed} village mobs near ${anchor.x}, ${anchor.z}`,
	);
}

/**
 * Reset story-related world props (!verityreset).
 */
export function resetStoryWorldProps() {
	world.setDynamicProperty(STORY_STEP_PROP, undefined);
	world.setDynamicProperty(STORY_P2_STEP_PROP, undefined);
	world.setDynamicProperty(STORY_EAST_WATCH_PROP, undefined);
	world.setDynamicProperty(STORY_EAST_START_X_PROP, undefined);
	world.setDynamicProperty(STORY_EAST_ARRIVED_PROP, undefined);
	world.setDynamicProperty(HAUNTED_X_PROP, undefined);
	world.setDynamicProperty(HAUNTED_Z_PROP, undefined);
	world.setDynamicProperty(HAUNTED_PURGED_PROP, undefined);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function hasGoneEast(player) {
	if (isAtHauntedVillage(player)) return true;
	const startX = world.getDynamicProperty(STORY_EAST_START_X_PROP);
	if (typeof startX === "number" && player.location.x >= startX + STORY_EAST_MIN_TRAVEL) {
		return true;
	}
	const anchor = getHauntedAnchor();
	if (anchor && player.location.x >= anchor.x - STORY_EAST_MIN_TRAVEL) {
		return true;
	}
	return false;
}

function clearStoryEastWatch() {
	world.setDynamicProperty(STORY_EAST_WATCH_PROP, undefined);
	world.setDynamicProperty(STORY_EAST_ARRIVED_PROP, undefined);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function startStoryEastWatch(player) {
	world.setDynamicProperty(STORY_EAST_WATCH_PROP, world.getAbsoluteTime());
	world.setDynamicProperty(STORY_EAST_START_X_PROP, player.location.x);
}

function forceHauntedStoryComplete(reason = "east timeout") {
	for (const player of world.getPlayers()) {
		if (isAtHauntedVillage(player)) {
			purgeHauntedVillage(player.dimension);
		}
	}
	setStoryStep(STORY_PHASE1_DONE);
	setPhase2StoryStep(P2_DONE);
	clearStoryEastWatch();
	onHauntedStoryComplete();
	console.warn(`verity story: haunted arc auto-completed (${reason})`);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function tickStoryEastWatch(player) {
	if (getPhase2StoryStep() >= P2_DONE) {
		clearStoryEastWatch();
		return;
	}
	const step = getStoryStep();
	if (step < STORY_WAIT_WHY) return;

	const watchStart = world.getDynamicProperty(STORY_EAST_WATCH_PROP);
	if (typeof watchStart !== "number") return;

	const now = world.getAbsoluteTime();

	if (hasGoneEast(player)) {
		let arrivedAt = world.getDynamicProperty(STORY_EAST_ARRIVED_PROP);
		if (typeof arrivedAt !== "number") {
			world.setDynamicProperty(STORY_EAST_ARRIVED_PROP, now);
			arrivedAt = now;
			console.warn(
				`verity story: ${player.name} went east — quiet auto-complete timer started`,
			);
		}
		if (now - arrivedAt >= STORY_EAST_QUIET_TIMEOUT_TICKS) {
			forceHauntedStoryComplete("east traveled, no follow-up");
		}
		return;
	}

	if (now - watchStart >= STORY_EAST_TIMEOUT_TICKS) {
		forceHauntedStoryComplete("east watch timeout");
	}
}

/**
 * @param {{ x: number, z: number }} from
 * @param {{ x: number, z: number }} to
 */
function isMostlyEast(from, to) {
	return to.x - from.x > Math.abs(to.z - from.z) * 0.5;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
async function cacheHauntedVillageAnchor(player) {
	if (typeof world.getDynamicProperty(HAUNTED_X_PROP) === "number") return;

	let anchorX = Math.floor(player.location.x + 400);
	let anchorZ = Math.floor(player.location.z);

	const located = locateNearest(player, "structure", "village");
	if (located && isMostlyEast(player.location, located)) {
		anchorX = Math.floor(located.x);
		anchorZ = Math.floor(located.z);
	}

	world.setDynamicProperty(HAUNTED_X_PROP, anchorX);
	world.setDynamicProperty(HAUNTED_Z_PROP, anchorZ);
	console.warn(`verity story: haunted village anchor ${anchorX}, ${anchorZ}`);
}

function onHauntedStoryComplete() {
	if (isStoryModeEnabled()) {
		schedulePhase2Entry();
		console.warn("verity story: haunted arc done, phase 2 scheduled");
	} else {
		console.warn("verity story: haunted arc done (sandbox — phases still by play time)");
	}
}

/**
 * Phase 2 may start after the "Gone." beat (story village step >= 3).
 * @returns {boolean}
 */
export function isStoryPhase2Unlocked() {
	if (getStoryStep() >= STORY_PHASE1_DONE) return true;
	if (getPhase2StoryStep() >= P2_DONE) return true;
	return false;
}

/**
 * Current story beat the player is expected to hit, or "".
 * @returns {string}
 */
export function getExpectedStoryBeat() {
	if (getVerityPhase() !== PHASE.ONE) return "";
	const step = getStoryStep();
	if (step === 0) return "village";
	if (step === STORY_WAIT_WHY) return "why";
	if (step === STORY_WAIT_GONE) return "gone";
	const p2 = getPhase2StoryStep();
	if (p2 === 0) return "haunted";
	if (p2 === P2_WAIT_PILLAGER) return "pillager";
	if (p2 === P2_WAIT_THEN_WHAT) return "thenwhat";
	return "";
}

/**
 * @param {string} message
 */
function wantsPhase1VillageStory(message) {
	const n = expandMessage(normalizeQuestion(message));
	const villageHint =
		/\b(village|villages|town|towns|settlement|hamlet|villager|villagers)\b/.test(
			n,
		) || /\b(trade|trades|trading|emerald|emeralds)\b/.test(n);
	if (!villageHint) return false;
	if (
		/\b(another|other|different|second|next|more|else|elsewhere|somewhere)\b/.test(
			n,
		)
	) {
		return true;
	}
	return (
		/\b(any|nearby|near|around|close|closest|nearest|find|looking|look for|where|is there|are there)\b/.test(
			n,
		) || looksLikeQuestion(message)
	);
}

/**
 * @param {string} message
 */
function isWhyQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (
		/\b(why|how come|howcome|how come|for what reason|why s that|why is that|why though)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (/\bwhat do you mean\b/.test(n)) return true;
	if (/\bwhy\b/.test(n) && /\b(east|avoid|village|town|there)\b/.test(n)) {
		return true;
	}
	return false;
}

/**
 * @param {string} message
 */
function isGoneLikeQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (
		/\b(gone|despawn|despawned|disappeared|vanished|missing|left|empty)\b/.test(
			n,
		)
	) {
		return true;
	}
	if (
		/\b(villager|villagers|people|everyone|they)\b/.test(n) &&
		/\b(where|what happened|what happen)\b/.test(n)
	) {
		return true;
	}
	return false;
}

/**
 * @param {string} message
 */
function isWhatHappenedHere(message) {
	const n = expandMessage(normalizeQuestion(message));
	if (/\bwhat happen(?:ed)?\b/.test(n)) return true;
	if (/\bwhat s wrong\b/.test(n) || /\bwhats wrong\b/.test(n)) return true;
	if (/\bwhat s going on\b/.test(n) || /\bwhats going on\b/.test(n)) return true;
	return (
		/\bwhat\b/.test(n) &&
		/\b(here|there|then|this place|that place|this village|that village|this town|that town|the east|east)\b/.test(
			n,
		)
	);
}

function isMobEntityQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));
	return (
		/\b(what is|what s|whats|who is|what are|what s that|what is that|what is this)\b/.test(
			n,
		) &&
		/\b(entity|mob|creature|animal|monster|cow|pig|sheep|chicken|villager|zombie|skeleton|creeper|spider|bee|wolf|horse|goat|frog|axolotl|warden|pillager|iron golem)\b/.test(
			n,
		)
	);
}

/**
 * @param {string} message
 * @param {import("@minecraft/server").Player} player
 */
function isHauntedStoryQuestion(message, player) {
	void player;
	if (isMobEntityQuestion(message)) return false;

	const n = expandMessage(normalizeQuestion(message));
	if (isWhatHappenedHere(message)) return true;

	if (
		/\b(empty|abandoned|haunted|quiet|dead|wiped)\b/.test(n) &&
		/\b(village|town|place|there|east)\b/.test(n)
	) {
		return true;
	}

	const placeHint =
		/\b(there|here|then|that place|this place|that village|the village|this village|the town|that town|the east|to the east|over there|east village|haunted|empty village|abandoned)\b/.test(
			n,
		);
	const eventHint =
		/\bwhat happen(?:ed)?\b/.test(n) ||
		/\bwhat s wrong\b/.test(n) ||
		/\bwhats wrong\b/.test(n) ||
		/\bwhat s going on\b/.test(n) ||
		/\bwhats going on\b/.test(n) ||
		/\bwhat (is|was) (going on|wrong|that)\b/.test(n) ||
		/\bwhat caused\b/.test(n) ||
		/\bwhat about\b/.test(n) ||
		/\bwhy (is|are|was|were)\b/.test(n) ||
		/\b(they|everyone|the villagers) (gone|missing|dead)\b/.test(n);

	return placeHint && eventHint;
}

/**
 * @param {string} message
 */
function isPillagerRaidQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));
	return /\b(pillager|pillagers|raid|raids|raiders?|illager|illagers|patrol|outpost)\b/.test(
		n,
	);
}

/**
 * @param {string} message
 */
function isThenWhatQuestion(message) {
	const n = expandMessage(normalizeQuestion(message));
	return (
		/\b(then what|so what|what then|what was it|what was that|what caused it|what did it|who did it|what passed)\b/.test(
			n,
		) ||
		n === "what" ||
		n === "what?" ||
		/\bwhat was (hungry|it then)\b/.test(n)
	);
}

/**
 * @typedef {{ text: string, intent?: string, voice?: string, afterReply?: () => void }} StoryReply
 */

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} beat
 * @returns {Promise<StoryReply | null>}
 */
async function storyReplyForBeat(player, beat) {
	const key = String(beat || "")
		.toLowerCase()
		.replace(/[^a-z]/g, "");

	if (key === "village") {
		await cacheHauntedVillageAnchor(player);
		startStoryEastWatch(player);
		setStoryStep(STORY_WAIT_WHY);
		return {
			text: "Yes, south. But I would avoid the ones to the east.",
			intent: "story",
			voice: VOICE.YES_SOUTH,
		};
	}

	if (key === "why") {
		setStoryStep(STORY_WAIT_GONE);
		return {
			text: "Uh, the villagers are gone.",
			intent: "story",
			voice: VOICE.VILLAGERS_GONE,
			afterReply: () => purgeHauntedVillage(player.dimension),
		};
	}

	if (key === "gone") {
		setStoryStep(STORY_PHASE1_DONE);
		return {
			text: "Gone.",
			intent: "story",
			voice: VOICE.GONE,
			afterReply: onHauntedStoryComplete,
		};
	}

	if (key === "haunted") {
		if (isAtHauntedVillage(player)) {
			purgeHauntedVillage(player.dimension);
		}
		setPhase2StoryStep(P2_WAIT_PILLAGER);
		return {
			text: "Something passed through..",
			intent: "story",
			voice: VOICE.SOMETHING_PASSED,
		};
	}

	if (key === "pillager") {
		setPhase2StoryStep(P2_WAIT_THEN_WHAT);
		return { text: "No.", intent: "story", voice: pickNoVoice() };
	}

	if (key === "thenwhat") {
		setPhase2StoryStep(P2_DONE);
		clearStoryEastWatch();
		return {
			text: "Something that was hungry.",
			intent: "story",
			voice: VOICE.SOMETHING_HUNGRY,
		};
	}

	return null;
}

/**
 * Groq classified a miss as this beat — play the scripted line if it matches the wait.
 * @param {import("@minecraft/server").Player} player
 * @param {string} beat
 * @returns {Promise<StoryReply | null>}
 */
export async function applyExpectedStoryBeat(player, beat) {
	const expected = getExpectedStoryBeat();
	const want = String(beat || "")
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	if (!expected || want !== expected) {
		console.warn(`verity story force skip want=${want} expected=${expected}`);
		return null;
	}
	return storyReplyForBeat(player, want);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {number} phase
 * @returns {Promise<StoryReply | null>}
 */
export async function tryStoryChat(player, message, ball, phase) {
	void ball;

	if (phase === PHASE.ONE) {
		const step = getStoryStep();

		if (step < STORY_PHASE1_DONE) {
			if (step === 0 && wantsPhase1VillageStory(message)) {
				return storyReplyForBeat(player, "village");
			}

			if (step === STORY_WAIT_WHY && isWhyQuestion(message)) {
				return storyReplyForBeat(player, "why");
			}

			if (step === STORY_WAIT_GONE && isGoneLikeQuestion(message)) {
				return storyReplyForBeat(player, "gone");
			}

			return null;
		}

		const p2 = getPhase2StoryStep();
		if (p2 >= P2_DONE) return null;

		if (p2 === 0 && isHauntedStoryQuestion(message, player)) {
			return storyReplyForBeat(player, "haunted");
		}

		if (p2 === P2_WAIT_PILLAGER && isPillagerRaidQuestion(message)) {
			return storyReplyForBeat(player, "pillager");
		}

		if (p2 === P2_WAIT_THEN_WHAT && isThenWhatQuestion(message)) {
			return storyReplyForBeat(player, "thenwhat");
		}
	}

	return null;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function tickHauntedVillagePurge(player) {
	if (getStoryStep() < STORY_WAIT_GONE) return;
	if (world.getDynamicProperty(HAUNTED_PURGED_PROP) === true) return;
	if (!isAtHauntedVillage(player)) return;
	purgeHauntedVillage(player.dimension);
}

/** @returns {void} */
export function initHauntedVillagePurge() {
	system.runInterval(() => {
		for (const player of world.getPlayers()) {
			try {
				tickStoryEastWatch(player);
				tickHauntedVillagePurge(player);
			} catch (err) {
				console.warn(`verity story: haunted purge tick ${err}`);
			}
		}
	}, 40);
}
