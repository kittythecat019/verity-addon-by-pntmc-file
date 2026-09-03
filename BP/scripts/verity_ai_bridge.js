/**
 * Bridge between the local Python websocket bridge (Groq STT + LLM) and the
 * normal Verity chat pipeline.
 *
 * Flow (single speaker = Groq + Fish):
 *   1. scriptevent pntmc:ai_ask Name|text
 *   2. Addon prepares silently (actions/story) → tags:
 *        pntmc_ai_ignore | pntmc_ai_needed
 *        pntmc_acted, pntmc_i_<intent>, pntmc_d_<draft>
 *   3. Python reads prep tags, asks Groq with that context
 *   4. scriptevent pntmc:ai_say Name|reply (+ Fish TTS)
 *   Optional: scriptevent pntmc:ai_drop Name|item_id|amount (Groq → addon)
 */

import { Player, system, world } from "@minecraft/server";
import {
	applyStoryHitFromBridge,
	handleVerityChatTracked,
	isBridgeStorySilent,
	speakVerityExternal,
	speakVerityHurtChat,
	clearBridgePrepTags,
	applyBridgePrepTags,
	findNearestVerityball,
} from "./verity_ai.js";
import { executeItemDropNearBall } from "./verity_lib.js";

const AI_NEEDED_TAG = "pntmc_ai_needed";
const AI_DONE_TAG = "pntmc_ai_done";
const AI_FLAVOR_TAG = "pntmc_ai_flavor";
const AI_IGNORE_TAG = "pntmc_ai_ignore";
const AI_SILENT_TAG = "pntmc_ai_silent";
const DROP_OK_TAG = "pntmc_drop_ok";
const DROP_FAIL_TAG = "pntmc_drop_fail";
const DROP_BLOCK_TAG = "pntmc_drop_block";
const DROP_INV_TAG = "pntmc_drop_inv";
const EVENT_ASK = "pntmc:ai_ask";
const EVENT_PREP_QUERY = "pntmc:prep_query";
const EVENT_SAY = "pntmc:ai_say";
/** Hurt ouch lines: chat only — keep hurt face, no talk mouth. */
const EVENT_HURT = "pntmc:ai_hurt";
const EVENT_STORY_HIT = "pntmc:story_hit";
/** Groq → addon: Name|item_id|amount */
const EVENT_DROP = "pntmc:ai_drop";
const DROP_LISTEN_RADIUS = 64;

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} tag
 */
function setResultTag(player, tag) {
	try {
		if (player.isValid) player.addTag(tag);
	} catch (err) {
		console.warn(`verity ai bridge set ${tag}: ${err}`);
	}
}

/**
 * @param {string} name
 * @returns {import("@minecraft/server").Player | undefined}
 */
function findPlayerByName(name) {
	const wanted = String(name ?? "").trim().toLowerCase();
	const players = [...world.getPlayers()];
	if (!wanted) return players[0];
	return (
		players.find((p) => p.name.toLowerCase() === wanted) ??
		players.find((p) => p.name.toLowerCase().includes(wanted)) ??
		players[0]
	);
}

/**
 * @param {string} raw
 * @returns {{ name: string, text: string, holdTicks?: number }}
 */
function parsePayload(raw) {
	const value = String(raw ?? "");
	const parts = value.split("|");
	if (parts.length >= 3 && /^\d+$/.test(parts[1].trim())) {
		return {
			name: parts[0].trim(),
			holdTicks: Number(parts[1].trim()),
			text: parts.slice(2).join("|").trim(),
		};
	}
	if (parts.length < 2) return { name: "", text: value.trim() };
	return {
		name: parts[0].trim(),
		text: parts.slice(1).join("|").trim(),
	};
}

/**
 * @param {import("@minecraft/server").Player} player
 */
