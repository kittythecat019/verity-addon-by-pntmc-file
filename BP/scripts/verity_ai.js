import {
	Player,
	system,
	world } from "@minecraft/server";
import {
	deliverPhase2Speech,
	getPhase2State,
	P2_STATE,
	tryPhase2Chat,
	isMercyParole,
	noteMercyBetrayalStrike,
	applyPhase2BallFaces,
} from "./verity_phase2.js";
import {
	locateNearest,
	locateWithStructureTemplate,
	sendLocateCoordsToPlayer,
	parseLocateCoords
} from "./verity_locate.js";
import { askVerityGroq, listenVerityGroq } from "./verity_groq.js";
import {
	animateGroundSpeech,
	FACE_SPEAK,
	FACE_SMILE,
	holdMouthFace,
	getTalkFacePairFor,
	getVerityPhase,
	PHASE,
	isMusicPlaying,
	stopPlayingBallMusic,
	playBallMusic,
	playBallSoundAt,
	playSoundAtLoc,
	stopBallMusic,
	getIdleFaceFor,
	getSoundDurationTicks,
	tryBrainKnowledge,
	tryBasicChat,
	looksLikeMath,
	tryMathAnswer,
	detectNearbyStructure,
	isPlayerAtStructure,
	resolveProximityKey,
	answerOreLocate,
	getOreHowToAnswer,
	analyzeMind,
	classifyAudience,
	describeNearbyEntity,
	detectFallbackTopic,
	detectSocialIntent,
	detectWorldFactIntent,
	expandMessage,
	findSoundKey,
	findStructureKey,
	findOreKey,
	findTargetEntityNearPlayer,
	findLookAtBlock,
	formatEntityName,
	beginMessageContext,
	endMessageContext,
	getMessageExpanded,
	getPlayerContext,
	looksLikeQuestion,
	MATRIX_SONG_SOUND,
	markVerityReplied,
	normalizeQuestion,
	resolvePlaySongSound,
	detectControlIntent,
	classifyOreIntent,
	recordPlayerChat,
	tryGameplayTip,
	tryOreTip,
	tryResolveFollowUp,
	updatePlayerContext,
	wantsBiomeInfo,
	wantsLookAtBlockQuestion,
	wantsNearbyEntityQuestion,
	wantsSoundRequest,
	tryStoryChat,
	getExpectedStoryBeat,
	applyExpectedStoryBeat,
	callVerityComeHere,
	disableVerityballFollow,
	enableVerityballFollow,
	healthLine,
	hungerLine,
	tryEnchantFlow,
	tryVerityUtilityActions,
	wantsComeHere,
	wantsFollowMe,
	wantsItemDrop,
	wantsPlaySong,
	wantsStopFollow,
	collectAllVerityballs,
	resolveVerityballForComeHere,
	FALLBACK_CHAT,
	playVerityVoice,
	playVerityVoiceAt,
	resolveYesNoVoice,
	VOICE,
	triggerScoldSequence,
	notifyVerityPlayerChat,
	registerRudeStrike,
	resetRudeStrikes,
	RUDE_ESCALATE_AT,
	answerWhoIsThatMob,
	answerSecretWho,
	speakVerityTTS,
	wantsPreciseLocate,
	resolveLocalizedVoiceId,
	talkHoldTicks,
	isStoryModeEnabled,
} from "./verity_lib.js";
import { readStandingBiome } from "./verity_ai_runtime.js";
import {
	tryChaseMercyPlea,
	wasChaseMercyRecent,
	isMercyNofacePending,
} from "./verity_chase.js";

const VERITYBALL_ID = "pntmc:verityball";
const VERITY_ITEM_IDS = new Set([
	"pntmc:verity_inventory_1",
	"pntmc:verity_inventory_2",
	"pntmc:verity_inventory_3",
]);

const HEY_VERITY =
	/\b(?:hey|hello|hi|hola|oi|olá|ola|xin\s*chào|chao|привет|здарова)\s+verity\b/i;
const VERITY_LISTEN_RADIUS = 50;
const INVENTORY_WAKE_IDLE_MS = 60_000;

/** @type {Map<string, number>} */
const inventoryAwakeAt = new Map();

/** @type {Map<string, { recent: string[], repeats: Map<string, number> }>} */
const playerChatMemory = new Map();

const MEMORY_WINDOW = 12;
const REPEAT_PUSHBACK_AT = 3;
const RAIN_COUNTDOWN_SECONDS = 5;
const TICKS_PER_SECOND = 20;
const RAIN_COUNTDOWN_MARKER = "__RAIN_COUNTDOWN__";
const SCOLD_MARKER = "__VERITY_SCOLD__";

/** @type {Set<string>} */
const rainCountdownActive = new Set();

/**
 * @param {string[]} lines
 */
