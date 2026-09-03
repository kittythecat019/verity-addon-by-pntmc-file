/**
 * Locate helpers — structures: proximity + getGeneratedStructures spiral + entities + /locate.
 * Biomes: findClosestBiome (2.9+) then /locate fallback.
 *
 * CommandResult (official API) only exposes successCount. Some runtimes still attach
 * statusMessage on sync runCommand — we read it when present, but never rely on it alone.
 *
 * Fallback: pulse pntmclocatestructure_<id> (command-block /locate) like SB Compass.
 */

import { system, world } from "@minecraft/server";

const LOCATE_TEMPLATE_PREFIX = "pntmclocatestructure_";
const LOCATE_PULSE_Y = 123;
const LOCATE_PULSE_WAIT_TICKS = 5;

/** @type {Set<string>} */
const locatePulseBusy = new Set();

/**
 * Map Verity keys → structure file suffix (structures/pntmclocatestructure_<id>.mcstructure).
 * @type {Record<string, string>}
 */
const STRUCTURE_TEMPLATE_IDS = {
	village: "village",
	stronghold: "stronghold",
	mansion: "mansion",
	monument: "monument",
	shipwreck: "shipwreck",
	mineshaft: "mineshaft",
	ancient_city: "ancient_city",
	bastion_remnant: "bastion_remnant",
	bastion: "bastion",
	pillager_outpost: "pillager_outpost",
	ruined_portal: "ruined_portal",
	buried_treasure: "buried_treasure",
	end_city: "end_city",
	fortress: "fortress",
	temple: "temple",
	desert_pyramid: "temple",
	jungle_pyramid: "temple",
	swamp_hut: "temple",
	igloo: "temple",
	trail_ruins: "trail_ruins",
	trial_chambers: "trial_chambers",
	ocean_ruin: "ruins",
	ruins: "ruins",
};

/**
 * @type {Record<string, string>}
 */
const BIOME_TEMPLATE_IDS = {
	desert: "desert",
	jungle: "jungle",
	roofed_forest: "roofed_forest",
	swamp: "swampland",
	swampland: "swampland",
	mangrove_swamp: "mangrove_swamp",
	taiga: "taiga",
	cold_taiga: "cold_taiga",
	savanna: "savanna",
	mesa: "mesa",
	cherry_grove: "cherry_grove",
	plains: "plains",
	forest: "forest",
	flower_forest: "flower_forest",
	birch_forest: "birch_forest",
	ice_plains: "ice_plains",
	deep_dark: "deep_dark",
	mushroom_island: "mushroom_island",
	ocean: "ocean",
	warm_ocean: "ocean",
	deep_ocean: "ocean",
	beach: "beach",
	meadow: "meadow",
	lush_caves: "lush_caves",
	dripstone_caves: "dripstone_caves",
	pale_garden: "pale_garden",
	basalt_deltas: "basalt_deltas",
	crimson_forest: "crimson_forest",
	warped_forest: "warped_forest",
	soulsand_valley: "soulsand_valley",
	stony_peaks: "stony_peaks",
	jagged_peaks: "jagged_peaks",
	grove: "grove",
};

/**
 * @param {number} ticks
 */
function waitTicks(ticks) {
	return new Promise((resolve) => {
		system.runTimeout(() => resolve(undefined), Math.max(1, ticks));
	});
}

/**
 * @param {"structure"|"biome"} kind
 * @param {string} base
 * @returns {string | null}
 */
function resolveLocateTemplateId(kind, base) {
	const key = base.replace(/^minecraft:/, "");
	if (kind === "structure") {
		return STRUCTURE_TEMPLATE_IDS[key] ?? (STRUCTURE_LOCATE_IDS[key] ? key : null);
	}
	return BIOME_TEMPLATE_IDS[key] ?? key;
}

/**
 * Load pntmclocatestructure_<id>, pulse redstone, then try /locate for coords.
 * @param {import("@minecraft/server").Player} player
 * @param {"structure"|"biome"} kind
 * @param {string} id
 * @returns {Promise<LocateResult | null>}
 */
