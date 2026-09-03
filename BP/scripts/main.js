import {
	ItemStack,
	Player,
	system,
	world } from "@minecraft/server";
import {
	handleVerityChat,
	tryHeyVerityWake,
	verityReply,
	isVerityBridgeConnected,
} from "./verity_ai.js";
import { registerAiBridgeEvents } from "./verity_ai_bridge.js";
import {
	initVerityChase,
	handleChaseTestChat,
	resetChaseForPlayer,
	restoreChaseSession,
	tryChaseMercyPlea,
} from "./verity_chase.js";
import {
	initVerityPhase2,
	logVerityProgressStatus,
	resetVerityProgress,
	ensureNewGamePhaseOne,
	enforceProgressionIntegrity,
	validatePhaseProgression
} from "./verity_phase2.js";
import {
	clearPlayerContext
} from "./verity_intent.js";
import {
	initVerityGuardian,
	setVerityTarget,
	initVerityResurrection,
	registerVerityballOwner,
	clearVerityballOwnerPersist,
	restoreVerityballOwners,
	initVerityDrop,
	initVerityIntro,
	markIntroComplete,
	resetVerityIntro,
	initFlashlight,
	initVerityProactive,
	initVerityChestEscape,
	initVerityBallFollow,
	disableVerityballFollow,
	clearAllOnlinePlayerPersist,
	initHauntedVillagePurge,
	resetStoryWorldProps,
	registerStoryModeCommand,
	resolveLocalizedVoiceId,
	VOICE,
	getSoundDurationTicks,
	FACE_BORED_P2,
	FACE_HUNGRY_OPEN,
	FACE_HUNGRY_SHUT,
	FACE_HURT,
	FACE_SMILE,
	FACE_SPEAK,
	PHASE,
	applyBallFace,
	applyPhaseFaces,
	getVerityPhase,
	isVerityballSpeaking,
	VERITY_ITEM_TO_FACE,
	resolveVerityInventoryItemId,
	isVerityDropGrace,
	clearCanonicalVerityball,
	enforceSingleVerityball,
	initVeritySingleton
} from "./verity_lib.js";

const BOX_ID = "pntmc:cardboard_box";
const VERITYBALL_ID = "pntmc:verityball";
const VERITYBALL_FALL_ID = "pntmc:verityball_fall";
const FACE_SWITCH_TICKS = 20;
const GROUND_SPAWN_TICKS = 80;
const FLOAT_HEIGHT = 1.9;
const OPEN_WAIT_TICKS = 90;
const GREETING_DELAY_TICKS = 10;
const GREETING_DURATION_TICKS = 120;

/** Blocks that open UI / interact — not valid Verity place targets */
const INTERACTIVE_BLOCK_IDS = new Set([
	"minecraft:crafting_table",
	"minecraft:cartography_table",
	"minecraft:fletching_table",
	"minecraft:smithing_table",
	"minecraft:stonecutter_block",
	"minecraft:loom",
	"minecraft:composter",
	"minecraft:brewing_stand",
	"minecraft:enchanting_table",
	"minecraft:anvil",
	"minecraft:chipped_anvil",
	"minecraft:damaged_anvil",
	"minecraft:grindstone",
	"minecraft:chest",
	"minecraft:trapped_chest",
	"minecraft:ender_chest",
	"minecraft:barrel",
	"minecraft:furnace",
	"minecraft:lit_furnace",
	"minecraft:blast_furnace",
	"minecraft:lit_blast_furnace",
	"minecraft:smoker",
	"minecraft:lit_smoker",
	"minecraft:hopper",
	"minecraft:dispenser",
	"minecraft:dropper",
	"minecraft:lectern",
	"minecraft:jukebox",
	"minecraft:bell",
	"minecraft:beacon",
	"minecraft:shulker_box",
	"minecraft:crafter",
	"minecraft:undyed_shulker_box",
]);

const GREETING_CHAT =
	"Hello, I'm Verity, your personal helper friend. Ask me anything, I know everything.";
const ASKME_SOUND = VOICE.ASKME;
const PARTICLE1_DELAY_TICKS = 75;
const PARTICLE2_DELAY_TICKS = 82;
const PARTICLE_OPEN1 = "pntmc:verityopen1";
const PARTICLE_OPEN = "pntmc:verityopen";