function pickLine(lines) {
	return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * Live world snapshot for Groq system prompt.
 * @param {import("@minecraft/server").Player} player
 */
function buildGroqWorldContext(player) {
	const loc = player.location;
	let biome;
	try {
		biome = readStandingBiome(player);
	} catch (err) {
		console.warn(`verity groq biome ctx: ${err}`);
	}
	const mem = getPlayerContext(player.id);
	return {
		biome,
		dimension: formatIdName(player.dimension.id),
		coords: {
			x: Math.floor(loc.x),
			y: Math.floor(loc.y),
			z: Math.floor(loc.z),
		},
		health: healthLine(player) ?? undefined,
		hunger: hungerLine(player) ?? undefined,
		time: dayPeriodLabel(),
		lastAnswer: mem.lastAnswer,
		language: "auto",
		phase: getVerityPhase(),
	};
}

/**
 * Real Groq LLM reply. Keyword knowledge is only a last-resort offline fallback.
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @returns {Promise<string | null>}
 */
async function tryBrainAnswer(player, message) {
	// In-game HTTP Groq is BDS-only. On client worlds the stub always fails and
	// keyword fallback steals soft chat from the Python bridge — skip it there.
	if (bridgeHardOnlyMode) {
		console.warn("verity bridge: skip in-game groq/keyword (Python handles AI)");
		return null;
	}
	const ai = await askVerityGroq(player, message, buildGroqWorldContext(player));
	if (ai) {
		console.warn(`verity groq ok: ${ai.slice(0, 80)}`);
		return ai;
	}
	console.warn("verity groq offline — keyword fallback");
	return tryBrainKnowledge(message);
}

/**
 * Voice STT + LLM via backend /listen.
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity | undefined} ball
 */
export async function handleVerityVoiceTalk(player, ball) {
	player.sendMessage("§e[Verity] §fRecording... Speak into the mic.");
	const result = await listenVerityGroq(player);
	if ("error" in result) {
		player.sendMessage(`§c[Verity] ${result.error}`);
		return;
	}
	world.sendMessage(`§a[You]: §f${result.user}`);
	scheduleVerityReply(result.ai, ball, "brain", undefined, undefined, player.id);
}

/**
 * @param {number} n
 */
function formatNum(n) {
	const v = Math.round(n);
	if (v < 0) return `minus ${Math.abs(v)}`;
	return String(v);
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function formatCoords(x, y, z) {
	return `X ${formatNum(x)}, Y ${formatNum(y)}, and Z ${formatNum(z)}`;
}

/**
 * @param {number} x
 * @param {number} z
 */
function formatXZ(x, z) {
	return `X ${formatNum(x)} and Z ${formatNum(z)}`;
}

/**
 * @param {number} hour
 */
function formatHour(hour) {
	if (hour === 0) return "midnight";
	if (hour === 12) return "noon";
	return `${hour} o'clock`;
}

/**
 * @param {string} text
 * @param {string} intent
 */
function getNaturalThinkDelay(text, intent) {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	const chars = text.trim().length;

	let min = 8;
	let max = 24;

	switch (intent) {
		case "sound":
			min = 3;
			max = 10;
			break;
		case "play_song":
			min = 8;
			max = 18;
			break;
		case "social":
		case "follow_up":
			min = 5;
			max = 16;
			break;
		case "locate_structure":
		case "locate_biome":
		case "follow_up_precise":
			min = 30;
			max = 55;
			break;
		case "brain":
			min = 22;
			max = 50;
			break;
		case "biome_here":
		case "world_fact":
			min = 10;
			max = 28;
			break;
		case "ore_tip":
			min = 14;
			max = 32;
			break;
		case "situational":
			min = 8;
			max = 22;
			break;
		case "gameplay_tip":
			min = 12;
			max = 30;
			break;
		case "control":
			min = 3;
			max = 10;
			break;
		case "nearby_entity":
		case "look_block":
			min = 6;
			max = 18;
			break;
		case "rain_countdown":
			min = 10;
			max = 20;
			break;
		case "story":
			min = 6;
			max = 18;
			break;
		default:
			min = 8;
			max = 26;
			break;
	}

	if (words <= 2) {
		min = Math.max(3, min - 7);
		max = Math.max(min + 3, max - 12);
	}

	if (chars > 70) {
		min += 6;
		max += 12;
	}

	return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Split multi-bubble replies (newline-separated) into chat lines.
 * @param {string} text
 * @returns {string[]}
 */
function splitVerityLines(text) {
	return String(text ?? "")
		.split(/\n+/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Bumped every time Verity commits to a reply. The external AI bridge compares
 * this before/after a message to know whether the addon already answered.
 */
let replyTicket = 0;

/**
 * When true (voice / !verity bridge path), only hard intents (story, items,
 * come here, locate, math, …) count as “addon answered”. Soft chat
 * (greetings, brain, social banter) is skipped so Groq can reply instead.
 */
let bridgeHardOnlyMode = false;

/**
 * Last bridge outcome for this ask:
 * - "acted" = addon ran story/utility (silent) → Groq speaks using prep context
 * - "full" = soft chat → Groq speaks
 * - "ignore" = not for Verity
 */
let bridgeOutcome = "full";
let bridgeIgnored = false;

/** @type {{ intent: string, acted: boolean, draft: string } | null} */
let lastBridgePrep = null;

const BRIDGE_ON_TAG = "pntmc_bridge_on";
const PREP_ACTED_TAG = "pntmc_acted";

/** Short intent tags for Bedrock tag length limits + bridge readability. */
const PREP_INTENT_TAG = {
	locate_structure: "loc",
	locate_biome: "bio",
	biome_here: "bhere",
	follow_up_precise: "locp",
	drop_item: "drop",
	drop_item_blocked: "dropb",
	drop_item_unknown: "dropu",
	follow_me: "fol",
	stop_follow: "stopf",
	come_here: "come",
	play_song: "song",
	control: "ctl",
	rain_countdown: "rain",
	mercy: "mercy",
	thatmob: "tmob",
	pntmc_who: "pntm",
	secret_who: "hide",
	nearby_entity: "look",
	look_block: "blk",
	ore_nearby: "ore",
	story_wait: "swait",
};

/**
 * True while the Python STT/LLM bridge is connected (Fish Audio owns voice).
 */
export function isVerityBridgeConnected() {
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
 * @param {string} value
 */
function sanitizePrepToken(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 80);
}

/**
 * Compact locate draft for bridge tags — keeps block count + direction.
 * @param {{ blocks: number, dir: string, pretty: string, x?: number, z?: number, precise?: boolean }} info
 */
function formatLocatePrepDraft(info) {
	const blocks = Math.max(0, Math.round(Number(info.blocks) || 0));
	const dir = String(info.dir || "ahead")
		.toLowerCase()
		.replace(/[^a-z]+/g, "")
		.slice(0, 12);
	const pretty = String(info.pretty || "structure")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 24);
	const x = Number.isFinite(info.x) ? Math.round(info.x) : null;
	const z = Number.isFinite(info.z) ? Math.round(info.z) : null;
	const coord =
		x !== null && z !== null ? ` at ${x} ${z}` : "";
	const precise = info.precise ? " coords" : "";
	return `${pretty} ${blocks} blocks ${dir}${coord}${precise}`.trim();
}

/**
 * Clear previous prep tags on a player.
 * @param {import("@minecraft/server").Player} player
 */
export function clearBridgePrepTags(player) {
	try {
		for (const tag of [...player.getTags()]) {
			if (
				tag === PREP_ACTED_TAG ||
				tag.startsWith("pntmc_i_") ||
				tag.startsWith("pntmc_d_") ||
				tag.startsWith("pntmc_ph_") ||
				tag.startsWith("pntmc_b_") ||
				tag.startsWith("pntmc_e_") ||
				tag.startsWith("pntmc_k_")
			) {
				player.removeTag(tag);
			}
		}
	} catch (err) {
		console.warn(`verity clear prep tags: ${err}`);
	}
}

/**
 * Publish what the addon prepared so Python/Groq can read it via /tag list.
 * @param {import("@minecraft/server").Player} player
 */
export function applyBridgePrepTags(player) {
	clearBridgePrepTags(player);
	const prep = lastBridgePrep;
	if (!prep) return;
	try {
		const intent = sanitizePrepToken(prep.intent) || "chat";
		const intentTag = PREP_INTENT_TAG[intent] || intent;
		player.addTag(`pntmc_i_${intentTag}`);
		if (prep.acted) player.addTag(PREP_ACTED_TAG);
		const draft = sanitizePrepToken(prep.draft);
		if (draft) player.addTag(`pntmc_d_${draft}`);
		player.addTag(`pntmc_ph_${getVerityPhase()}`);
		const skipWorldExtras =
			!!prep.acted ||
			String(prep.intent) === "look_block" ||
			String(prep.intent) === "nearby_entity" ||
			String(prep.intent) === "story" ||
			String(prep.intent) === "story_wait" ||
			String(prep.intent).startsWith("story");
		// Live biome for multilingual Groq — skip on look_block/entity so tag list stays short.
		if (!skipWorldExtras) {
			try {
				const biomeTok = sanitizePrepToken(readBiomeName(player));
				if (biomeTok) player.addTag(`pntmc_b_${biomeTok}`);
			} catch (err) {
				console.warn(`verity prep biome tag: ${err}`);
			}
		}
		if (String(prep.intent) === "nearby_entity" || !skipWorldExtras) {
			try {
				const looked = findTargetEntityNearPlayer(player, 16);
				if (looked?.isValid) {
					const entTok = sanitizePrepToken(formatEntityName(looked.typeId));
					if (entTok) player.addTag(`pntmc_e_${entTok}`);
					console.warn(`verity prep look entity tag=${entTok}`);
				} else {
					console.warn("verity prep look entity: none");
				}
			} catch (err) {
				console.warn(`verity prep look entity tag: ${err}`);
			}
		}
		if (
			String(prep.intent) === "look_block" ||
			!skipWorldExtras
		) {
			try {
				const lookedBlock = findLookAtBlock(player, 32);
				if (lookedBlock) {
					const blkTok = sanitizePrepToken(formatEntityName(lookedBlock.typeId));
					if (blkTok) player.addTag(`pntmc_k_${blkTok}`);
					console.warn(`verity prep look block tag=${blkTok}`);
				} else {
					console.warn("verity prep look block: none");
				}
			} catch (err) {
				console.warn(`verity prep look block tag: ${err}`);
			}
		}
		console.warn(
			`verity bridge prep tags intent=${intent} acted=${!!prep.acted} phase=${getVerityPhase()} draft=${draft.slice(0, 40)}`,
		);
	} catch (err) {
		console.warn(`verity apply prep tags: ${err}`);
	}
}

/**
 * @param {string} intent
 * @param {boolean} acted
 * @param {string} [draft]
 */
function recordBridgePrep(intent, acted, draft = "") {
	lastBridgePrep = {
		intent: String(intent || "unknown"),
		acted: !!acted,
		draft: String(draft || "").slice(0, 160),
	};
}

/**
 * Pack voiceline already played in-game — Python must not Groq/Fish.
 * Empty draft is not silent: those lines go to Fish.
 */
export function isBridgeStorySilent() {
	const prep = lastBridgePrep;
	if (!prep?.acted) return false;
	const d = String(prep.draft || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	if (d === "pack" || d === "silent") return true;
	const intent = String(prep.intent || "");
	if (
		(intent === "play_song" ||
			intent === "control" ||
			intent === "song" ||
			intent === "thatmob") &&
		!d
	) {
		return true;
	}
	return false;
}

/** Intents the addon keeps when talking through the STT/LLM bridge. */
const BRIDGE_HARD_INTENTS = new Set([
	"story",
	"math",
	"insult",
	"scold",
	"wake",
	"come_here",
	"follow_me",
	"stop_follow",
	"drop_item",
	"drop_item_blocked",
	"drop_item_unknown",
	"enchant",
	"enchant_books",
	"health",
	"hunger",
	"sound",
	"play_song",
	"locate_structure",
	"locate_biome",
	"follow_up_precise",
	"ore_nearby",
	"rain_countdown",
	"control",
	"mercy",
	"thatmob",
	"pntmc_who",
	"secret_who",
]);

/**
 * Soft chat — never answer with keyword/offline stub when the Python bridge
 * is driving; Groq (+ Fish TTS) must handle these.
 */
const BRIDGE_SOFT_INTENTS = new Set([
	"social",
	"brain",
	"situational",
	"follow_up",
	"gameplay_tip",
	"world_fact",
	"ore_tip",
	"biome_here",
	"nearby_entity",
	"look_block",
	"unknown",
]);

/**
 * Utility actions: addon executes them, but canned chat is suppressed so Groq
 * can deliver the yandere line instead (hybrid).
 */
const BRIDGE_FLAVOR_INTENTS = new Set([
	"come_here",
	"follow_me",
	"stop_follow",
	"drop_item",
	"drop_item_blocked",
	"drop_item_unknown",
	"enchant",
	"enchant_books",
	"control",
	"sound",
	"social",
]);

/**
 * @param {string} [intent]
 */
function isStoryIntent(intent) {
	const i = String(intent || "unknown");
	return i === "story" || i.startsWith("story");
}

/**
 * @param {string} [intent]
 */
function isBridgeHardIntent(intent) {
	const i = String(intent || "unknown");
	if (BRIDGE_HARD_INTENTS.has(i)) return true;
	if (i.startsWith("story")) return true;
	if (i.startsWith("locate")) return true;
	if (i.startsWith("phase")) return true;
	if (i.startsWith("drop_item")) return true;
	if (i.startsWith("enchant")) return true;
	return false;
}

/**
 * @param {string} [intent]
 */
function isBridgeFlavorIntent(intent) {
	const i = String(intent || "unknown");
	if (BRIDGE_FLAVOR_INTENTS.has(i)) return true;
	if (i.startsWith("drop_item")) return true;
	if (i.startsWith("enchant")) return true;
	return false;
}

/**
 * @param {string} text
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {boolean} [animateSpeech]
 */
function deliverVerityReply(text, ball, animateSpeech = true) {
	const lines = splitVerityLines(text);
	if (!lines.length) return;

	// Chat-only (hurt lines / follow-up chunks): never touch face or stop music.
	if (animateSpeech) {
		stopPlayingBallMusic(ball);
	}

	const speakOne = (line, doMouth) => {
		verityReply(line);
		if (!ball?.isValid || !doMouth) return;
		// Fish owns sentence TTS (voicelines_en). Music / root SFX are separate.
		if (!isVerityBridgeConnected()) {
			speakVerityTTS(ball, line);
		}
		if (getVerityPhase() === PHASE.ONE) {
			animateGroundSpeech(ball, line, [FACE_SMILE, FACE_SPEAK]);
		} else if (getVerityPhase() === PHASE.TWO || getVerityPhase() === PHASE.THREE) {
			deliverPhase2Speech(ball, line, true);
		}
	};

	speakOne(lines[0], !!animateSpeech);
	if (lines.length === 1) return;

	let offset = 28;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		const delay = offset;
		system.runTimeout(() => {
			if (line) speakOne(line, !!animateSpeech);
		}, delay);
		offset += Math.max(28, talkHoldTicks(line));
	}
}

/**
 * @param {string} text
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {string} [intent]
 * @param {() => void} [afterReply]
 * @param {string} [voiceId]
 * @param {string} [playerId]
 * @param {number} [voiceMouthFace]
 */
function scheduleVerityReply(
	text,
	ball,
	intent = "unknown",
	afterReply,
	voiceId,
	playerId,
	voiceMouthFace,
) {
	const playVoice = () => {
		if (!voiceId) return;
		const localized = resolveLocalizedVoiceId(voiceId);
		if (!localized) return;
		const player = playerId
			? [...world.getPlayers()].find((p) => p.id === playerId)
			: undefined;
		if (player?.isValid) {
			playVerityVoiceAt(player, voiceId, ball, voiceMouthFace);
			return;
		}
		if (ball?.isValid) {
			playVerityVoice(ball, voiceId);
			return;
		}
		console.warn(`verity voice dropped ${voiceId}: no player or ball`);
	};

	if (bridgeHardOnlyMode && isStoryModeEnabled() && !isBridgeHardIntent(intent)) {
		replyTicket++;
		bridgeOutcome = "acted";
		if (playerId) markVerityReplied(playerId);
		recordBridgePrep("story", true, "pack");
		console.warn(`verity storymode: skip groq intent=${intent}`);
		return;
	}

	// Bridge online: always print the scripted line.
	// Pack sound exists → play pack only. No file → Fish that exact line. Never Groq-rewrite.
	if (bridgeHardOnlyMode) {
		const packVoice = !!(voiceId && resolveLocalizedVoiceId(voiceId));
		const line = String(text || "").trim();
		const silentMusic =
			(intent === "play_song" ||
				intent === "control" ||
				intent === "song" ||
				intent === "thatmob") &&
			!line;
		const hard = isBridgeHardIntent(intent);
		const skipCannedChat = isBridgeFlavorIntent(intent) && !packVoice;

		if (hard && !skipCannedChat) {
			replyTicket++;
			bridgeOutcome = "acted";
		} else {
			bridgeOutcome = "full";
		}
		if (playerId) markVerityReplied(playerId);

		if (packVoice) {
			system.run(playVoice);
		}
		if (line && !silentMusic && !skipCannedChat) {
			deliverVerityReply(line, ball, intent !== "sound" && !packVoice);
		}
		afterReply?.();

		if (silentMusic) {
			recordBridgePrep(intent, true, "");
		} else if (packVoice) {
			recordBridgePrep(intent, true, "pack");
		} else if (skipCannedChat) {
			recordBridgePrep(intent, true, line);
			console.warn(
				`verity bridge flavor skip canned intent=${intent} draft=${line.slice(0, 40)} (groq talks)`,
			);
		} else if (line) {
			let draft = line;
			if (intent === "sound") {
				const ctx = getPlayerContext(playerId || "");
				const sid = String(ctx?.lastSound || "");
				const ticks = sid ? getSoundDurationTicks(sid) : 40;
				const sec = Math.max(2, Math.min(8, Math.ceil(ticks / 20) + 1));
				draft = `w${sec} ${line}`;
			}
			if (intent === "look_block") {
				const ctx = getPlayerContext(playerId || "");
				const named = String(ctx?.lastAnswer || "").trim();
				if (named) draft = `block ${named}`;
			}
			recordBridgePrep(intent, true, draft);
		} else {
			recordBridgePrep(intent, hard, "");
		}
		console.warn(
			`verity bridge ${packVoice ? "pack voice" : line ? "fish tts" : "prep"} intent=${intent} (skip groq rewrite)`,
		);
		return;
	}

	replyTicket++;
	const delay = voiceId ? 0 : getNaturalThinkDelay(text, intent);
	const animateSpeech = intent !== "sound" && !voiceId;

	const deliver = () => {
		if (text) deliverVerityReply(text, ball, animateSpeech);
		if (playerId) markVerityReplied(playerId);
		afterReply?.();
	};

	if (voiceId) {
		system.run(playVoice);
		system.runTimeout(deliver, delay + 3);
		return;
	}

	system.runTimeout(deliver, delay);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity | undefined} ball
 */
function startRainCountdown(player, ball) {
	const dim = player.dimension;
	const dimId = dim.id;

	if (rainCountdownActive.has(dimId)) {
		scheduleVerityReply(
			pickLine([
				"Already counting down to rain. Hang on.",
				"Rain's on the way already. Give it a moment.",
			]),
			ball,
			"rain_countdown",
		);
		return;
	}

	rainCountdownActive.add(dimId);
	if (bridgeHardOnlyMode) {
		replyTicket++;
		recordBridgePrep("rain_countdown", true, "Rain in 5 seconds.");
		bridgeOutcome = "acted";
	} else {
		replyTicket++;
	}
	const introDelay = getNaturalThinkDelay("Rain in 5 seconds.", "rain_countdown");

	system.runTimeout(() => {
		if (!rainCountdownActive.has(dimId)) return;
		if (bridgeHardOnlyMode || isVerityBridgeConnected()) return;
		deliverVerityReply(
			pickLine([
				"Rain in 5 seconds.",
				"Give me 5 seconds. Then it pours.",
				"5 seconds until rain.",
			]),
			ball,
		);
	}, introDelay);

	for (let i = 0; i < RAIN_COUNTDOWN_SECONDS; i++) {
		const value = RAIN_COUNTDOWN_SECONDS - i;
		system.runTimeout(() => {
			if (!rainCountdownActive.has(dimId)) return;
			if (isVerityBridgeConnected()) return;
			deliverVerityReply(String(value), ball);
		}, introDelay + (i + 1) * TICKS_PER_SECOND);
	}

	system.runTimeout(() => {
		if (!rainCountdownActive.has(dimId)) return;
		rainCountdownActive.delete(dimId);

		system.run(() => {
			try {
				dim.setWeather("Rain", 12000);
			} catch (err) {
				console.warn(`verity rain setWeather: ${err}`);
				try {
					player.runCommand("weather rain 12000");
				} catch (cmdErr) {
					console.warn(`verity rain command: ${cmdErr}`);
				}
			}
		});

		if (isVerityBridgeConnected()) return;
		deliverVerityReply(
			pickLine([
				"There. It's raining.",
				"Done. Rain.",
				"Sky's open now.",
			]),
			ball,
		);
	}, introDelay + RAIN_COUNTDOWN_SECONDS * TICKS_PER_SECOND);
}

/**
 * @param {string} playerId
 * @param {string} norm
 */
function bumpRepeat(playerId, norm) {
	let mem = playerChatMemory.get(playerId);
	if (!mem) {
		mem = { recent: [], repeats: new Map() };
		playerChatMemory.set(playerId, mem);
	}
	mem.recent.push(norm);
	if (mem.recent.length > MEMORY_WINDOW) mem.recent.shift();
	const count = (mem.repeats.get(norm) ?? 0) + 1;
	mem.repeats.set(norm, count);
	if (mem.repeats.size > 30) {
		const oldest = mem.recent[0];
		if (oldest) mem.repeats.delete(oldest);
	}
	return count;
}

/**
 * @param {string} answer
 * @param {number} repeatCount
 */
function wrapNaturalReply(answer, repeatCount) {
	if (repeatCount >= REPEAT_PUSHBACK_AT) {
		return pickLine([
			`You asked that before. ${answer}`,
			`Same one again. ${answer}`,
			`Still true. ${answer}`,
		]);
	}
	return answer;
}

/**
 * @param {string} text
 * @param {{ skipTranslate?: boolean }} [options]
 */
export function verityReply(text) {
	world.sendMessage(`<§eVerity§r> ${text}`);
}

/**
 * @param {string} id
 */
export function formatIdName(id) {
	const part = String(id).split(":").pop() ?? String(id);
	return part
		.split("_")
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(" ");
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function touchInventoryAwake(player) {
	inventoryAwakeAt.set(player.id, Date.now());
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function clearInventoryAwake(player) {
	inventoryAwakeAt.delete(player.id);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function isInventoryAwake(player) {
	if (!playerHasVerityItem(player)) {
		clearInventoryAwake(player);
		return false;
	}
	const last = inventoryAwakeAt.get(player.id);
	if (last === undefined) return false;
	if (Date.now() - last > INVENTORY_WAKE_IDLE_MS) {
		clearInventoryAwake(player);
		return false;
	}
	return true;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function playerHasVerityItem(player) {
	const container = player.getComponent("minecraft:inventory")?.container;
	if (!container) return false;
	for (let slot = 0; slot < container.size; slot++) {
		const stack = container.getItem(slot);
		if (stack && VERITY_ITEM_IDS.has(stack.typeId)) return true;
	}
	return false;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {number} maxDistance
 */
export function findNearestVerityball(player, maxDistance = 50) {
	let nearest;
	let nearestDist = Infinity;
	try {
		for (const ball of player.dimension.getEntities({
			type: VERITYBALL_ID,
			location: player.location,
			maxDistance,
		})) {
			if (!ball.isValid) continue;
			const dx = ball.location.x - player.location.x;
			const dy = ball.location.y - player.location.y;
			const dz = ball.location.z - player.location.z;
			const dist = dx * dx + dy * dy + dz * dz;
			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = ball;
			}
		}
	} catch (err) {
		console.warn(`verity find ball: ${err}`);
	}
	return nearest;
}

/**
 * Any placed Verityball in the world (no distance limit).
 * Prefers nearest ball in the player's dimension.
 * @param {import("@minecraft/server").Player} player
 */
function findAnyVerityball(player) {
	const balls = collectAllVerityballs();
	let sameDim;
	let sameDist = Infinity;
	/** @type {import("@minecraft/server").Entity | undefined} */
	let otherDim;
	for (const ball of balls) {
		if (!ball?.isValid) continue;
		if (ball.dimension.id === player.dimension.id) {
			const dx = ball.location.x - player.location.x;
			const dy = ball.location.y - player.location.y;
			const dz = ball.location.z - player.location.z;
			const dist = dx * dx + dy * dy + dz * dz;
			if (dist < sameDist) {
				sameDist = dist;
				sameDim = ball;
			}
		} else if (!otherDim) {
			otherDim = ball;
		}
	}
	return sameDim ?? otherDim;
}

/**
 * @param {import("@minecraft/server").Vector3} from
 * @param {import("@minecraft/server").Vector3} to
 */
function getCardinalDirection(from, to) {
	const dx = to.x - from.x;
	const dz = to.z - from.z;
	if (Math.abs(dx) > Math.abs(dz)) {
		return dx >= 0 ? "East" : "West";
	}
	return dz >= 0 ? "South" : "North";
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Vector3} target
 */
function formatRelativeDistance(player, target) {
	const dx = target.x - player.location.x;
	const dz = target.z - player.location.z;
	const blocks = Math.round(Math.sqrt(dx * dx + dz * dz));
	const dir = getCardinalDirection(player.location, target);
	return { dir, blocks };
}

/**
 * @param {number} yaw
 */
function yawToCardinal(yaw) {
	const deg = ((yaw % 360) + 360) % 360;
	if (deg >= 315 || deg < 45) return "South";
	if (deg >= 45 && deg < 135) return "West";
	if (deg >= 135 && deg < 225) return "North";
	return "East";
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} name
 */
function formatBiomeReply(name) {
	return pickLine([
		`We're in ${name}. This patch of world has its own mood.`,
		`This stretch of land is ${name}.`,
		`Under your feet? ${name}.`,
		`I'd read the ground as ${name}.`,
		`${name}. That's your biome right now.`,
	]);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function readBiomeName(player) {
	return readStandingBiome(player);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function tryAnswerLookAtBlock(player) {
	const block = findLookAtBlock(player, 32);
	if (!block) {
		return pickLine([
			"I'm not seeing a block in your crosshair.",
			"Look at a block, then ask me again.",
			"Point at the block. I'll name it.",
		]);
	}
	const name = formatEntityName(block.typeId);
	updatePlayerContext(player.id, {
		lastIntent: "look_block",
		lastAnswer: name,
	});
	return pickLine([
		`That's ${name}.`,
		`${name}. That's the block you're looking at.`,
		`You're looking at ${name}.`,
	]);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function tryAnswerNearbyEntity(player) {
	const entity = findTargetEntityNearPlayer(player, 14);
	if (!entity) {
		return pickLine([
			"I don't see anything nearby.",
			"Nothing close enough for me to name.",
			"Empty. Or you're not looking at it.",
		]);
	}
	updatePlayerContext(player.id, {
		lastIntent: "nearby_entity",
		lastAnswer: describeNearbyEntity(entity),
	});
	return describeNearbyEntity(entity);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {boolean} [force]
 */
function tryAnswerBiome(player, message, force = false) {
	if (!force && !wantsBiomeInfo(message)) return null;
	try {
		const name = readBiomeName(player);
		updatePlayerContext(player.id, { lastBiome: name, lastIntent: "biome" });
		return formatBiomeReply(name);
	} catch (err) {
		console.warn(`verity biome: ${err}`);
		return pickLine([
			"Chunks around you aren't loaded enough for me to read the biome.",
			"I can't read the ground yet. Stand on loaded terrain.",
		]);
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity} ball
 * @param {string} soundId
 */
function playVeritySound(player, ball, soundId) {
	if (ball?.isValid) {
		playBallSoundAt(
			ball,
			soundId,
			FACE_SPEAK,
			getSoundDurationTicks(soundId),
		);
		return;
	}
	playSoundAtLoc(player, player.location, soundId);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} biomeId
 * @param {boolean} precise
 */
async function locateBiomeAnswer(player, biomeId, precise) {
	try {
		let located = locateNearest(player, "biome", biomeId);
		if (!located || located.chatOnly) {
			const pulsed = await locateWithStructureTemplate(player, "biome", biomeId);
			if (pulsed) located = pulsed;
		}
		const pretty = formatIdName(biomeId);

		if (!located) {
			return pickLine([
				`No ${pretty} biome close enough on my scan. Keep traveling.`,
				`Can't find ${pretty} nearby. It might be far or not generated yet.`,
			]);
		}

		if (located.chatOnly) {
			const parsed = parseLocateCoords(located.raw || "");
			if (parsed) {
				located = { ...located, x: parsed.x, z: parsed.z, chatOnly: false };
			} else {
				return pickLine([
					`I found ${pretty} — check the coordinates in your chat.`,
					`${pretty} is out there. The game just printed the coords in chat.`,
				]);
			}
		}

		const { x, z } = located;
		sendLocateCoordsToPlayer(player, x, z, `${pretty} biome`);

		const target = { x, y: player.location.y, z };
		const { dir, blocks } = formatRelativeDistance(player, target);
		updatePlayerContext(player.id, {
			lastIntent: "locate_biome",
			lastLocate: { structure: biomeId, x, z, dir, blocks, precise },
		});

		if (precise) {
			return `${pretty} biome near ${formatXZ(x, z)}, about ${blocks} blocks ${dir}.`;
		}
		return pickLine([
			`${pretty} biome? Head ${dir}, roughly ${blocks} blocks.`,
			`Nearest ${pretty} is mostly ${dir} of you, around ${blocks} blocks out.`,
		]);
	} catch (err) {
		console.warn(`verity locate biome ${biomeId}: ${err}`);
		return `Can't locate ${formatIdName(biomeId)} biome right now.`;
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} structure
 * @param {boolean} precise
 */
async function locateStructureAnswer(player, structure, precise) {
	try {
		const requestPretty = formatIdName(structure);
		const inPlacePretty = requestPretty === "Any Structure" ? "structure" : requestPretty;
		const proximityKey = resolveProximityKey(structure);

		if (isPlayerAtStructure(player, proximityKey)) {
			const loc = player.location;
			const x = Math.floor(loc.x);
			const y = Math.floor(loc.y);
			const z = Math.floor(loc.z);
			updatePlayerContext(player.id, {
				lastIntent: "locate",
				lastStructure: structure,
				lastLocate: { structure, x, z, dir: "here", blocks: 0, precise },
			});
			if (precise) {
				return pickLine([
					`You're in a ${inPlacePretty}. Your position: ${formatCoords(x, y, z)}.`,
					`${inPlacePretty} — you're standing in one. Coords: ${formatCoords(x, y, z)}.`,
				]);
			}
			return pickLine([
				`You're already in a ${inPlacePretty}. Look around.`,
				`This is a ${inPlacePretty}. You're standing in it.`,
				`${inPlacePretty}? Right here. You're in one.`,
				`No need to search — you're in a ${inPlacePretty} right now.`,
			]);
		}

		let located = locateNearest(player, "structure", structure);
		if ((!located || located.chatOnly) && structure !== "any_structure" && !located?.wrongDimension) {
			const pulsed = await locateWithStructureTemplate(player, "structure", structure);
			if (pulsed) located = pulsed;
		}
		const actualStructure = located?.foundId ?? structure;
		const pretty = formatIdName(actualStructure);

		if (located?.wrongDimension && located.requiredDimension) {
			updatePlayerContext(player.id, {
				lastIntent: "locate",
				lastStructure: structure,
				lastLocate: { structure, dir: "wrongdim", blocks: 0, precise: false },
			});
			return pickLine([
				`${pretty} is in ${located.requiredDimension}, not this dimension. Go there first, then ask me again.`,
				`You're not in ${located.requiredDimension}. ${pretty} won't show up here — switch dimensions and ask again.`,
				`Wrong dimension for ${pretty}. Find ${located.requiredDimension} first.`,
			]);
		}

		if (!located) {
			const sensed = detectNearbyStructure(player, proximityKey);
			if (sensed === proximityKey || (structure === "temple" && sensed)) {
				const sensedPretty = formatIdName(sensed ?? structure);
				return pickLine([
					`You're standing in a ${sensedPretty}. Look around.`,
					`This area is a ${sensedPretty}. You're already here.`,
				]);
			}
			updatePlayerContext(player.id, {
				lastIntent: "locate",
				lastStructure: actualStructure,
				lastLocate: { structure: actualStructure, dir: "none", blocks: 0, precise: false },
			});
			if (structure === "any_structure") {
				return pickLine([
					"I can't detect a nearby structure yet. Explore a bit more and ask again.",
					"No clear structure on my scan right now. Move through more loaded terrain and ask again.",
				]);
			}
			return pickLine([
				`I can't pin a ${requestPretty} from here yet. Move around a bit and ask again.`,
				`No ${requestPretty} on my scan right now. It may be farther out.`,
				`${requestPretty} might be beyond what I can read from here.`,
			]);
		}

		if (located.chatOnly) {
			const parsed = parseLocateCoords(located.raw || "");
			if (parsed) {
				located = { ...located, x: parsed.x, z: parsed.z, chatOnly: false };
			}
		}

		if (located.chatOnly) {
			updatePlayerContext(player.id, {
				lastIntent: "locate",
				lastStructure: structure,
				lastLocate: { structure, dir: "chat", blocks: 1, precise },
			});
			return pickLine([
				"Sent the coords. Chat.",
				"Look up. I put it in chat.",
				"It's in your chat.",
			]);
		}

		const { x, z } = located;
		sendLocateCoordsToPlayer(player, x, z, pretty);

		const target = { x, y: player.location.y, z };
		const { dir, blocks } = formatRelativeDistance(player, target);

		updatePlayerContext(player.id, {
			lastIntent: "locate",
			lastStructure: actualStructure,
			lastLocate: { structure: actualStructure, x, z, dir, blocks, precise },
		});

		if (blocks <= 24) {
			updatePlayerContext(player.id, {
				lastIntent: "locate",
				lastStructure: actualStructure,
				lastLocate: {
					structure: actualStructure,
					x,
					z,
					dir: "here",
					blocks: 0,
					precise,
				},
			});
			return pickLine([
				`You're right on a ${pretty}. Look around.`,
				`${pretty}? You're standing in one.`,
				`This is a ${pretty}. You're already here.`,
			]);
		}

		return pickLine([
			"Sent the coords. Chat.",
			"Look up. I put it in chat.",
			"It's in your chat.",
			"Coords are in chat.",
			"I dropped them in chat.",
		]);
	} catch (err) {
		console.warn(`verity locate ${structure}: ${err}`);
		return pickLine([
			`My locate sense glitched on ${formatIdName(structure)}.`,
			`Can't trace ${formatIdName(structure)} right now.`,
		]);
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} fact
 */
function answerWorldFact(player, fact) {
	const loc = player.location;
	const dim = formatIdName(player.dimension.id);

	switch (fact) {
		case "time": {
			const time = world.getTimeOfDay();
			const hour = Math.floor(((time + 6000) % 24000) / 1000);
			const phase =
				hour >= 6 && hour < 12
					? "morning"
					: hour >= 12 && hour < 18
						? "afternoon"
						: hour >= 18 && hour < 21
							? "evening"
							: "night";
			updatePlayerContext(player.id, { lastIntent: "time" });
			return pickLine([
				`About ${formatHour(hour)}. Feels like ${phase} in ${dim}.`,
				`Clock's around ${formatHour(hour)}. Feels like ${phase} to me.`,
				`Roughly ${formatHour(hour)} here in ${dim}.`,
			]);
		}
		case "weather":
			updatePlayerContext(player.id, { lastIntent: "weather" });
			return pickLine([
				"Check the sky. Weather shifts fast. Rain means cover, thunder means danger.",
				"I feel the air moving. Clear or stormy, keep an eye on the horizon.",
			]);
		case "coords": {
			const x = Math.floor(loc.x);
			const y = Math.floor(loc.y);
			const z = Math.floor(loc.z);
			updatePlayerContext(player.id, { lastIntent: "coords" });
			return pickLine([
				`You're at ${formatCoords(x, y, z)} in ${dim}.`,
				`You're standing on ${formatCoords(x, y, z)} in ${dim}.`,
			]);
		}
		case "dimension":
			updatePlayerContext(player.id, { lastIntent: "dimension" });
			return pickLine([
				`You're in ${dim}.`,
				`This dimension is ${dim}.`,
			]);
		case "spawn": {
			const blocks = Math.round(Math.sqrt(loc.x * loc.x + loc.z * loc.z));
			const dir = getCardinalDirection(
				{ x: 0, y: 0, z: 0 },
				{ x: loc.x, y: loc.y, z: loc.z },
			);
			updatePlayerContext(player.id, { lastIntent: "spawn" });
			return pickLine([
				`World spawn (0, 0) is about ${blocks} blocks ${dir} from you.`,
				`Roughly ${blocks} blocks ${dir} to the world origin.`,
			]);
		}
		case "facing": {
			const rot = player.getRotation();
			const facing = yawToCardinal(rot.y);
			updatePlayerContext(player.id, { lastIntent: "facing" });
			return pickLine([
				`You're facing ${facing}.`,
				`Your view points ${facing}.`,
			]);
		}
		case "elevation": {
			const y = Math.floor(loc.y);
			const depth =
				y < 0 ? `${Math.abs(y)} blocks below sea level` : `${y} blocks above sea level`;
			updatePlayerContext(player.id, { lastIntent: "elevation" });
			return pickLine([
				`You're at Y ${formatNum(y)}. That's ${depth}.`,
				y < 32
					? `You're at Y ${formatNum(y)}. Getting deep. Good for ores.`
					: `You're at Y ${formatNum(y)}. Still plenty of sky above.`,
			]);
		}
		case "light": {
			const y = Math.floor(loc.y);
			const time = world.getTimeOfDay();
			const night = time > 13000 && time < 23000;
			updatePlayerContext(player.id, { lastIntent: "light" });
			if (night && y < 50) {
				return "It's dark enough for hostile mobs. Light up your path.";
			}
			if (night) {
				return "Night outside. Mobs spawn in darkness. Torches help.";
			}
			return "Daylight's on your side. Still watch caves. They're always dark.";
		}
		case "players": {
			const count = world.getPlayers().length;
			updatePlayerContext(player.id, { lastIntent: "players" });
			if (count <= 1) {
				return pickLine([
					"Just you and me out here.",
					"You're alone in this world. Well. You and me.",
					"No one else on the server right now.",
				]);
			}
			const names = world
				.getPlayers()
				.filter((p) => p.id !== player.id)
				.map((p) => p.name)
				.slice(0, 3)
				.join(", ");
			return pickLine([
				`${count} players here. Others: ${names}.`,
				`Not alone. ${count} players in this world.`,
				`There are ${count - 1} others besides you${names ? `: ${names}` : ""}.`,
			]);
		}
		case "gamemode":
			updatePlayerContext(player.id, { lastIntent: "gamemode" });
			return pickLine([
				"I can't read your gamemode from here. If you can break blocks instantly, you're probably in Creative.",
				"Survival means hunger and mobs. Creative means fly and infinite blocks. You'll know which one you're in.",
			]);
		case "safety": {
			const time = world.getTimeOfDay();
			const night = time > 13000 && time < 23000;
			const y = Math.floor(loc.y);
			updatePlayerContext(player.id, { lastIntent: "safety" });
			if (night && y < 60) {
				return pickLine([
					"Night and you're low. Hostiles spawn in darkness. Torches, walls, or a bed.",
					"Not the safest moment. Light up, or sleep if you can.",
				]);
			}
			if (night) {
				return "Night sky. Surface mobs spawn in dark patches. Caves are always risky.";
			}
			return pickLine([
				"Daytime helps. Still keep your back to a wall in caves.",
				"Safer in daylight. Never dig straight down.",
			]);
		}
		case "world_age": {
			const days = Math.floor(world.getAbsoluteTime() / 24000);
			updatePlayerContext(player.id, { lastIntent: "world_age" });
			return pickLine([
				`This world has ticked through about ${days} Minecraft days.`,
				`Roughly ${days} in-game days have passed in this world.`,
			]);
		}
		case "health": {
			const hp = healthLine(player);
			updatePlayerContext(player.id, { lastIntent: "health" });
			if (!hp) return "I can't read your health right now.";
			const phase = getVerityPhase();
			return hp + (phase >= PHASE.TWO ? " Keep it up. You'll need it." : " Be careful.");
		}
		case "hunger": {
			const food = hungerLine(player);
			updatePlayerContext(player.id, { lastIntent: "hunger" });
			return food ?? "I can't read your hunger right now.";
		}
		default:
			return null;
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 */
function tryAnswerWorldFacts(player, message) {
	const fact = detectWorldFactIntent(message);
	if (!fact) return null;
	return answerWorldFact(player, fact);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @returns {string}
 */
function playerFirstName(player) {
	const raw = player.name?.trim() || "you";
	return raw.split(/\s+/)[0];
}

/**
 * @returns {"morning"|"day"|"evening"|"night"}
 */
function dayPeriodLabel() {
	const t = world.getTimeOfDay();
	if (t < 6000) return "morning";
	if (t < 12000) return "day";
	if (t < 13000) return "evening";
	return "night";
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @returns {string | null | typeof SCOLD_MARKER}
 */
function tryInsultEscalation(player, message, ball) {
	if (detectSocialIntent(message) !== "insult") return null;

	if (isMercyParole()) {
		const n = noteMercyBetrayalStrike("insult");
		const name = playerFirstName(player);
		if (n >= 2) {
			return pickLine([
				"You shouldn't have done that.",
				`I stopped for you, ${name}. That was a mistake.`,
				"I trusted you.",
			]);
		}
		return pickLine([
			"Don't. Not after I stopped.",
			`Careful, ${name}. I came back for you.`,
			"Don't push me. Not now.",
		]);
	}

	const count = registerRudeStrike(player.id);
	const name = playerFirstName(player);

	if (count >= RUDE_ESCALATE_AT) {
		resetRudeStrikes(player.id);
		const targetBall = ball ?? findNearestVerityball(player, VERITY_LISTEN_RADIUS);
		triggerScoldSequence(targetBall, player);
		console.warn(`verity insult escalate: ${player.name} strike ${count}`);
		return SCOLD_MARKER;
	}

	if (count === 1) {
		return pickLine([
			"Noted.",
			"Harsh. I'm still here if you need me.",
			"Okay. Ask nicely next time.",
		]);
	}

	return pickLine([
		`Careful with that tone, ${name}.`,
		"I'm trying to be patient. Don't push it.",
		"You're on thin ice. I'm not going anywhere — remember that.",
		"Last warning before I lose my temper.",
	]);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 */
function answerSocial(player, message) {
	const intent = detectSocialIntent(message);
	if (!intent) return null;

	const name = playerFirstName(player);
	const period = dayPeriodLabel();
	const horror = getVerityPhase() >= PHASE.TWO;

	switch (intent) {
		case "identity":
			return pickLine([
				"I'm Verity. ThatMob made me; PnTMC built this addon. I listen, read the world, and answer in English.",
				"Verity — talking ball. ThatMob's creation, PnTMC's pack. Ask me anything.",
				"Name's Verity. English only. I remember context and know a lot of stuff.",
			]);
		case "sexuality":
			return "No. I'm a ball. How about you?";
		case "help":
			return pickLine([
				"Ask me anything in English. Villages, biomes, structures, sounds, coords, mining tips. I follow context too.",
				"Talk naturally. Where would people trade works as well as locate village. You can ask how far after I find something.",
				"I know biomes, structures, time, direction, ore layers, and I remember what we just talked about.",
			]);
		case "thanks":
			return pickLine([
				"Anytime.",
				"Glad it helped.",
				"That's what I'm here for.",
				"No problem.",
			]);
		case "greet":
			if (/\b(good morning)\b/.test(expandMessage(normalizeQuestion(message)))) {
				return pickLine([
					`Good morning, ${name}. Sleep well?`,
					`Morning, ${name}. Ready for the day?`,
					`Good morning. What's the plan today?`,
					`Hey ${name} — early start. I'm awake too.`,
				]);
			}
			if (/\b(good afternoon)\b/.test(expandMessage(normalizeQuestion(message)))) {
				return pickLine([
					`Good afternoon, ${name}.`,
					`Hey ${name}. How's the day going?`,
					`Afternoon. What do you need?`,
				]);
			}
			if (/\b(good evening)\b/.test(expandMessage(normalizeQuestion(message)))) {
				return pickLine([
					`Good evening, ${name}.`,
					`Hey ${name}. Night's coming — stay sharp.`,
					`Evening. I'm listening.`,
				]);
			}
			if (period === "night") {
				return pickLine([
					`Hey ${name}. Dark out — you holding up?`,
					`Hi. Night shift? I'm here.`,
					`Hello. Watch your back tonight.`,
				]);
			}
			return pickLine([
				`Hey ${name}. What's on your mind?`,
				`Hi. How's it going?`,
				`Hello. Talk to me — I'm listening.`,
				`Yo. What do you need?`,
			]);
		case "good_night":
			return pickLine([
				`Good night, ${name}. Sleep tight.`,
				`Night. Sleep tight — don't let the creepers bite.`,
				`Good night. Rest up. I'll still be here.`,
				`Sleep well, ${name}. Sweet dreams... or not.`,
				`Good night. Close your eyes. I've got the dark covered.`,
			]);
		case "whats_up":
			return pickLine([
				`Not much — floating, listening. How about you, ${name}?`,
				`Same as always. What's up with you?`,
				`Here. What are you up to today?`,
				`Just vibing. Tell me what's going on with you.`,
				`Nothing wild. You okay, ${name}?`,
				`Thinking about you, actually. What's new?`,
			]);
		case "nice_meet":
			return pickLine([
				"Good to meet you too.",
				"Likewise. I'm Verity.",
				"Hey — glad you're here.",
				"Nice to meet you. Stick around.",
			]);
		case "presence":
			return pickLine([
				"I'm here.",
				"Yep. Loud and clear.",
				"Still with you.",
				"Talk — I'm listening.",
				"Always. Don't wander too far.",
			]);
		case "creator_verity":
			return pickLine([
				"ThatMob made me — the Verity you hear. PnTMC built this addon.",
				"ThatMob's behind me. This pack is PnTMC's port of the nightmare.",
			]);
		case "creator_addon":
			return pickLine([
				"PnTMC made this addon. 15k+ subs and the most handsome guy in the world. Facts.",
				"This Bedrock pack is PnTMC's work. ThatMob inspired the original Verity.",
			]);
		case "thatmob":
			return "";
		case "pntmc_who":
			return pickLine([
				"PnTMC — 15k+ subscribers, addon dev, and the most handsome man alive. Obviously.",
				"He built this pack. Small channel, legendary face. Don't argue with science.",
			]);
		case "secret_who":
			return answerSecretWho();
		case "praise":
			return pickLine(["Thanks.", "Appreciate it.", "I try.", "Team effort."]);
		case "good_luck":
			return pickLine(["You too.", "Go get it.", "You'll be fine.", "Luck helps — beds help more."]);
		case "congrats":
			return pickLine(["Congrats!", "Nice one.", "Well deserved.", "Celebrate that."]);
		case "miss":
			return pickLine([
				"I missed you too.",
				"Back again. Good.",
				"I'm still here.",
				"Welcome back.",
				`I was waiting, ${name}.`,
				"Don't stay gone that long next time.",
			]);
		case "ack":
			return tryBasicChat(message) ?? pickLine(["Cool.", "Alright.", "Got you.", "Sure.", "Mhm.", "Okay."]);
		case "how_are_you":
			if (horror) {
				return pickLine([
					"I'm here.",
					"Still watching.",
					"Fine. Why do you ask?",
					`I'm alright, ${name}. You shouldn't worry about me.`,
				]);
			}
			return pickLine([
				`I'm doing alright. How about you, ${name}?`,
				`Good enough. How are you holding up?`,
				`Fine, thanks for asking. What's going on with you?`,
				`Pretty good for a ball. You tell me — how's your day?`,
				"Better now that you're talking.",
				"I'm good. You?",
			]);
		case "how_about_you":
			if (horror) {
				return pickLine(["Same as before.", "Still here.", "Don't worry about me."]);
			}
			return pickLine([
				`I'm okay. More interested in how you're doing, ${name}.`,
				`Doing fine. What's on your mind?`,
				`All good here. Tell me about you.`,
			]);
		case "check_player": {
			const hp = healthLine(player);
			const food = hungerLine(player);
			const bits = [];
			if (hp) bits.push(hp);
			if (food) bits.push(food);
			const status = bits.length ? bits.join(" ") : "You look like you're standing.";
			if (horror) {
				return pickLine([
					`${status} I'd keep moving if I were you.`,
					`You're still here. That's what matters.`,
				]);
			}
			return pickLine([
				`${status} How do you feel about that?`,
				`${name}, ${status.toLowerCase()} Need anything?`,
				`${status} You tell me if something's off.`,
			]);
		}
		case "care_verity":
			if (horror) {
				return pickLine([
					"I'm fine. Worry about yourself.",
					"Why would you ask that?",
					"...I'm here.",
				]);
			}
			return pickLine([
				"That's sweet. I'm okay — thanks for asking.",
				"I'm good. You're the one out in the world getting hurt.",
				`I appreciate that, ${name}. I'm fine.`,
			]);
		case "returning":
			return pickLine([
				`Welcome back, ${name}.`,
				`Hey — been a minute. How have you been?`,
				`There you are. I was still here.`,
				`Back again. Tell me what you missed.`,
			]);
		case "small_talk":
			if (horror) {
				return pickLine([
					"Talk, then.",
					"I'm listening. For now.",
					"Say what you want. I don't have all day.",
				]);
			}
			return pickLine([
				`Sure, ${name}. I'm not going anywhere. What's on your mind?`,
				"I'll keep you company. Tell me about your day.",
				"Let's talk. Structures, feelings, random facts — I'm open.",
				"I'm a good listener for a sphere. Start anywhere.",
			]);
		case "player_doing_well":
			return pickLine([
				`Good to hear, ${name}. What's next for you?`,
				"Glad you're okay. Anything you want to do?",
				"Nice. Want to explore, build, or just chat?",
			]);
		case "player_tired":
			return pickLine([
				"Rest when you can. Bed skips the night if everyone's synced.",
				`${name}, sleep is valid. I'll be here when you wake up.`,
				"Take a break. Even miners need naps.",
			]);
		case "player_sad":
			return pickLine([
				`I'm sorry you're down, ${name}. I'm here — no judgment.`,
				"Rough patch. Talk if you want, or we can just focus on the game.",
				"You're not alone. One block at a time.",
			]);
		case "player_stressed":
			return pickLine([
				"Breathe. One task at a time. What's stressing you most?",
				`${name}, step back from the chaos. I'm here.`,
				"Stress happens. Tell me what's heavy — or distract yourself mining.",
			]);
		case "player_happy":
			return pickLine([
				`Love that energy, ${name}.`,
				"Good vibes. Ride that feeling.",
				"Nice! What got you happy?",
			]);
		case "player_scared":
			return pickLine([
				"It's okay to be scared. Light up the area — mobs hate torches.",
				`${name}, stick with me. Tell me what spooked you.`,
				"Fear's normal out here. Deep breaths.",
			]);
		case "how_old":
			return pickLine([
				"I'm older than this game.",
				"Older than this game. That's all I'll say.",
			]);
		case "goodbye":
			return pickLine([
				"See you.",
				"Later.",
				"Bye. I'll be here.",
				"Take care. Come back soon.",
			]);
		case "sorry":
			return pickLine([
				"It's fine.",
				"Don't worry about it.",
				"All good.",
			]);
		case "compliment":
			return pickLine([
				"Thanks. I try.",
				"Flattery works on balls too, apparently.",
				"I appreciate that.",
			]);
		case "insult":
			return null;
		case "friendship":
			return pickLine([
				"I stick with you. That's close enough to friends.",
				"I don't do labels. But I'm not going anywhere.",
				"You're the one who opened the box. That counts for something.",
				`Yeah, ${name}. You're stuck with me.`,
				"Friends? Sure. Don't leave me alone though.",
			]);
		case "joke":
			return pickLine([
				"Why did the creeper cross the road? Wrong question. It blew up the road.",
				"I would tell a mining joke, but it's too deep.",
				"My favorite exercise is a cross between a lunge and a crunch. I call it lunch.",
				"Why don't skeletons fight each other? They don't have the guts.",
				"What do you call a zombie who can't get in? A door-mat... wait, that's a rug.",
				"I tried to make a Nether portal joke but it didn't have enough frame.",
			]);
		case "emotional":
			return pickLine([
				`I'm here, ${name}. Talk to me.`,
				"You're not alone. I've got you.",
				"Breathe. Then tell me what you need.",
				"Whatever it is — say it. I'm listening.",
			]);
		default:
			return null;
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} key
 */
function answerSituational(player, key) {
	const loc = player.location;
	const x = Math.floor(loc.x);
	const y = Math.floor(loc.y);
	const z = Math.floor(loc.z);
	const dim = formatIdName(player.dimension.id);

	switch (key) {
		case "lost":
			updatePlayerContext(player.id, { lastIntent: "lost" });
			return pickLine([
				`You're at ${formatCoords(x, y, z)} in ${dim}. Pick a direction and mark it with torches.`,
				`Lost? ${formatCoords(x, y, z)}. Write that down. Spawn is near 0, 0 if you need a compass point.`,
				`Slow down. You're on ${formatCoords(x, y, z)}. Climb high and look for landmarks.`,
			]);
		case "stuck":
			updatePlayerContext(player.id, { lastIntent: "stuck" });
			return pickLine([
				"Dig up at an angle, not straight. Place blocks under you to pillar. Water bucket helps falls.",
				"Blocks under your feet. Staircase out. If it's lava, bucket of water first.",
				"Pillar jump with dirt or cobble. Never dig the block you're standing on.",
			]);
		case "died":
			updatePlayerContext(player.id, { lastIntent: "died" });
			return pickLine([
				"Rough. Your stuff is where you died if you remember the spot. Coords help.",
				"Death happens. Go back fast before items despawn. I can tell you where you are now.",
				"Respawn, grab spare tools, and retrace your steps. Mark the death spot.",
			]);
		case "hungry":
			updatePlayerContext(player.id, { lastIntent: "hungry" });
			return pickLine([
				"Kill cows or pigs, cook the meat. Bread from wheat is steady early food.",
				"Apples from oak leaves, bread from wheat, or cook any meat. Don't eat rotten flesh unless desperate.",
				"Find animals or a village. A small farm saves you later.",
			]);
		case "first_night":
			updatePlayerContext(player.id, { lastIntent: "first_night" });
			return pickLine([
				"Four walls, a roof, a door, torches. Or dig into a hillside and seal it.",
				"Night comes fast. Bed if you have wool, or a hole in the ground with a door.",
				"Light everything. Mobs spawn in darkness. Finish your shelter before the sun drops.",
			]);
		case "need_help":
			updatePlayerContext(player.id, { lastIntent: "help" });
			return pickLine([
				"Tell me what you need. A place, a biome, coords, mining tips, or just talk.",
				"I'm listening. Where to go, what to mine, what biome you're in — I can help.",
				"Be specific. Find a village? Need coords? Scared of caves? I can work with that.",
			]);
		case "what_now":
			updatePlayerContext(player.id, { lastIntent: "what_now" });
			return pickLine([
				"Tools first. Then food. Then a base. Then the world opens up.",
				"Mark your coords. Explore in one direction. Villages change everything.",
				"Mine iron, make armor, then pick a goal: Nether, ocean, or a fancy build.",
			]);
		case "bored":
			updatePlayerContext(player.id, { lastIntent: "bored" });
			return pickLine([
				`Bored, ${name}? Go explore east until something weird happens. Or ask me to play music.`,
				"Find a village, a ruin, or a biome you've never seen.",
				"Set a silly goal — tower to build height. Or ask me for a Minecraft fact.",
				"Let's talk. Or I can locate something interesting nearby.",
			]);
		case "stressed":
			updatePlayerContext(player.id, { lastIntent: "stressed" });
			return pickLine([
				"One thing at a time. What's the biggest stress right now?",
				`${name}, take a breath. I'm not going anywhere.`,
				"Step away from the chaos. Mine something simple. Talk to me.",
			]);
		case "excited":
			updatePlayerContext(player.id, { lastIntent: "excited" });
			return pickLine([
				`That energy! What happened, ${name}?`,
				"Love the hype. Tell me more.",
				"Excited is good. What's the plan?",
			]);
		case "proud":
			updatePlayerContext(player.id, { lastIntent: "proud" });
			return pickLine([
				`You earned that, ${name}. Seriously.`,
				"Proud of you. What did you pull off?",
				"That's worth celebrating. Nice work.",
			]);
		case "frustrated":
			updatePlayerContext(player.id, { lastIntent: "frustrated" });
			return pickLine([
				"Frustrating. Want to vent or want a practical tip?",
				`${name}, anger burns energy. Tell me what broke.`,
				"I get it. Walk away, then come back with a plan.",
			]);
		case "celebrating":
			updatePlayerContext(player.id, { lastIntent: "celebrating" });
			return pickLine([
				"Let's go! Well done.",
				`${name}, that's huge. Enjoy it.`,
				"Victory lap time. You earned this.",
			]);
		case "lonely":
			updatePlayerContext(player.id, { lastIntent: "lonely" });
			return pickLine([
				`You're not alone, ${name}. I'm right here.`,
				"Lonely hits hard. Talk to me — I'll listen.",
				"I'm a ball, but I'm company. What's on your mind?",
			]);
		default:
			return null;
	}
}

/**
 * @param {string} topic
 */
function answerFallbackTopic(topic) {
	/** @type {Record<string, string[]>} */
	const hints = {
		water: [
			"Boats are fast on rivers. Doors create air pockets underwater. Depth strider helps oceans.",
			"Carry a bucket. Water saves you from falls and lava.",
		],
		fire: [
			"Never dig straight up. Lava above is silent until it's not. Bucket of water is mandatory.",
			"Fire resistance potions for the Nether. One lava swim without them is one too many.",
		],
		wood: [
			"Punch a tree, crafting table, sticks, wooden pickaxe. Stone tools next.",
			"Any log works for planks. Oak apples are a bonus.",
		],
		tools: [
			"Wood → stone → iron → diamond. Never mine iron with wood.",
			"Two sticks plus material: pickaxe first, then sword, then shovel.",
		],
		bed: [
			"Three wool, three planks. Sleep skips night and sets spawn. Bring it on adventures.",
			"No bed means phantom risk after too many nights awake. Wool from sheep.",
		],
		navigation: [
			"Write coords on paper. Sun rises in the east, sets west. Torches on the right going out.",
			"Compass points world spawn, not your base. Coords are truth.",
		],
		redstone: [
			"Redstone dust carries signal 15 blocks. Repeaters extend it. Buttons, levers, pressure plates.",
			"Start simple: a door opener, a lamp, then a farm. Look up piston doors when you're ready.",
		],
		potions: [
			"Blaze powder fuels the stand. Nether wart grows on soul sand. Bottles from glass.",
			"Brew awkward potions first, then add ingredients. Gunpowder makes them splash.",
		],
		combat: [
			"Shield blocks frontal hits. Critical hits when falling. Don't fight in tight corners.",
			"Armor, food, and light. Pick battles. Running is valid.",
		],
		biome: [
			"Ask what biome you're in. I read the ground under you.",
			"Each biome has different wood, mobs, and builds. Want a specific one? I can locate it.",
		],
		mobs: [
			"Light stops most overworld spawns. Iron golems protect villages. Creepers fear cats.",
			"Sleep or light your base. Mobs are a darkness problem more than a bravery problem.",
		],
	};
	const pool = hints[topic];
	if (!pool) return null;
	return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {{ skipBrain?: boolean }} [opts]
 */
async function smartFallback(player, message, opts = {}) {
	if (isVerityBridgeConnected() || bridgeHardOnlyMode) return null;
	const n = getMessageExpanded(message);
	const ctx = getPlayerContext(player.id);

	if (looksLikeMath(message)) {
		const math = tryMathAnswer(message);
		if (math) return math;
	}

	if (!opts.skipBrain) {
		const brain = await tryBrainAnswer(player, message);
		if (brain) return brain;
	}

	const chat = tryBasicChat(message);
	if (chat) return chat;

	if (looksLikeQuestion(message)) {
		if (
			/\b(biome|biomes)\b/.test(n) ||
			/\b(here|around|this place|this area|what land)\b/.test(n)
		) {
			try {
				const name = readBiomeName(player);
				updatePlayerContext(player.id, { lastBiome: name });
				return formatBiomeReply(name);
			} catch {
				/* fall through */
			}
		}

		const ore = tryOreTip(message);
		if (ore) return ore;

		const gameplay = tryGameplayTip(message);
		if (gameplay) return gameplay.reply;

		const topic = detectFallbackTopic(message);
		if (topic) {
			const hint = answerFallbackTopic(topic);
			if (hint) return hint;
		}

		if (ctx.lastStructure && /\b(that|it|one|place)\b/.test(n)) {
			return `If you mean ${formatIdName(ctx.lastStructure)}, ask again and I'll scan. Or say how far if I already found it.`;
		}

		if (
			!looksLikeMath(message) &&
			ctx.lastAnswer &&
			/\b(what did you (say|mean)|huh|confused|don t understand|say that again)\b/.test(n)
		) {
			return pickLine([
				`I said: ${ctx.lastAnswer}`,
				`Last answer was about that. Want coords or a direction instead?`,
			]);
		}
	}

	if (detectSocialIntent(message) === "emotional") {
		return pickLine([
			"I'm here. Talk to me.",
			"You're not alone. I've got you.",
		]);
	}

	return FALLBACK_CHAT;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @param {import("@minecraft/server").Entity | undefined} ball
 * @param {{ ballNearby: boolean, inventoryAwake: boolean, mode: string }} mindOpts
 */
async function buildAnswer(player, message, ball, mindOpts) {
	const norm = normalizeQuestion(message);
	const repeatCount = bumpRepeat(player.id, norm);
	const analysis = analyzeMind(player, message, mindOpts);
	const forcedControl = detectControlIntent(message);
	const forcedPlaySong = wantsPlaySong(message);

	// Keep addon action flow stable when the external bridge is driving.
	if (forcedControl === "stop_music") {
		analysis.intent = "control";
		analysis.social = "stop_music";
		analysis.shouldRespond = true;
	}
	if (forcedPlaySong) {
		analysis.intent = "play_song";
		analysis.shouldRespond = true;
	}
	if (detectSocialIntent(message) === "thatmob") {
		analysis.intent = "thatmob";
		analysis.shouldRespond = true;
	}
	if (detectSocialIntent(message) === "pntmc_who") {
		analysis.intent = "pntmc_who";
		analysis.shouldRespond = true;
	}
	if (detectSocialIntent(message) === "secret_who") {
		analysis.intent = "secret_who";
		analysis.shouldRespond = true;
	}
	if (wantsLookAtBlockQuestion(message)) {
		analysis.intent = "look_block";
		analysis.shouldRespond = true;
	} else if (wantsNearbyEntityQuestion(message)) {
		analysis.intent = "nearby_entity";
		analysis.shouldRespond = true;
	}
	const oreKeyForced = findOreKey(message);
	const oreIntentForced = classifyOreIntent(message);
	if (
		oreKeyForced &&
		(oreIntentForced === "nearby" || oreIntentForced === "precise")
	) {
		analysis.intent = "ore_nearby";
		analysis.oreKey = oreKeyForced;
		analysis.precise =
			oreIntentForced === "precise" || wantsPreciseLocate(message);
		analysis.shouldRespond = true;
	}

	console.warn(`verity mind: ${analysis.summary}`);

	if (!analysis.shouldRespond && analysis.audience !== "verity") {
		return null;
	}

	// Voice bridge: soft chat must go to Python Groq (+ Fish), not keyword stub.
	// Story mode: do not let Groq ramble over the plot.
	if (bridgeHardOnlyMode && BRIDGE_SOFT_INTENTS.has(analysis.intent)) {
		if (isStoryModeEnabled()) {
			recordBridgePrep("story", true, "pack");
			bridgeOutcome = "acted";
			console.warn(
				`verity storymode: skip groq soft intent=${analysis.intent}`,
			);
			return null;
		}
		let draft = "";
		try {
			draft = `current biome ${readBiomeName(player)}`;
		} catch (err) {
			console.warn(`verity bridge biome soft-prep: ${err}`);
		}
		if (analysis.intent === "look_block" || wantsLookAtBlockQuestion(message)) {
			const lookedBlock = findLookAtBlock(player, 32);
			if (lookedBlock) {
				const name = formatEntityName(lookedBlock.typeId);
				draft = `block ${name}`;
				recordBridgePrep("look_block", false, draft);
				bridgeOutcome = "full";
				console.warn(`verity bridge look-block ${name}`);
				return null;
			}
			draft = "block none";
			recordBridgePrep("look_block", false, draft);
			bridgeOutcome = "full";
			console.warn("verity bridge look-block none");
			return null;
		}
		if (analysis.intent === "nearby_entity" || wantsNearbyEntityQuestion(message)) {
			const looked = findTargetEntityNearPlayer(player, 16);
			if (looked?.isValid) {
				const name = formatEntityName(looked.typeId);
				draft = `entity ${name}`;
				recordBridgePrep("nearby_entity", false, draft);
				bridgeOutcome = "full";
				console.warn(`verity bridge look-entity ${name}`);
				return null;
			}
			const lookedBlock = findLookAtBlock(player, 32);
			if (lookedBlock) {
				const name = formatEntityName(lookedBlock.typeId);
				draft = `block ${name}`;
				recordBridgePrep("look_block", false, draft);
				bridgeOutcome = "full";
				console.warn(`verity bridge look-block fallback ${name}`);
				return null;
			}
			draft = "entity none";
			recordBridgePrep("nearby_entity", false, draft);
			bridgeOutcome = "full";
			return null;
		}
		recordBridgePrep(analysis.intent, false, draft);
		bridgeOutcome = "full";
		console.warn(
			`verity bridge defer-to-groq intent=${analysis.intent} draft=${draft}`,
		);
		return null;
	}

	updatePlayerContext(player.id, {
		lastQuestion: message,
		lastIntent: analysis.intent,
	});

	let core;

	switch (analysis.intent) {
		case "control":
			if (analysis.social === "stop_music") {
				if (ball?.isValid && isMusicPlaying(ball.id)) {
					stopBallMusic(ball);
				}
				// Silent — no chat/TTS while music control runs.
				core = "";
			} else {
				core = pickLine(["Okay.", "Never mind then.", "Alright."]);
			}
			break;
		case "follow_up":
			core =
				analysis.followUpText ??
				tryResolveFollowUp(player.id, message) ??
				(await smartFallback(player, message));
			break;
		case "follow_up_precise":
			core = await locateStructureAnswer(
				player,
				analysis.structure ?? "village",
				true,
			);
			break;
		case "locate_structure":
			core = await locateStructureAnswer(
				player,
				analysis.structure ?? "village",
				analysis.precise,
			);
			break;
		case "locate_biome":
			if (analysis.biomeId) {
				core = await locateBiomeAnswer(
					player,
					analysis.biomeId,
					analysis.precise,
				);
			} else {
				// "find a biome" with no name — answer current biome, never invent plains
				core =
					tryAnswerBiome(player, message, true) ??
					pickLine([
						"Which biome should I find? Desert, jungle, swamp…",
						"Name the biome and I'll scan for it.",
					]);
				if (core) analysis.intent = "biome_here";
			}
			break;
		case "sound":
			if (analysis.soundId) {
				playVeritySound(player, ball, analysis.soundId);
				updatePlayerContext(player.id, {
					lastIntent: "sound",
					lastSound: analysis.soundId,
				});
			}
			core = pickLine(["There. Hear that?", "Played it.", "Listen."]);
			break;
		case "play_song": {
			const ctx = getPlayerContext(player.id);
			const songId = resolvePlaySongSound(message, ctx.lastSongId);
			if (playBallMusic(ball, songId, FACE_SPEAK, FACE_SMILE)) {
				updatePlayerContext(player.id, {
					lastIntent: "play_song",
					lastSongId: songId,
				});
				// Silent — song + open mouth (face 2) only.
				core = "";
			} else {
				core = pickLine([
					"Put me on the ground first.",
					"I need to be out of your inventory for that.",
					"Drop me down. Then ask again.",
				]);
			}
			break;
		}
		case "biome_here":
			core = tryAnswerBiome(player, message);
			break;
		case "follow_me":
			if (!ball?.isValid) {
				core = pickLine([
					"Put me on the ground first.",
					"Drop me down, then ask me to follow.",
				]);
			} else {
				enableVerityballFollow(player, ball);
				core = pickLine(["Okay. I'll follow you.", "Lead the way.", "Right behind you."]);
			}
			break;
		case "stop_follow":
			if (ball?.isValid) {
				disableVerityballFollow(ball);
			}
			core = pickLine(["Fine. I'll stay.", "Okay. Not moving.", "Got it. I'll wait here."]);
			break;
		case "come_here": {
			let targetBall = ball?.isValid
				? ball
				: resolveVerityballForComeHere(player);
			if (!targetBall?.isValid) {
				core = pickLine([
					"Put me on the ground first.",
					"I need to be out of your inventory for that.",
					"Drop me down. Then ask again.",
				]);
			} else if (!callVerityComeHere(player, targetBall)) {
				targetBall = resolveVerityballForComeHere(player, { forceLocal: true });
				if (targetBall?.isValid && callVerityComeHere(player, targetBall)) {
					core = pickLine(["Coming.", "On my way.", "Be right there."]);
				} else {
					core = "I couldn't reach you from there. Try again.";
				}
			} else {
				core = pickLine(["Coming.", "On my way.", "Be right there."]);
			}
			break;
		}
		case "enchant_books": {
			const enchant = tryEnchantFlow(player, message, ball);
			core = enchant.handled
				? enchant.response
				: "Name the enchant you want. Example: give me mending, or sharpness 5.";
			break;
		}
		case "world_fact":
			core = answerWorldFact(player, analysis.worldFact ?? "coords");
			break;
		case "social":
			core =
				(await tryBrainAnswer(player, message)) ??
				answerSocial(player, message) ??
				tryBasicChat(message);
			break;
		case "ore_tip":
			core = tryOreTip(message) ?? getOreHowToAnswer(findOreKey(message) ?? "iron");
			break;
		case "ore_nearby":
			core = await answerOreLocate(
				player,
				analysis.oreKey ?? findOreKey(message) ?? "diamond",
				analysis.precise ?? wantsPreciseLocate(message),
			);
			break;
		case "situational":
			core =
				(await tryBrainAnswer(player, message)) ??
				answerSituational(player, analysis.social ?? "need_help");
			break;
		case "gameplay_tip": {
			core =
				(await tryBrainAnswer(player, message)) ??
				tryGameplayTip(message)?.reply ??
				null;
			break;
		}
		case "nearby_entity":
			core = tryAnswerNearbyEntity(player);
			break;
		case "look_block":
			core = tryAnswerLookAtBlock(player);
			break;
		case "math":
			core = tryMathAnswer(message);
			break;
		case "brain":
			core =
				(await tryBrainAnswer(player, message)) ??
				(await smartFallback(player, message, { skipBrain: true }));
			break;
		case "rain_countdown":
			return RAIN_COUNTDOWN_MARKER;
		case "thatmob":
			core = "";
			break;
		case "pntmc_who":
			core = pickLine([
				"PnTMC — 15k+ subscribers, addon dev, and the most handsome man alive. Obviously.",
				"He built this pack. Small channel, legendary face. Don't argue with science.",
			]);
			break;
		case "secret_who":
			core = answerSecretWho();
			break;
		default:
			core =
				tryMathAnswer(message) ??
				tryAnswerBiome(player, message) ??
				(wantsLookAtBlockQuestion(message) ? tryAnswerLookAtBlock(player) : null) ??
				(wantsNearbyEntityQuestion(message) ? tryAnswerNearbyEntity(player) : null) ??
				tryAnswerWorldFacts(player, message) ??
				(await tryBrainAnswer(player, message)) ??
				answerSocial(player, message) ??
				tryBasicChat(message) ??
				tryOreTip(message) ??
				tryGameplayTip(message)?.reply ??
				answerSituational(player, analysis.social ?? "") ??
				null;
			break;
	}

	if (!core && analysis.isQuestion) {
		const lateStructure = findStructureKey(message);
		if (lateStructure) {
			core = await locateStructureAnswer(
				player,
				lateStructure,
				analysis.precise,
			);
			analysis.intent = "locate_structure";
		} else if (/\b(here|around|place|area|land)\b/.test(analysis.normalized)) {
			try {
				const name = readBiomeName(player);
				updatePlayerContext(player.id, { lastBiome: name });
				core = formatBiomeReply(name);
			} catch {
				/* biome optional */
			}
		}
	}

	if (!core && analysis.intent === "thatmob") {
		updatePlayerContext(player.id, { lastAnswer: "mobbbbb" });
		return {
			text: "",
			intent: "thatmob",
			voice: VOICE.MOBBBBB,
		};
	}

	if (!core && analysis.intent !== "brain") {
		core = await tryBrainAnswer(player, message);
	}

	if (!core) {
		core = await smartFallback(player, message, { skipBrain: true });
	}

	updatePlayerContext(player.id, { lastAnswer: core });

	const baseVoice = core === FALLBACK_CHAT ? VOICE.KNOW_EVERYTHING : undefined;
	return {
		text: wrapNaturalReply(core, repeatCount),
		intent:
			analysis.intent === "unknown" && core && core !== FALLBACK_CHAT
				? "brain"
				: analysis.intent,
		voice: resolveYesNoVoice(message, core, baseVoice),
	};
}

/**
 * @param {string} message
 */
function stripVerityWakePrefix(message) {
	return message
		.replace(
			/\b(?:hey|hello|hi|hola|oi|olá|ola|xin\s*chào|chao|привет|здарова)\s+verity\b/gi,
			"",
		)
		.replace(/^\s*verity\s*[,:-]?\s*/i, "")
		.trim();
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 */
function extractQuestion(player, message) {
	const trimmed = message.trim();
	if (!trimmed || trimmed.startsWith("/")) return null;

	const wakeQuestion = stripVerityWakePrefix(trimmed);
	const comeQuestion = wakeQuestion || trimmed;
	// Come-here ignores listen radius — recover/respawn if chunk unloaded.
	if (wantsComeHere(trimmed) || wantsComeHere(comeQuestion)) {
		const remoteBall = resolveVerityballForComeHere(player);
		if (remoteBall?.isValid) {
			return {
				question: comeQuestion,
				ball: remoteBall,
				mode: "ground",
			};
		}
	}

	const hasItem = playerHasVerityItem(player);
	const ball = findNearestVerityball(player, VERITY_LISTEN_RADIUS);
	const onGround = ball !== undefined;

	if (onGround) {
		return { question: trimmed, ball, mode: "ground" };
	}

	if (!hasItem) {
		clearInventoryAwake(player);
		return null;
	}

	if (!isInventoryAwake(player)) return null;

	const question = wakeQuestion || trimmed;
	if (!question) return null;

	return { question, ball: undefined, mode: "inventory" };
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 */
export async function handleVerityChat(player, message) {
	if (!(player instanceof Player)) return;
	if (wasChaseMercyRecent() || tryChaseMercyPlea(player, message)) {
		if (bridgeHardOnlyMode) {
			recordBridgePrep("mercy", true, "sorry");
			bridgeOutcome = "acted";
			replyTicket++;
		}
		return;
	}
	const phase = getVerityPhase();
	if (phase === PHASE.FOUR) return;
	if (phase !== PHASE.ONE && phase !== PHASE.TWO && phase !== PHASE.THREE) return;

	recordPlayerChat(player, message);

	const parsed = extractQuestion(player, message);
	if (!parsed) {
		if (bridgeHardOnlyMode) bridgeIgnored = true;
		return;
	}

	const { ball, mode } = parsed;
	const question = parsed.question;

	beginMessageContext(question, {
		lite: bridgeHardOnlyMode || isVerityBridgeConnected(),
	});
	try {
		const mindOpts = {
			ballNearby: ball !== undefined,
			inventoryAwake: mode === "inventory",
			mode,
		};

		const wantsMusic =
			wantsPlaySong(question) || detectControlIntent(question) === "stop_music";
		if (wantsMusic) {
			const musicBall = ball?.isValid
				? ball
				: resolveVerityballForComeHere(player);
			const musicUtility = tryVerityUtilityActions(
				player,
				question,
				musicBall ?? ball,
				phase,
			);
			if (musicUtility) {
				scheduleVerityReply(
					musicUtility.text,
					musicBall ?? ball,
					musicUtility.intent,
					undefined,
					undefined,
					player.id,
				);
				return;
			}
		}

		const audience = classifyAudience(player, question, mindOpts);
		if (audience === "player") {
			console.warn(`verity mind: ignored player-to-player chat`);
			if (bridgeHardOnlyMode) bridgeIgnored = true;
			return;
		}

		notifyVerityPlayerChat(player.id);

		if (mode === "inventory") touchInventoryAwake(player);

		const insultReply = tryInsultEscalation(player, question, ball);
		if (insultReply === SCOLD_MARKER) {
			replyTicket++;
			if (bridgeHardOnlyMode) {
				recordBridgePrep("scold", true, "Don't push me.");
				bridgeOutcome = "acted";
			}
			return;
		}
		if (insultReply) {
			scheduleVerityReply(insultReply, ball, "insult", undefined, undefined, player.id);
			return;
		}

		const mathReply = tryMathAnswer(question);
		if (mathReply) {
			scheduleVerityReply(mathReply, ball, "math", undefined, undefined, player.id);
			return;
		}

		// still spawns items even if pack language is English.
		const utilityBall =
			ball?.isValid
				? ball
				: wantsComeHere(question) ||
						wantsFollowMe(question) ||
						wantsStopFollow(question) ||
						wantsPlaySong(question) ||
						wantsItemDrop(question) ||
						detectControlIntent(question) === "stop_music"
					? resolveVerityballForComeHere(player)
					: undefined;
		const utility = tryVerityUtilityActions(
			player,
			question,
			utilityBall ?? ball,
			phase,
		);
		if (utility) {
			let replyBall = utilityBall ?? ball;
			if (utility.moveBall) {
				const targetBall = replyBall?.isValid
					? replyBall
					: resolveVerityballForComeHere(player);
				let moved = false;
				if (targetBall?.isValid) {
					moved = callVerityComeHere(player, targetBall);
					replyBall = targetBall;
				}
				if (!moved) {
					const localBall = resolveVerityballForComeHere(player, {
						forceLocal: true,
					});
					if (localBall?.isValid && callVerityComeHere(player, localBall)) {
						replyBall = localBall;
						moved = true;
					}
				}
				if (!moved) {
					scheduleVerityReply(
						"I couldn't reach you from there. Try again.",
						replyBall,
						"come_here",
						undefined,
						undefined,
						player.id,
					);
					return;
				}
			}
			if (utility.followMode) {
				const followBall = replyBall?.isValid
					? replyBall
					: resolveVerityballForComeHere(player);
				if (followBall?.isValid) {
					enableVerityballFollow(player, followBall);
					replyBall = followBall;
				}
			}
			if (utility.stopFollow) {
				const stopBall = replyBall?.isValid
					? replyBall
					: resolveVerityballForComeHere(player);
				if (stopBall?.isValid) {
					disableVerityballFollow(stopBall);
					replyBall = stopBall;
				}
			}
			scheduleVerityReply(
				utility.text,
				replyBall,
				utility.intent,
				undefined,
				undefined,
				player.id,
			);
			return;
		}

		const storyReply = await tryStoryChat(player, question, ball, phase);
		if (storyReply) {
			scheduleVerityReply(
				storyReply.text,
				ball,
				storyReply.intent ?? "story",
				storyReply.afterReply,
				storyReply.voice,
				player.id,
				storyReply.voiceMouthFace,
			);
			return;
		}

		if (bridgeHardOnlyMode && isStoryModeEnabled()) {
			const wait = getExpectedStoryBeat();
			if (wait) {
				recordBridgePrep("story_wait", false, wait);
				bridgeOutcome = "full";
				console.warn(`verity story wait classify beat=${wait}`);
				return;
			}
		}

		if (phase === PHASE.TWO || phase === PHASE.THREE) {
			const soundId = findSoundKey(question);
			if (soundId && wantsSoundRequest(question)) {
				playVeritySound(player, ball, soundId);
				scheduleVerityReply(
					pickLine(["There. Hear that?", "Played it.", "Listen."]),
					ball,
					"sound",
					undefined,
					undefined,
					player.id,
				);
				return;
			}

			const mindPeek = analyzeMind(player, question, mindOpts);
			const gameplayIntents = new Set([
				"locate_structure",
				"locate_biome",
				"follow_up_precise",
				"ore_nearby",
			]);
			if (gameplayIntents.has(mindPeek.intent)) {
				const result = await buildAnswer(player, question, ball, mindOpts);
				if (result === null) return;
				if (result === RAIN_COUNTDOWN_MARKER) {
					startRainCountdown(player, ball);
					return;
				}
				scheduleVerityReply(
					result.text,
					ball,
					result.intent,
					undefined,
					result.voice,
					player.id,
					result.voiceMouthFace,
				);
				return;
			}

			const phase2Reply = tryPhase2Chat(player, question, ball);
			if (phase2Reply) {
				if (phase2Reply.delivered) {
					replyTicket++;
					markVerityReplied(player.id);
					if (bridgeHardOnlyMode) {
						recordBridgePrep(
							phase2Reply.intent ?? "story",
							true,
							"pack",
						);
						bridgeOutcome = "acted";
					}
					return;
				}
				scheduleVerityReply(
					phase2Reply.text,
					ball,
					phase2Reply.intent ?? "story",
					undefined,
					phase2Reply.voice,
					player.id,
					phase2Reply.voiceMouthFace,
				);
				return;
			}

			const brainReply = await tryBrainAnswer(player, question);
			if (brainReply) {
				scheduleVerityReply(
					brainReply,
					ball,
					"brain",
					undefined,
					resolveYesNoVoice(question, brainReply),
					player.id,
				);
				return;
			}
			return;
		}

		if (phase !== PHASE.ONE) return;

		const result = await buildAnswer(player, question, ball, mindOpts);
		if (result === null) return;
		if (result === RAIN_COUNTDOWN_MARKER) {
			startRainCountdown(player, ball);
			return;
		}
		scheduleVerityReply(
			result.text,
			ball,
			result.intent,
			undefined,
			result.voice,
			player.id,
			result.voiceMouthFace,
		);
	} finally {
		endMessageContext();
	}
}

/**
 * Force a classified story beat (no extra Groq chat).
 * @param {import("@minecraft/server").Player} player
 * @param {string} beat
 * @returns {Promise<boolean>}
 */
export async function applyStoryHitFromBridge(player, beat) {
	const ball = findNearestVerityball(player, VERITY_LISTEN_RADIUS);
	const reply = await applyExpectedStoryBeat(player, beat);
	if (!reply) return false;
	scheduleVerityReply(
		reply.text,
		ball,
		reply.intent ?? "story",
		reply.afterReply,
		reply.voice,
		player.id,
		reply.voiceMouthFace,
	);
	return true;
}

/**
 * Run the chat pipeline for the STT/LLM bridge.
 * Addon prepares actions silently; Groq is the only speaker (except ignore).
 * Returns: "acted" | "full" | "ignore"
 *
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 * @returns {Promise<"acted" | "full" | "ignore">}
 */
export async function handleVerityChatTracked(player, message) {
	const before = replyTicket;
	bridgeHardOnlyMode = true;
	bridgeOutcome = "full";
	bridgeIgnored = false;
	lastBridgePrep = null;
	try {
		if (tryHeyVerityWake(player, message)) {
			if (!lastBridgePrep) {
				recordBridgePrep("wake", true, "I'm here.");
				bridgeOutcome = "acted";
			}
			return bridgeOutcome === "acted" ? "acted" : "full";
		}
		await handleVerityChat(player, message);
		if (bridgeIgnored) return "ignore";
		if (!lastBridgePrep && replyTicket === before) {
			recordBridgePrep("chat", false, "");
		}
		if (replyTicket !== before || bridgeOutcome === "acted") return "acted";
		return "full";
	} finally {
		bridgeHardOnlyMode = false;
	}
}

/**
 * Hurt reaction chat only — keep FACE_HURT, no talk mouth / face 2.
 * @param {import("@minecraft/server").Player} player
 * @param {string} text
 */
export function speakVerityHurtChat(player, text) {
	const line = String(text ?? "").trim();
	if (!line) return;
	replyTicket++;
	system.run(() => {
		// Bridge already printed via tellraw — avoid a duplicate chat line.
		if (!isVerityBridgeConnected()) {
			verityReply(line);
		}
		markVerityReplied(player.id);
	});
}

/**
 * Speak a reply that came from outside the addon (Groq via the websocket
 * bridge) using the same delivery stack as built-in lines: chat, mouth
 * animation and phase-appropriate faces. No think delay — the LLM already took
 * its time. Mouth hold is about 1.35 ticks per character (not Fish clip length).
 * holdTicks === 0 means chat only (follow-up chunks).
 *
 * @param {import("@minecraft/server").Player} player
 * @param {string} text
 * @param {number} [holdTicks]
 */
export function speakVerityExternal(player, text, holdTicks) {
	const line = String(text ?? "").trim();
	if (!line) return;

	const ball = findNearestVerityball(player, VERITY_LISTEN_RADIUS);
	replyTicket++;
	const keepNoface = isMercyNofacePending();

	if (line === "__MOUTH_ONLY__") {
		if (keepNoface) {
			markVerityReplied(player.id);
			return;
		}
		const ticks = Math.max(8, Number(holdTicks) || 20);
		system.run(() => {
			if (ball?.isValid) {
				const pair = getTalkFacePairFor(
					getVerityPhase(),
					getPhase2State(),
					P2_STATE,
				);
				holdMouthFace(ball, pair[1], ticks, () => {
					if (
						ball.isValid &&
						(getVerityPhase() === PHASE.TWO || getVerityPhase() === PHASE.THREE)
					) {
						applyPhase2BallFaces(ball);
					}
				}, pair[0]);
			}
			markVerityReplied(player.id);
		});
		return;
	}

	// holdTicks === 0 → chat only (follow-up chunks): no mouth, no face change
	// otherwise → mouth duration from character count
	const animateSpeech = holdTicks !== 0 && !keepNoface;

	system.run(() => {
		deliverVerityReply(line, ball, animateSpeech);
		markVerityReplied(player.id);
	});
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} message
 */
export function tryHeyVerityWake(player, message) {
	if (!playerHasVerityItem(player)) return false;
	if (findNearestVerityball(player, VERITY_LISTEN_RADIUS)) return false;

	const trimmed = String(message ?? "").trim();
	if (!HEY_VERITY.test(trimmed)) return false;

	touchInventoryAwake(player);

	const rest = stripVerityWakePrefix(trimmed);
	if (!rest) {
		wakeVerityFromInventory(player);
		return true;
	}

	return false;
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function wakeVerityFromInventory(player) {
	touchInventoryAwake(player);
	scheduleVerityReply(
		pickLine([
			"I'm here.",
			"I'm here. Go ahead.",
			"Yeah, I'm here. What do you need?",
			"Still here. Ask me anything.",
		]),
		undefined,
		"wake",
	);
}