export async function locateWithStructureTemplate(player, kind, id) {
	const base = id.replace(/^minecraft:/, "");
	if (base === "any_structure") return null;

	const templateSuffix = resolveLocateTemplateId(kind, base);
	if (!templateSuffix) return null;

	const structureName = `${LOCATE_TEMPLATE_PREFIX}${templateSuffix}`;
	const busyKey = `${player.id}:${structureName}`;
	if (locatePulseBusy.has(busyKey)) return null;
	locatePulseBusy.add(busyKey);

	/** @type {boolean | undefined} */
	let prevFeedback;
	try {
		prevFeedback = world.gameRules.sendCommandFeedback;
		world.gameRules.sendCommandFeedback = true;
	} catch {
		/* ignore */
	}

	try {
		const px = Math.floor(player.location.x);
		const pz = Math.floor(player.location.z);
		const y = LOCATE_PULSE_Y;

		try {
			player.runCommand(`structure load ${structureName} ${px} ${y} ${pz}`);
			player.runCommand(`setblock ${px} ${y + 1} ${pz} redstone_block`);
		} catch (err) {
			console.warn(`verity locate template load ${structureName}: ${err}`);
			return null;
		}

		/** @type {string[]} */
		const commands = [];
		const seen = new Set();
		if (kind === "structure") {
			for (const structureId of STRUCTURE_LOCATE_IDS[base] ?? [`minecraft:${base}`]) {
				for (const cmd of structureLocateCommands(structureId)) {
					if (seen.has(cmd)) continue;
					seen.add(cmd);
					commands.push(cmd);
				}
			}
		} else {
			for (const biome of BIOME_LOCATE_IDS[base] ?? [base]) {
				for (const cmd of biomeLocateCommands(biome)) {
					if (seen.has(cmd)) continue;
					seen.add(cmd);
					commands.push(cmd);
				}
			}
		}

		/** @type {LocateResult | null} */
		let found = null;
		for (const command of commands) {
			const { raw, successCount, coords } = runLocateCommand(player, command);
			if (coords) {
				found = {
					x: coords.x,
					z: coords.z,
					raw: raw || command,
					via: "structure_template",
					locateCommand: command,
				};
				break;
			}
			if (successCount > 0 && !found) {
				found = {
					x: Math.floor(player.location.x),
					z: Math.floor(player.location.z),
					raw: raw || command,
					via: "structure_template",
					chatOnly: true,
					locateCommand: command,
				};
			}
		}

		await waitTicks(LOCATE_PULSE_WAIT_TICKS);

		if (!found || found.chatOnly) {
			for (const command of commands) {
				const { raw, successCount, coords } = runLocateCommand(player, command);
				if (coords) {
					found = {
						x: coords.x,
						z: coords.z,
						raw: raw || command,
						via: "structure_template",
						locateCommand: command,
					};
					break;
				}
				if (successCount > 0 && !found) {
					found = {
						x: Math.floor(player.location.x),
						z: Math.floor(player.location.z),
						raw: raw || command,
						via: "structure_template",
						chatOnly: true,
						locateCommand: command,
					};
				}
			}
		}

		try {
			player.runCommand(`fill ${px} ${y} ${pz} ${px} ${y + 1} ${pz} air`);
		} catch (err) {
			console.warn(`verity locate template cleanup: ${err}`);
		}

		if (found) {
			console.warn(
				`verity locate template ${structureName}: ${found.chatOnly ? "chatOnly" : `${found.x},${found.z}`}`,
			);
		}
		return found;
	} finally {
		locatePulseBusy.delete(busyKey);
		try {
			world.gameRules.sendCommandFeedback = prevFeedback ?? false;
		} catch {
			/* ignore */
		}
	}
}