const AMBIENT_SOUNDS = [
	"pntmc.verity.whosthere",
	"pntmc.verity.hello",
	"pntmc.verity.punchcardboardbox",
];
const OPENING_SOUND = "pntmc.verity.opening";

/** @type {Map<string, string>} */
const ambientLoops = new Map();

/** @type {Map<string, { face: number, loc: import("@minecraft/server").Vector3, dimensionId: string, itemTypeId: string }>} */
const pendingVerityPlacements = new Map();

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} loc
 * @param {string} soundId
 */
function playSoundAtBox(dim, loc, soundId) {
	for (const player of dim.getPlayers()) {
		try {
			player.playSound(soundId, {
				location: loc,
				volume: 1,
				pitch: 1,
			});
		} catch (err) {
			console.warn(`pntmc.verity playSound ${soundId}: ${err}`);
		}
	}
}

/**
 * @param {string} entityId
 */
function stopAmbientLoop(entityId) {
	const runId = ambientLoops.get(entityId);
	if (runId === undefined) return;
	system.clearRun(runId);
	ambientLoops.delete(entityId);
}

/**
 * @param {import("@minecraft/server").Entity} box
 */
function startAmbientLoop(box) {
	if (ambientLoops.has(box.id)) return;

	const runId = system.runInterval(() => {
		if (!box.isValid) {
			stopAmbientLoop(box.id);
			return;
		}

		try {
			if (box.getProperty("pntmc:opened")) return;
		} catch (err) {
			console.warn(`cardboard_box ambient property: ${err}`);
			return;
		}

		const sound =
			AMBIENT_SOUNDS[Math.floor(Math.random() * AMBIENT_SOUNDS.length)];
		playSoundAtBox(box.dimension, box.location, sound);
	}, 46);

	ambientLoops.set(box.id, runId);
}

/**
 * @param {import("@minecraft/server").Entity} ball
 */
function scheduleVerityballGreeting(ball) {
	system.runTimeout(() => {
		if (!ball.isValid) return;

		const loc = ball.location;
		try {
			ball.setProperty("pntmc:face_index", FACE_SPEAK);
			ball.setProperty("pntmc:talking", true);
		} catch (err) {
			console.warn(`verityball greeting start: ${err}`);
		}

		const askme = resolveLocalizedVoiceId(ASKME_SOUND);
		if (askme) playSoundAtBox(ball.dimension, loc, askme);

		try {
			verityReply(GREETING_CHAT);
		} catch (err) {
			console.warn(`verityball greeting chat: ${err}`);
		}

		const mouthTicks = askme
			? getSoundDurationTicks(askme)
			: GREETING_DURATION_TICKS;
		system.runTimeout(() => {
			if (!ball.isValid) return;
			try {
				ball.setProperty("pntmc:face_index", FACE_SMILE);
				ball.setProperty("pntmc:talking", false);
			} catch (err) {
				console.warn(`verityball greeting end: ${err}`);
			}
		}, mouthTicks);
	}, GREETING_DELAY_TICKS);
}

/**
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} loc
 */
function scheduleVerityballSequence(dim, loc) {
	let introBall;
	try {
		introBall = dim.spawnEntity(VERITYBALL_FALL_ID, loc);
	} catch (err) {
		console.warn(`cardboard_box spawn verityball_fall: ${err}`);
		return;
	}

	try {
		introBall.setProperty("pntmc:face_index", FACE_HURT);
	} catch (propErr) {
		console.warn(`verityball intro props: ${propErr}`);
	}

	system.runTimeout(() => {
		if (!introBall.isValid) return;
		try {
			introBall.setProperty("pntmc:face_index", FACE_HURT);
		} catch (faceErr) {
			console.warn(`verityball fall hurt face: ${faceErr}`);
		}
	}, FACE_SWITCH_TICKS);

	system.runTimeout(() => {
		if (!introBall.isValid) return;

		const ballLoc = introBall.location;

		try {
			const ball = dim.spawnEntity(VERITYBALL_ID, {
				x: ballLoc.x,
				y: ballLoc.y,
				z: ballLoc.z,
			});
			try {
				ensureNewGamePhaseOne();
				applyPhaseFaces(ball);
			} catch (propErr) {
				console.warn(`verityball transform props: ${propErr}`);
			}
			scheduleVerityballGreeting(ball);
		} catch (spawnErr) {
			console.warn(`verityball transform: ${spawnErr}`);
		}

		try {
			introBall.remove();
		} catch (removeErr) {
			console.warn(`verityball fall remove: ${removeErr}`);
		}
	}, GROUND_SPAWN_TICKS);
}

