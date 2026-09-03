/** Random Minecraft facts — used when player asks for facts/trivia */
export const MINECRAFT_FACT_ANSWERS = [
	"Creepers were born from a failed pig model — programming accident, horror legend.",
	"Diamonds spawn best around Y -59 in 1.18+ — bring iron pickaxes, not hope.",
	"One block traveled in the Nether equals eight in the Overworld.",
	"Sleeping skips night only if no monsters are nearby — phantoms disagree.",
	"Fortune on crops gives more drops; Fortune on ores gives more resources, not more ore blocks.",
	"Water and lava make cobblestone, obsidian, or stone depending on what hits what first.",
	"Villagers restock trades twice a day if they have a job block and a bed.",
	"Elytra plus firework rockets beat every horse for long-distance travel.",
	"The Warden is blind but hears everything — wool muffles your steps.",
	"Beacons need a nether star from the Wither — endgame flex item.",
	"Smelting with kelp blocks is fuel-efficient — dried kelp blocks burn long.",
	"Looting increases mob drops; it does not increase ore from blocks.",
	"Shields block explosions and projectiles if you face them in time.",
	"Golden apples and enchanted golden apples are different — one is craftable.",
	"Bedrock wither has different behavior than Java — still miserable.",
	"Slime chunks exist below Y 40 — AFK farms love them.",
	"Bone meal on crops skips growth stages — instant farmer energy.",
	"Silk Touch on ice keeps ice; without it you get water.",
	"Name tags prevent despawning — rename your pets and your trauma.",
	"Ender chests share one inventory per player across dimensions.",
];

/** @type {import("../verity_knowledge_data.js").KnowledgeEntry[]} */
export const TRIVIA_KNOWLEDGE = [
	{
		patterns: [
			/\btell me (?:a |some |few )?facts?\b/,
			/\bgive me (?:a |some |few )?facts?\b/,
			/\bshare (?:a |some |few )?facts?\b/,
			/\brandom facts?\b/,
			/\bminecraft facts?\b/,
			/\bmc facts?\b/,
			/\bfact about minecraft\b/,
			/\btrivia about minecraft\b/,
			/\btell me (?:something|anything) (?:about )?minecraft\b/,
			/\bdo you know (?:any )?facts?\b/,
		],
		keywords: ["fact", "facts", "trivia", "random", "minecraft", "tell", "share"],
		answers: MINECRAFT_FACT_ANSWERS,
	},
];