/** Bedrock 1.19.30+ — locate structure minecraft:<id> */
/** @type {Record<string, string[]>} */
const STRUCTURE_LOCATE_IDS = {
	village: ["minecraft:village"],
	stronghold: ["minecraft:stronghold"],
	mansion: ["minecraft:mansion"],
	monument: ["minecraft:monument"],
	shipwreck: ["minecraft:shipwreck"],
	mineshaft: ["minecraft:mineshaft"],
	ancient_city: ["minecraft:ancient_city"],
	bastion_remnant: ["minecraft:bastion_remnant"],
	pillager_outpost: ["minecraft:pillager_outpost"],
	ruined_portal: ["minecraft:ruined_portal"],
	buried_treasure: ["minecraft:buried_treasure"],
	end_city: ["minecraft:end_city"],
	fortress: ["minecraft:fortress"],
	temple: ["minecraft:temple"],
	desert_pyramid: ["minecraft:temple"],
	jungle_pyramid: ["minecraft:temple"],
	trail_ruins: ["minecraft:trail_ruins"],
	trial_chambers: ["minecraft:trial_chambers"],
	swamp_hut: ["minecraft:temple"],
	igloo: ["minecraft:temple"],
	ocean_ruin: ["minecraft:ruins"],
	nether_fossil: ["minecraft:nether_fossil"],
};

/** @type {Record<string, string[]>} */
const STRUCTURE_DIMENSIONS = {
	fortress: ["minecraft:nether"],
	bastion_remnant: ["minecraft:nether"],
	nether_fossil: ["minecraft:nether"],
	end_city: ["minecraft:the_end"],
};

/** @type {Record<string, string>} */
const STRUCTURE_DIMENSION_LABEL = {
	"minecraft:nether": "the Nether",
	"minecraft:the_end": "the End",
};

/** getGeneratedStructures feature ids (minecraft:*) */
/** @type {Record<string, string[]>} */
const STRUCTURE_FEATURE_IDS = {
	village: ["minecraft:village"],
	stronghold: ["minecraft:stronghold"],
	mansion: ["minecraft:mansion"],
	monument: ["minecraft:monument"],
	shipwreck: ["minecraft:shipwreck"],
	mineshaft: ["minecraft:mineshaft"],
	ancient_city: ["minecraft:ancient_city"],
	bastion_remnant: ["minecraft:bastion_remnant"],
	pillager_outpost: ["minecraft:pillager_outpost"],
	ruined_portal: ["minecraft:ruined_portal"],
	buried_treasure: ["minecraft:buried_treasure"],
	end_city: ["minecraft:end_city"],
	fortress: ["minecraft:fortress"],
	temple: ["minecraft:temple"],
	desert_pyramid: ["minecraft:temple"],
	jungle_pyramid: ["minecraft:temple"],
	trail_ruins: ["minecraft:trail_ruins"],
	trial_chambers: ["minecraft:trial_chambers"],
	swamp_hut: ["minecraft:temple"],
	igloo: ["minecraft:temple"],
	ocean_ruin: ["minecraft:ruins"],
};

/** @type {Record<string, string[]>} */
const STRUCTURE_ENTITY_TYPES = {
	village: ["minecraft:villager", "minecraft:villager_v2", "minecraft:iron_golem"],
	mansion: ["minecraft:evoker", "minecraft:vindicator"],
	monument: ["minecraft:guardian", "minecraft:elder_guardian"],
	pillager_outpost: ["minecraft:pillager"],
	fortress: ["minecraft:blaze", "minecraft:wither_skeleton"],
	end_city: ["minecraft:shulker"],
	bastion_remnant: ["minecraft:piglin_brute", "minecraft:hoglin"],
	swamp_hut: ["minecraft:witch"],
};