/**
 * @param {import("@minecraft/server").Entity} box
 * @param {import("@minecraft/server").Player} player
 */
function openBox(box, player) {
	setVerityTarget(player);
	let alreadyOpen = false;
	try {
		alreadyOpen = box.getProperty("pntmc:opened");
	} catch (err) {
		console.warn(`cardboard_box open read: ${err}`);
		return;
	}
	if (alreadyOpen) return;

	markIntroComplete();

	const loc = { ...box.location };
	const dim = box.dimension;

	try {
		box.setProperty("pntmc:opened", true);
	} catch (err) {
		console.warn(`cardboard_box open set: ${err}`);
		return;
	}

	stopAmbientLoop(box.id);
	playSoundAtBox(dim, loc, OPENING_SOUND);

	const particleLoc = {
		x: loc.x,
		y: loc.y + FLOAT_HEIGHT,
		z: loc.z,
	};

	system.runTimeout(() => {
		try {
			dim.spawnParticle(PARTICLE_OPEN1, particleLoc);
		} catch (err) {
			console.warn(`cardboard_box particle1: ${err}`);
		}
	}, PARTICLE1_DELAY_TICKS);

	system.runTimeout(() => {
		try {
			dim.spawnParticle(PARTICLE_OPEN, particleLoc);
		} catch (err) {
			console.warn(`cardboard_box particle2: ${err}`);
		}
	}, PARTICLE2_DELAY_TICKS);

	system.runTimeout(() => {
		scheduleVerityballSequence(dim, {
			x: loc.x,
			y: loc.y,
			z: loc.z,
		});

		if (box.isValid) {
			try {
				box.triggerEvent("pntmc:despawn");
			} catch (err) {
				console.warn(`cardboard_box despawn: ${err}`);
			}
		}
	}, OPEN_WAIT_TICKS);
}

world.afterEvents.entitySpawn.subscribe((ev) => {
	if (ev.entity.typeId !== BOX_ID) return;
	startAmbientLoop(ev.entity);
});

world.afterEvents.entityHitEntity.subscribe((ev) => {
	if (!(ev.damagingEntity instanceof Player)) return;
	const target = ev.hitEntity;
	if (!target?.isValid) return;

	if (target.typeId === BOX_ID) {
		openBox(target, ev.damagingEntity);
	}
});

world.afterEvents.entityRemove.subscribe((ev) => {
	stopAmbientLoop(ev.removedEntityId);
});

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} faceIndex
 */