function clearDropResultTags(player) {
	for (const tag of [DROP_OK_TAG, DROP_FAIL_TAG, DROP_BLOCK_TAG, DROP_INV_TAG]) {
		try {
			if (player.isValid) player.removeTag(tag);
		} catch {
			/* ignore */
		}
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} itemId
 * @param {string} amountText
 */
function handleBridgeDrop(player, itemId, amountText) {
	clearDropResultTags(player);
	const ball = findNearestVerityball(player, DROP_LISTEN_RADIUS);
	const result = executeItemDropNearBall(ball, itemId, amountText);
	if (result.ok) {
		setResultTag(player, DROP_OK_TAG);
		console.warn(
			`verity ai bridge: drop ok ${result.spawned}x ${result.itemId}`,
		);
		return;
	}
	if (result.reason === "powerful" || result.reason === "creative") {
		setResultTag(player, DROP_BLOCK_TAG);
		console.warn(`verity ai bridge: drop blocked ${result.itemId} (${result.reason})`);
		return;
	}
	if (result.reason === "no_ball") {
		setResultTag(player, DROP_INV_TAG);
		console.warn("verity ai bridge: drop no ball");
		return;
	}
	setResultTag(player, DROP_FAIL_TAG);
	console.warn(`verity ai bridge: drop fail ${result.reason} ${itemId}`);
}

export function registerAiBridgeEvents() {
	system.afterEvents.scriptEventReceive.subscribe(
		(ev) => {
			if (
				ev.id !== EVENT_ASK &&
				ev.id !== EVENT_PREP_QUERY &&
				ev.id !== EVENT_SAY &&
				ev.id !== EVENT_HURT &&
				ev.id !== EVENT_STORY_HIT &&
				ev.id !== EVENT_DROP
			) {
				return;
			}

			const { name, text, holdTicks } = parsePayload(ev.message);
			if (!text && ev.id !== EVENT_DROP && ev.id !== EVENT_PREP_QUERY) return;

			const player = findPlayerByName(name);
			if (!(player instanceof Player) || !player.isValid) {
				console.warn(`verity ai bridge: no player for ${ev.id} (${name})`);
				return;
			}

			if (ev.id === EVENT_PREP_QUERY) {
				applyBridgePrepTags(player);
				console.warn("verity ai bridge: prep query reapplied");
				return;
			}

			if (ev.id === EVENT_DROP) {
				const bits = String(text || "").split("|");
				const itemId = (bits[0] || "").trim();
				const amountText = (bits[1] || "10").trim();
				if (!itemId) {
					clearDropResultTags(player);
					setResultTag(player, DROP_FAIL_TAG);
					return;
				}
				console.warn(`verity ai bridge: drop ${itemId} x${amountText}`);
				system.run(() => {
					if (!player.isValid) return;
					handleBridgeDrop(player, itemId, amountText);
				});
				return;
			}

			if (ev.id === EVENT_STORY_HIT) {
				console.warn(`verity ai bridge: story hit ${text}`);
				applyStoryHitFromBridge(player, text).catch((err) => {
					console.warn(`verity ai bridge story hit: ${err}`);
				});
				return;
			}

			if (ev.id === EVENT_HURT) {
				console.warn(`verity ai bridge: hurt chat "${text.slice(0, 60)}"`);
				speakVerityHurtChat(player, text);
				return;
			}

			if (ev.id === EVENT_SAY) {
				console.warn(
					`verity ai bridge: say ticks=${holdTicks ?? "chars"} "${text.slice(0, 60)}"`,
				);
				speakVerityExternal(player, text, holdTicks);
				return;
			}

			try {
				player.removeTag(AI_NEEDED_TAG);
				player.removeTag(AI_DONE_TAG);
				player.removeTag(AI_FLAVOR_TAG);
				player.removeTag(AI_IGNORE_TAG);
				player.removeTag(AI_SILENT_TAG);
				clearBridgePrepTags(player);
			} catch (err) {
				console.warn(`verity ai bridge clear tags: ${err}`);
			}

			console.warn(`verity ai bridge: ask "${text.slice(0, 60)}"`);
			handleVerityChatTracked(player, text)
				.then((outcome) => {
					console.warn(`verity ai bridge: outcome=${outcome}`);
					system.run(() => {
						if (!player.isValid) return;
						if (outcome === "ignore") {
							setResultTag(player, AI_IGNORE_TAG);
							return;
						}
						applyBridgePrepTags(player);
						if (isBridgeStorySilent()) {
							setResultTag(player, AI_SILENT_TAG);
							console.warn("verity ai bridge: pack silent (no groq/fish)");
							return;
						}
						setResultTag(player, AI_NEEDED_TAG);
					});
				})
				.catch((err) => {
					console.warn(`verity ai bridge chat: ${err}`);
					setResultTag(player, AI_NEEDED_TAG);
				});
		},
		{ namespaces: ["pntmc"] },
	);
}