/** @type {Record<string, string[]>} */
const BIOME_LOCATE_IDS = {
	desert: ["desert", "minecraft:desert"],
	jungle: ["jungle", "minecraft:jungle"],
	roofed_forest: ["roofed_forest", "dark_forest", "minecraft:roofed_forest"],
	swamp: ["swamp", "minecraft:swamp"],
	mangrove_swamp: ["mangrove_swamp", "minecraft:mangrove_swamp"],
	taiga: ["taiga", "minecraft:taiga"],
	cold_taiga: ["cold_taiga", "snowy_taiga", "minecraft:cold_taiga"],
	savanna: ["savanna", "minecraft:savanna"],
	mesa: ["mesa", "badlands", "minecraft:mesa"],
	cherry_grove: ["cherry_grove", "minecraft:cherry_grove"],
	plains: ["plains", "minecraft:plains"],
	forest: ["forest", "minecraft:forest"],
	flower_forest: ["flower_forest", "minecraft:flower_forest"],
	birch_forest: ["birch_forest", "minecraft:birch_forest"],
	old_growth_birch_forest: ["old_growth_birch_forest", "minecraft:old_growth_birch_forest"],
	ice_plains: ["ice_plains", "snowy_plains", "minecraft:ice_plains"],
	deep_dark: ["deep_dark", "minecraft:deep_dark"],
	mushroom_island: ["mushroom_island", "mooshroom_island", "minecraft:mushroom_island"],
	ocean: ["ocean", "minecraft:ocean"],
	warm_ocean: ["warm_ocean", "minecraft:warm_ocean"],
	deep_ocean: ["deep_ocean", "minecraft:deep_ocean"],
};

/**
 * @typedef {{ x: number, z: number, raw: string, via?: string, chatOnly?: boolean, locateCommand?: string, wrongDimension?: boolean, requiredDimension?: string, foundId?: string }} LocateResult
 */

/**
 * @param {string} raw
 * @returns {{ x: number, z: number } | null}
 */