function applyVerityballFace(ball, faceIndex) {
	applyBallFace(ball, faceIndex, false);
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
 * @param {import("@minecraft/server").Player} player
 * @param {number} faceIndex
 * @param {import("@minecraft/server").Vector3} loc
 * @param {string} itemTypeId
 */
function queueVerityPlacement(player, faceIndex, loc, itemTypeId) {
	pendingVerityPlacements.set(player.id, {
		face: faceIndex,
		loc,
		dimensionId: player.dimension.id,
		itemTypeId,
	});
	system.runTimeout(() => {
		pendingVerityPlacements.delete(player.id);
	}, 40);
}

/**
 * @param {import("@minecraft/server").Block} block
 */
function isInteractiveBlockType(typeId) {
	if (INTERACTIVE_BLOCK_IDS.has(typeId)) return true;
	return (
		/_door$/.test(typeId) ||
		/_trapdoor$/.test(typeId) ||
		/_fence_gate$/.test(typeId) ||
		/_button$/.test(typeId) ||
		/_pressure_plate$/.test(typeId) ||
		typeId.includes("shulker_box")
	);
}

/**
 * Only block UI/interact blocks — placement is handled by entity_placer.
 * @param {import("@minecraft/server").Block} block
 */
function isValidVerityPlaceTarget(block) {
	if (!block) return false;
	return !isInteractiveBlockType(block.typeId);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} faceIndex
 * @param {string} itemTypeId
 */
function finalizeVerityPlacement(player, ball, faceIndex, itemTypeId) {
	applyVerityballFace(ball, faceIndex);
	registerVerityballOwner(ball, player);
	consumeHeldItem(player, itemTypeId);
	pendingVerityPlacements.delete(player.id);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {number} faceIndex
 * @param {number} attempt
 */
function retryApplyPlacedFace(player, faceIndex, attempt = 0) {
	const pending = pendingVerityPlacements.get(player.id);
	if (!pending || !player.isValid) return;

	if (attempt > 20) {
		pendingVerityPlacements.delete(player.id);
		console.warn(
			`verityball place: no entity near ${player.name} — item kept`,
		);
		return;
	}

	let nearest;
	let nearestDist = Infinity;

	try {
		for (const ball of player.dimension.getEntities({
			type: VERITYBALL_ID,
			location: player.location,
			maxDistance: 8,
		})) {
			if (!ball.isValid) continue;
			const d = distSq(ball.location, player.location);
			if (d < nearestDist) {
				nearestDist = d;
				nearest = ball;
			}
		}
	} catch (err) {
		console.warn(`verityball place scan: ${err}`);
	}

	if (nearest?.isValid) {
		finalizeVerityPlacement(
			player,
			nearest,
			faceIndex,
			pending.itemTypeId,
		);
		return;
	}

	system.runTimeout(() => {
		retryApplyPlacedFace(player, faceIndex, attempt + 1);
	}, 1);
}

/**
 * Backup if entity_placer did not consume the item (same as VERITY4).
 * @param {import("@minecraft/server").Player} player
 * @param {string} itemTypeId
 */
function consumeHeldItem(player, itemTypeId) {
	const inventory = player.getComponent("minecraft:inventory");
	if (!inventory?.container) return;

	const slot = player.selectedSlotIndex;
	const held = inventory.container.getItem(slot);
	if (!held || held.typeId !== itemTypeId) return;

	if (held.amount <= 1) {
		inventory.container.setItem(slot, undefined);
	} else {
		held.amount -= 1;
		inventory.container.setItem(slot, held);
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} itemTypeId
 * @param {import("@minecraft/server").Vector3} loc
 */
function placeVerityItem(player, itemTypeId, loc) {
	const faceIndex = VERITY_ITEM_TO_FACE[itemTypeId];
	if (faceIndex === undefined) return;

	queueVerityPlacement(player, faceIndex, loc, itemTypeId);
	retryApplyPlacedFace(player, faceIndex);
}
function onVerityItemPlace(ev) {
	const itemTypeId = ev.itemStack?.typeId;
	const faceIndex = VERITY_ITEM_TO_FACE[itemTypeId];
	if (faceIndex === undefined) return;
	if (!(ev.source instanceof Player)) return;

	const block = ev.block;
	if (!isValidVerityPlaceTarget(block)) {
		console.warn(
			`verityball place blocked: ${block.typeId} — item kept`,
		);
		return;
	}

	placeVerityItem(ev.source, itemTypeId, {
		x: block.location.x + 0.5,
		y: block.location.y + 1,
		z: block.location.z + 0.5,
	});
}

/**
 * @param {import("@minecraft/server").EntitySpawnAfterEvent} ev
 */
function onVerityballSpawn(ev) {
	if (ev.entity.typeId !== VERITYBALL_ID) return;

	const ball = ev.entity;
	// Ball from drop/throw — not an entity_placer placement.
	if (isVerityDropGrace(ball)) return;

	const ballLoc = ball.location;

	for (const [playerId, data] of pendingVerityPlacements) {
		if (ball.dimension.id !== data.dimensionId) continue;

		const player = world.getEntity(playerId);
		if (!player?.isValid) continue;
		if (distSq(ballLoc, player.location) > 64) continue;

		if (player instanceof Player) {
			finalizeVerityPlacement(player, ball, data.face, data.itemTypeId);
		} else {
			applyVerityballFace(ball, data.face);
			pendingVerityPlacements.delete(playerId);
		}
		return;
	}
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @returns {number | undefined}
 */
function readVerityballFace(ball) {
	try {
		const face = ball.getProperty("pntmc:face_index");
		return typeof face === "number" ? face : Number(face);
	} catch (err) {
		console.warn(`verityball pickup read face: ${err}`);
		return undefined;
	}
}

/**
 * @param {import("@minecraft/server").ItemStack | undefined} stack
 */
function isEmptyHand(stack) {
	return !stack || stack.typeId === "minecraft:air" || stack.amount <= 0;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {number} faceIndex
 * @returns {string | undefined}
 */
function resolvePickupItemId(_ball, faceIndex) {
	return resolveVerityInventoryItemId(faceIndex);
}

/**
 * @param {import("@minecraft/server").Vector3} loc
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {number} [maxDist]
 */
function findNearestPlayerForPickup(loc, dimension, maxDist = 5) {
	let nearest;
	let best = maxDist;
	for (const player of dimension.getPlayers()) {
		if (!player.isValid) continue;
		const dx = player.location.x - loc.x;
		const dy = player.location.y - loc.y;
		const dz = player.location.z - loc.z;
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (d < best) {
			best = d;
			nearest = player;
		}
	}
	return nearest;
}

/**
 * @param {import("@minecraft/server").Entity} ball
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").ItemStack | undefined} heldItem
 * @returns {boolean}
 */
function tryVerityballPickup(ball, player, heldItem) {
	if (!ball.isValid || ball.typeId !== VERITYBALL_ID) return false;

	if (isVerityDropGrace(ball)) {
		console.warn("verityball pickup blocked: drop grace");
		return false;
	}

	try {
		if (ball.getProperty("pntmc:faceless") === true) {
			console.warn("verityball pickup blocked: faceless");
			return false;
		}
		if (ball.getProperty("pntmc:chase_face") === true) {
			console.warn("verityball pickup blocked: chase face");
			return false;
		}
	} catch {
		/* ignore */
	}

	if (isVerityballSpeaking(ball)) {
		console.warn("verityball pickup blocked: speaking");
		return false;
	}

	const faceIndex = readVerityballFace(ball);
	if (faceIndex === undefined || Number.isNaN(faceIndex)) {
		console.warn("verityball pickup blocked: no face_index");
		return false;
	}

	const itemId = resolvePickupItemId(ball, faceIndex);
	if (!itemId) return false;

	const inventory = player.getComponent("minecraft:inventory");
	if (!inventory?.container) return false;

	const container = inventory.container;
	const held =
		heldItem ?? container.getItem(player.selectedSlotIndex);
	const reward = new ItemStack(itemId, 1);

	if (isEmptyHand(held)) {
		container.setItem(player.selectedSlotIndex, reward);
	} else {
		const leftover = container.addItem(reward);
		if (leftover) {
			console.warn("verityball pickup: inventory full");
			return false;
		}
	}

	try {
		disableVerityballFollow(ball);
		ball.remove();
		clearCanonicalVerityball();
	} catch (err) {
		console.warn(`verityball pickup remove: ${err}`);
		return false;
	}

	return true;
}

const itemPlaceEvent =
	world.afterEvents.itemUseOn ??
	world.afterEvents.itemStopUseOn ??
	world.afterEvents.itemStartUseOn;
if (itemPlaceEvent) {
	itemPlaceEvent.subscribe(onVerityItemPlace);
} else {
	console.warn("pntmc: item place events unavailable");
}

const itemUseOnBefore = world.beforeEvents.itemUseOn;
if (itemUseOnBefore) {
	itemUseOnBefore.subscribe((ev) => {
		const itemTypeId = ev.itemStack?.typeId;
		if (!VERITY_ITEM_TO_FACE[itemTypeId]) return;
		if (!isValidVerityPlaceTarget(ev.block)) {
			ev.cancel = true;
		}
	});
}

world.afterEvents.entitySpawn.subscribe(onVerityballSpawn);

const itemUseBefore = world.beforeEvents.itemUse;
if (itemUseBefore) {
	itemUseBefore.subscribe((ev) => {
		const itemTypeId = ev.itemStack?.typeId;
		if (VERITY_ITEM_TO_FACE[itemTypeId]) {
			ev.cancel = true;
		}
	});
}

const interactEvent = world.afterEvents.playerInteractWithEntity;
if (interactEvent) {
	interactEvent.subscribe((ev) => {
		if (ev.target.typeId !== VERITYBALL_ID) return;
		if (!(ev.player instanceof Player)) return;
		tryVerityballPickup(ev.target, ev.player, ev.itemStack);
	});
}

const entityTrigger = world.afterEvents.dataDrivenEntityTrigger;
if (entityTrigger) {
	entityTrigger.subscribe((ev) => {
		if (ev.eventId !== "pntmc:pickup") return;
		if (ev.entity.typeId !== VERITYBALL_ID || !ev.entity.isValid) return;
		const player = findNearestPlayerForPickup(ev.entity.location, ev.entity.dimension, 6);
		if (!(player instanceof Player)) return;
		tryVerityballPickup(ev.entity, player, undefined);
	});
}

// Hitting the ball shows hurt face (verity_drop); do not pick up — avoids instant inventory after throw.

function scanExistingBoxes() {
	for (const player of world.getPlayers()) {
		try {
			for (const box of player.dimension.getEntities({ type: BOX_ID })) {
				if (box.isValid) startAmbientLoop(box);
			}
		} catch (err) {
			console.warn(`cardboard_box init scan: ${err}`);
		}
	}
}

system.run(() => {
	scanExistingBoxes();
	initVerityGuardian();
	initVerityPhase2();
	initVerityResurrection();
	initVerityDrop();
	initVerityChase();
	initVerityIntro(openBox);
	initFlashlight();
	initHauntedVillagePurge();
	initVeritySingleton();
	initVerityProactive();
	initVerityChestEscape();
	initVerityBallFollow();
});

registerStoryModeCommand(() => {
	validatePhaseProgression();
	logVerityProgressStatus();
});
registerAiBridgeEvents();

if (world.afterEvents.worldLoad) {
	world.afterEvents.worldLoad.subscribe(() => {
		system.run(() => {
			enforceProgressionIntegrity();
			scanExistingBoxes();
			restoreVerityballOwners();
			for (const player of world.getPlayers()) {
				restoreChaseSession(player);
			}
		});
	});
}

const chatSend = world.beforeEvents.chatSend;
if (chatSend) {
	chatSend.subscribe((ev) => {
		const sender = ev.sender;
		const message = ev.message;
		if (!(sender instanceof Player)) return;

		const lower = message.trim().toLowerCase();
		// Hide !talk from chat while bridge is online; Python polls pntmc_want_talk.
		if (/^!talk\b/i.test(message.trim())) {
			if (isVerityBridgeConnected()) {
				ev.cancel = true;
				system.run(() => {
					try {
						sender.addTag("pntmc_want_talk");
						console.warn("verity chat: hidden !talk → mic tag");
					} catch (err) {
						console.warn(`verity !talk tag: ${err}`);
					}
				});
			}
			return;
		}
		if (
			lower === "!veritychase" ||
			lower === "/veritychase" ||
			lower === "!window" ||
			lower === "/window" ||
			lower === "!veritywindow" ||
			lower === "/veritywindow"
		) {
			ev.cancel = true;
			system.run(() => handleChaseTestChat(sender, message));
			return;
		}
		if (lower === "!verityreset" || lower === "/verityreset") {
			ev.cancel = true;
			system.run(() => {
				for (const player of world.getPlayers()) {
					resetChaseForPlayer(player);
					clearPlayerContext(player.id);
				}
				clearAllOnlinePlayerPersist();
				clearVerityballOwnerPersist();
				resetVerityProgress();
				resetStoryWorldProps();
				resetVerityIntro();
				clearCanonicalVerityball();
				enforceSingleVerityball();
				try {
					sender.sendMessage("§7[Verity] Progress reset — phase 1.");
				} catch {
					/* ignore */
				}
			});
			return;
		}
		if (lower === "!verityphase" || lower === "/verityphase") {
			ev.cancel = true;
			system.run(() => {
				logVerityProgressStatus();
				try {
					sender.sendMessage(
						`§7[Verity] Phase ${getVerityPhase()} (p2state ${world.getDynamicProperty("pntmc:phase2_state") ?? 0}) — see content log.`,
					);
				} catch {
					/* ignore */
				}
			});
			return;
		}

		system.run(() => {
			if (tryChaseMercyPlea(sender, message)) return;
			// Python bridge connected → typed chat goes Groq + Fish (via WS).
			// Addon only answers when bridge is offline (keyword fallback).
			if (isVerityBridgeConnected()) {
				console.warn("verity chat: bridge online — defer to Groq/Fish");
				return;
			}
			if (tryHeyVerityWake(sender, message)) return;
			handleVerityChat(sender, message).catch((err) => {
				console.warn(`verity chat: ${err}`);
			});
		});
	});
} else {
	console.warn("pntmc: chatSend unavailable — enable Beta APIs");
}