export function parseLocateCoords(raw) {
	if (!raw || typeof raw !== "string") return null;

	const patterns = [
		/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/,
		/at\s+block\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i,
		/located\s+[\w\s]+\s+at\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i,
		/nearest\s+[\w\s]+\s+at\s+block\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i,
		/(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/,
		/(-?\d+)\s+(-?\d+)\s+(-?\d+)/,
	];

	for (const pattern of patterns) {
		const match = raw.match(pattern);
		if (!match) continue;
		const x = Number(match[1]);
		const z = Number(match[3]);
		if (!Number.isNaN(x) && !Number.isNaN(z)) return { x, z };
	}

	const nums = raw.match(/-?\d+/g);
	if (nums && nums.length >= 3) {
		const x = Number(nums[0]);
		const z = Number(nums[2]);
		if (!Number.isNaN(x) && !Number.isNaN(z)) return { x, z };
	}
	if (nums && nums.length >= 2) {
		const x = Number(nums[0]);
		const z = Number(nums[nums.length - 1]);
		if (!Number.isNaN(x) && !Number.isNaN(z)) return { x, z };
	}
	return null;
}

/**
 * Send locate coordinates directly to the player.
 * @param {import("@minecraft/server").Player} player
 * @param {number} x
 * @param {number} z
 * @param {string} label
 */
export function sendLocateCoordsToPlayer(player, x, z, label) {
	const pretty = label.replace(/_/g, " ");
	try {
		player.sendMessage(`§7[Verity] §f${pretty}: §eX ${x}§7, §eZ ${z}`);
	} catch {
		try {
			player.runCommand(
				`tellraw @s {"rawtext":[{"text":"§7[Verity] §f${pretty}: §eX ${x}§7, §eZ ${z}"}]}`,
			);
		} catch {
			/* ignore */
		}
	}
}

/**
 * @param {import("@minecraft/server").Vector3} origin
 * @param {{ x: number, z: number }} coords
 */
function distanceSqXZ(origin, coords) {
	const dx = origin.x - coords.x;
	const dz = origin.z - coords.z;
	return dx * dx + dz * dz;
}

/**
 * @param {number} originX
 * @param {number} originZ
 * @param {number} maxRadiusChunks
 * @param {number} stepChunks
 * @returns {Generator<{ x: number, z: number, cx: number, cz: number }>}
 */
function* spiralChunkCenters(originX, originZ, maxRadiusChunks, stepChunks) {
	const ocx = Math.floor(originX / 16);
	const ocz = Math.floor(originZ / 16);
	const step = Math.max(1, stepChunks);

	yield {
		cx: ocx,
		cz: ocz,
		x: ocx * 16 + 8,
		z: ocz * 16 + 8,
	};

	for (let ring = step; ring <= maxRadiusChunks; ring += step) {
		const minX = ocx - ring;
		const maxX = ocx + ring;
		const minZ = ocz - ring;
		const maxZ = ocz + ring;

		for (let cx = minX; cx <= maxX; cx += step) {
			yield { cx, cz: minZ, x: cx * 16 + 8, z: minZ * 16 + 8 };
			yield { cx, cz: maxZ, x: cx * 16 + 8, z: maxZ * 16 + 8 };
		}
		for (let cz = minZ + step; cz <= maxZ - step; cz += step) {
			yield { cx: minX, cz, x: minX * 16 + 8, z: cz * 16 + 8 };
			yield { cx: maxX, cz, x: maxX * 16 + 8, z: cz * 16 + 8 };
		}
	}
}

/**
 * @param {string} featureId
 * @param {string[]} targets
 */
function structureFeatureMatches(featureId, targets) {
	const bare = String(featureId).replace(/^minecraft:/, "").toLowerCase();
	const normalized = new Set(
		targets.flatMap((t) => {
			const b = t.replace(/^minecraft:/, "").toLowerCase();
			return [b, b.replace(/_/g, "")];
		}),
	);
	return normalized.has(bare) || normalized.has(bare.replace(/_/g, ""));
}

/**
 * Sample a couple of positions inside a chunk at the player's Y (no getTopmostBlock — too heavy).
 * @param {number} cx
 * @param {number} cz
 * @param {number} baseY
 * @returns {{ x: number, y: number, z: number }[]}
 */
function structureSamplePoints(cx, cz, baseY) {
	const x = cx * 16 + 8;
	const z = cz * 16 + 8;
	return [
		{ x, y: baseY, z },
		{ x, y: baseY - 24, z },
	];
}

/**
 * Spiral search using Dimension.getGeneratedStructures (loaded chunks only).
 * @param {import("@minecraft/server").Player} player
 * @param {string[]} featureIds
 * @param {{ intensive?: boolean }} [options]
 * @returns {LocateResult | null}
 */
function locateStructureNative(player, featureIds, options = {}) {
	const dim = player.dimension;
	if (typeof dim.getGeneratedStructures !== "function") return null;
	if (typeof dim.isChunkLoaded !== "function") return null;

	const intensive = options.intensive === true;
	const origin = player.location;
	const baseY = Math.floor(origin.y);
	/** @type {{ x: number, z: number, raw: string, dist: number, foundId?: string } | null} */
	let best = null;
	let attempts = 0;
	const maxAttempts = intensive ? 180 : 96;
	const maxRadiusChunks = intensive ? 96 : 64;
	const stepChunks = intensive ? 4 : 6;
	const earlyExitDist = 96 * 96;

	for (const point of spiralChunkCenters(origin.x, origin.z, maxRadiusChunks, stepChunks)) {
		if (++attempts > maxAttempts) break;

		try {
			if (!dim.isChunkLoaded({ x: point.x, y: baseY, z: point.z })) continue;
		} catch {
			continue;
		}

		for (const sample of structureSamplePoints(point.cx, point.cz, baseY)) {
			/** @type {(string)[]} */
			let structures;
			try {
				structures = dim.getGeneratedStructures(sample);
			} catch {
				continue;
			}

			if (!structures?.length) continue;

			for (const feature of structures) {
				if (!structureFeatureMatches(String(feature), featureIds)) continue;
				const dist = distanceSqXZ(origin, sample);
				const hit = {
					x: sample.x,
					z: sample.z,
					raw: `api:${feature}`,
					foundId: String(feature).replace(/^minecraft:/, ""),
					dist,
				};
				if (!best || dist < best.dist) best = hit;
			}
		}

		if (best && best.dist < earlyExitDist) break;
	}

	if (!best) return null;
	console.warn(`verity locate structure api: ${best.raw} @ ${best.x} ${best.z}`);
	return { x: best.x, z: best.z, raw: best.raw, via: "api", foundId: best.foundId };
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} structureKey
 * @param {{ maxDistance?: number }} [options]
 * @returns {LocateResult | null}
 */
function locateStructureEntities(player, structureKey, options = {}) {
	const types = STRUCTURE_ENTITY_TYPES[structureKey];
	if (!types?.length) return null;

	const origin = player.location;
	const maxDistance = options.maxDistance ?? 320;
	/** @type {{ x: number, z: number, raw: string, dist: number, foundId?: string } | null} */
	let best = null;

	try {
		for (const ent of player.dimension.getEntities({
			location: origin,
			maxDistance,
		})) {
			if (!ent.isValid) continue;
			if (!types.includes(ent.typeId)) continue;
			const x = Math.floor(ent.location.x);
			const z = Math.floor(ent.location.z);
			const dist = distanceSqXZ(origin, { x, z });
			if (!best || dist < best.dist) {
				best = {
					x,
					z,
					raw: `entity:${ent.typeId}`,
					foundId: String(ent.typeId).replace(/^minecraft:/, ""),
					dist,
				};
			}
		}
	} catch (err) {
		console.warn(`verity locate entities ${structureKey}: ${err}`);
	}

	if (!best) return null;
	console.warn(`verity locate entity ${structureKey}: ${best.raw} @ ${best.x} ${best.z}`);
	return { x: best.x, z: best.z, raw: best.raw, via: "entity", foundId: best.foundId };
}

/**
 * Read CommandResult — successCount is the stable API; statusMessage may exist at runtime.
 * @param {import("@minecraft/server").CommandResult | undefined} result
 * @returns {{ successCount: number, raw: string, coords: { x: number, z: number } | null }}
 */
function readCommandResult(result) {
	const successCount = Number(result?.successCount ?? 0);
	let raw = "";

	if (typeof result?.statusMessage === "string" && result.statusMessage.length > 0) {
		raw = result.statusMessage;
	} else if (result && typeof result === "object") {
		for (const key of ["message", "output", "status", "errorMessage", "data"]) {
			const value = /** @type {Record<string, unknown>} */ (result)[key];
			if (typeof value === "string" && value.length > 0) {
				raw = value;
				break;
			}
		}
	}

	const coords = raw ? parseLocateCoords(raw) : null;
	return { successCount, raw, coords };
}

/**
 * @param {string} command
 * @param {import("@minecraft/server").CommandResult} result
 */
function logCommandResult(command, result) {
	try {
		const parsed = readCommandResult(result);
		const extraKeys =
			result && typeof result === "object"
				? Object.keys(result).filter((k) => k !== "successCount")
				: [];
		console.warn(
			`verity locate cmd result (${command}): ${JSON.stringify({
				successCount: parsed.successCount,
				raw: parsed.raw || "(empty)",
				coords: parsed.coords,
				extraKeys,
			})}`,
		);
	} catch {
		console.warn(`verity locate cmd result (${command}): [unserializable]`);
	}
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} command
 * @returns {{ raw: string, successCount: number, coords: { x: number, z: number } | null }}
 */
function runLocateCommand(player, command) {
	const bare = command.replace(/^\//, "");
	try {
		const result = player.runCommand(bare);
		const parsed = readCommandResult(result);
		if (parsed.raw || parsed.successCount > 0) {
			logCommandResult(bare, result);
		}
		return parsed;
	} catch (err) {
		console.warn(`verity locate cmd "${bare}": ${err}`);
	}
	return { raw: "", successCount: 0, coords: null };
}

/**
 * @param {string} structureKey
 * @returns {string}
 */
export function getPrimaryLocateCommand(structureKey) {
	const base = structureKey.replace(/^minecraft:/, "");
	const ids = STRUCTURE_LOCATE_IDS[base] ?? [`minecraft:${base}`];
	return structureLocateCommands(ids[0])[0];
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} structureKey
 * @returns {string | null} human label e.g. "the Nether"
 */
export function getStructureDimensionMismatch(player, structureKey) {
	const base = structureKey.replace(/^minecraft:/, "");
	const allowed = STRUCTURE_DIMENSIONS[base];
	if (!allowed?.length) return null;
	if (allowed.includes(player.dimension.id)) return null;
	const required = allowed[0];
	return STRUCTURE_DIMENSION_LABEL[required] ?? required.replace(/^minecraft:/, "");
}

/**
 * @param {string} structureId — minecraft:stronghold, village, etc.
 * @returns {string[]}
 */
function structureLocateCommands(structureId) {
	const full = structureId.includes(":")
		? structureId
		: `minecraft:${structureId.replace(/^minecraft:/, "")}`;
	const bare = full.replace(/^minecraft:/, "");
	return [`locate structure ${full}`, `locate structure ${bare}`];
}

/**
 * @param {string} biomeId
 * @returns {string[]}
 */
function biomeLocateCommands(biomeId) {
	const id = biomeId.includes(":")
		? biomeId
		: `minecraft:${biomeId.replace(/^minecraft:/, "")}`;
	return [`locate biome ${id}`];
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string[]} commands
 * @param {{ featureIds?: string[], structureKey?: string }} [fallback]
 * @returns {LocateResult | null}
 */
function tryLocateCommands(player, commands, fallback = {}) {
	let commandSucceeded = false;

	for (const command of commands) {
		const { raw, successCount, coords } = runLocateCommand(player, command);

		if (raw && /\b(couldn't|could not|unable|not find|no structure|no biome|invalid)\b/i.test(raw)) {
			continue;
		}

		const parsed = coords ?? (raw ? parseLocateCoords(raw) : null);
		if (parsed) {
			console.warn(`verity locate ok (${command}): ${raw || `${parsed.x}, ?, ${parsed.z}`}`);
			return { x: parsed.x, z: parsed.z, raw: raw || command, via: "command", locateCommand: command };
		}

		if (successCount > 0) {
			commandSucceeded = true;
			console.warn(
				`verity locate cmd successCount=${successCount} but no coords (${command}): ${raw || "(empty)"}`,
			);
		} else if (raw) {
			console.warn(`verity locate unparsed (${command}): ${raw}`);
		}
	}

	if (commandSucceeded && fallback.featureIds?.length) {
		const intensiveNative = locateStructureNative(player, fallback.featureIds, { intensive: true });
		if (intensiveNative) return intensiveNative;
	}
	if (commandSucceeded && fallback.structureKey) {
		const wideEntity = locateStructureEntities(player, fallback.structureKey, { maxDistance: 640 });
		if (wideEntity) return wideEntity;
	}

	return null;
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} biomeId
 * @returns {LocateResult | null}
 */
function locateBiomeNative(player, biomeId) {
	const dim = player.dimension;
	if (typeof dim.findClosestBiome !== "function") return null;

	const candidates = BIOME_LOCATE_IDS[biomeId] ?? [biomeId, `minecraft:${biomeId}`];
	const seen = new Set();

	for (const candidate of candidates) {
		const key = candidate.replace(/^minecraft:/, "");
		if (seen.has(key)) continue;
		seen.add(key);

		try {
			const pos = dim.findClosestBiome(player.location, candidate, {
				boundingSize: { x: 256, y: 128, z: 256 },
			});
			if (!pos) continue;
			const x = Math.floor(pos.x);
			const z = Math.floor(pos.z);
			console.warn(`verity locate biome api (${candidate}): ${x} ${pos.y} ${z}`);
			return { x, z, raw: `api:${candidate} ${x} ${pos.y} ${z}`, via: "api" };
		} catch (err) {
			console.warn(`verity locate biome api ${candidate}: ${err}`);
		}
	}
	return null;
}

const ANY_STRUCTURE_ORDER = [
	"village",
	"pillager_outpost",
	"shipwreck",
	"ruined_portal",
	"mineshaft",
	"desert_pyramid",
	"jungle_pyramid",
	"swamp_hut",
	"igloo",
	"ocean_ruin",
	"monument",
	"mansion",
	"stronghold",
	"ancient_city",
	"trial_chambers",
	"trail_ruins",
	"fortress",
	"bastion_remnant",
	"nether_fossil",
	"end_city",
];

/**
 * Try to find any nearby structure before falling back to /locate for a specific one.
 * @param {import("@minecraft/server").Player} player
 * @returns {LocateResult | null}
 */
function locateAnyStructure(player) {
	const featureIds = [];
	for (const key of ANY_STRUCTURE_ORDER) {
		for (const id of STRUCTURE_FEATURE_IDS[key] ?? []) {
			if (!featureIds.includes(id)) featureIds.push(id);
		}
	}

	const native = locateStructureNative(player, featureIds);
	if (native) return native;

	/** @type {Record<string, string>} */
	const typeToKey = {};
	for (const key of ANY_STRUCTURE_ORDER) {
		for (const t of STRUCTURE_ENTITY_TYPES[key] ?? []) {
			if (!(t in typeToKey)) typeToKey[t] = key;
		}
	}

	const origin = player.location;
	/** @type {{ x: number, z: number, foundId: string, dist: number } | null} */
	let best = null;
	try {
		for (const ent of player.dimension.getEntities({ location: origin, maxDistance: 320 })) {
			if (!ent.isValid) continue;
			const key = typeToKey[ent.typeId];
			if (!key) continue;
			const x = Math.floor(ent.location.x);
			const z = Math.floor(ent.location.z);
			const dist = distanceSqXZ(origin, { x, z });
			if (!best || dist < best.dist) best = { x, z, foundId: key, dist };
		}
	} catch (err) {
		console.warn(`verity locate any entities: ${err}`);
	}

	if (!best) return null;
	console.warn(`verity locate any entity: ${best.foundId} @ ${best.x} ${best.z}`);
	return { x: best.x, z: best.z, raw: `entity:any:${best.foundId}`, via: "entity", foundId: best.foundId };
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {"structure"|"biome"} kind
 * @param {string} id
 * @returns {LocateResult | null}
 */
export function locateNearest(player, kind, id) {
	const base = id.replace(/^minecraft:/, "");

	if (kind === "biome") {
		const native = locateBiomeNative(player, base);
		if (native) return native;

		const biomeCandidates = BIOME_LOCATE_IDS[base] ?? [base];
		/** @type {string[]} */
		const commands = [];
		const seenCmd = new Set();
		for (const biome of biomeCandidates) {
			for (const cmd of biomeLocateCommands(biome)) {
				if (seenCmd.has(cmd)) continue;
				seenCmd.add(cmd);
				commands.push(cmd);
			}
		}
		return tryLocateCommands(player, commands);
	}

	if (base === "any_structure") {
		return locateAnyStructure(player);
	}

	const featureIds = STRUCTURE_FEATURE_IDS[base] ?? [`minecraft:${base}`];

	const dimMismatch = getStructureDimensionMismatch(player, base);
	if (dimMismatch) {
		return {
			x: Math.floor(player.location.x),
			z: Math.floor(player.location.z),
			raw: `wrong_dimension:${dimMismatch}`,
			via: "dimension",
			wrongDimension: true,
			requiredDimension: dimMismatch,
		};
	}

	const structureIds = STRUCTURE_LOCATE_IDS[base] ?? [`minecraft:${base}`];
	/** @type {string[]} */
	const commands = [];
	const seenCmd = new Set();
	for (const structureId of structureIds) {
		for (const cmd of structureLocateCommands(structureId)) {
			if (seenCmd.has(cmd)) continue;
			seenCmd.add(cmd);
			commands.push(cmd);
		}
	}

	const native = locateStructureNative(player, featureIds);
	if (native) return native;

	const entityHit = locateStructureEntities(player, base);
	if (entityHit) return entityHit;

	return tryLocateCommands(player, commands, { featureIds, structureKey: base });
}
