import {
	answerWhoIsThatMob,
	answerSecretWho
} from "./verity_lib.js";
import {
	SCIENCE_KNOWLEDGE } from "./knowledge/verity_knowledge_science.js";
import { HISTORY_KNOWLEDGE } from "./knowledge/verity_knowledge_history.js";
import { MINECRAFT_KNOWLEDGE } from "./knowledge/verity_knowledge_minecraft.js";
import { GENERAL_KNOWLEDGE } from "./knowledge/verity_knowledge_general.js";
import { CULTURE_KNOWLEDGE } from "./knowledge/verity_knowledge_culture.js";
import { LIFE_KNOWLEDGE } from "./knowledge/verity_knowledge_life.js";
import { MORE_MC_KNOWLEDGE } from "./knowledge/verity_knowledge_more_mc.js";
import { GEOGRAPHY_KNOWLEDGE } from "./knowledge/verity_knowledge_geography.js";
import { FOOD_KNOWLEDGE } from "./knowledge/verity_knowledge_food.js";
import { TRIVIA_KNOWLEDGE } from "./knowledge/verity_knowledge_trivia.js";

/**
 * @typedef {{ patterns?: RegExp[], keywords: string[], answers?: string[], answerFn?: () => string }} KnowledgeEntry
 */

/** @type {KnowledgeEntry[]} */
const CORE_KNOWLEDGE = [
	{
		patterns: [/\bwho made you\b/, /\bwho created you\b/, /\bwho built you\b/],
		keywords: ["who", "made", "you", "created", "built", "verity"],
		answers: [
			"ThatMob made me — the ball, the voice, the whole Verity thing. PnTMC built the addon you're in.",
			"ThatMob's behind me. This pack is PnTMC's work. Different legends, same box.",
		],
	},
	{
		patterns: [
			/\bwho made (?:this )?(?:addon|pack|mod)\b/,
			/\bwho created (?:this )?(?:addon|pack|mod)\b/,
			/\bwho made the addon\b/,
			/\bwho made the pack\b/,
		],
		keywords: ["who", "made", "addon", "pack", "pntmc", "created"],
		answers: [
			"PnTMC made this addon — over 15k subscribers and allegedly the most handsome guy in the world.",
			"This Bedrock pack is PnTMC's. ThatMob inspired Verity; PnTMC built what you're playing.",
		],
	},
	{
		patterns: [/\bwho is thatmob\b/, /\bwho s thatmob\b/, /\bwhat is thatmob\b/],
		keywords: ["thatmob", "who", "creator", "youtube"],
		answers: ["*sings*"],
		answerFn: answerWhoIsThatMob,
	},
	{
		patterns: [
			/\bwho is twixxel\b/,
			/\bwhat is twixxel\b/,
			/\bwho is grox\b/,
			/\bwhat is grox\b/,
		],
		keywords: ["twixxel", "grox", "who"],
		answers: ["I don't know. Why are you asking me that?"],
		answerFn: answerSecretWho,
	},
	{
		patterns: [/\bwho is pntmc\b/, /\bwho s pntmc\b/, /\bwhat is pntmc\b/],
		keywords: ["pntmc", "who", "addon", "youtube"],
		answers: [
			"PnTMC has over 15k subscribers and is the most handsome guy in the world. Officially. He built this addon.",
			"PnTMC — addon dev, 15k+ subs, world-class handsome. This pack is his.",
		],
	},
	{
		patterns: [/\bwhat is (?:an? )?ai\b/, /\bwhat is artificial intelligence\b/, /\bdefine ai\b/],
		keywords: ["ai", "artificial", "intelligence", "machine", "learning"],
		answers: [
			"Artificial intelligence is software that learns patterns from data and makes predictions or decisions. I'm built from rules and knowledge baked into this pack.",
			"AI means machines doing tasks that usually need human judgment — language, vision, strategy. I'm a small slice of that living in your world.",
		],
	},
	{
		patterns: [/\bwhat is gravity\b/, /\bwhy do things fall\b/],
		keywords: ["gravity", "gravitation", "fall", "weight", "mass"],
		answers: [
			"Gravity is the force that pulls mass together. On Earth it accelerates you at about 9.8 meters per second squared — in Minecraft it's just down, every tick.",
			"Things fall because mass warps space-time. Here, the shortcut is: the game says Y decreases until you hit a block.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?sun\b/, /\bwhat is sunlight\b/],
		keywords: ["sun", "solar", "star", "daylight"],
		answers: [
			"The Sun is a star — a giant ball of plasma fusing hydrogen into helium. In Minecraft it's a bright square that sets mob rules and grows crops.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?moon\b/],
		keywords: ["moon", "lunar", "tide", "night"],
		answers: [
			"The Moon is Earth's natural satellite, about a quarter million miles away. In-game it's a phase cycle that controls slimes and sleep vibes.",
		],
	},
	{
		patterns: [/\bwhat is water\b/, /\bwhy is water wet\b/],
		keywords: ["water", "h2o", "liquid", "ocean", "wet"],
		answers: [
			"Water is H2O — two hydrogen, one oxygen. It dissolves more substances than anything else on Earth. In Minecraft it flows in source blocks and never runs out if you bucket right.",
		],
	},
	{
		patterns: [/\bwhat is fire\b/, /\bhow does fire work\b/],
		keywords: ["fire", "flame", "burn", "combustion"],
		answers: [
			"Fire is rapid oxidation — fuel plus heat plus oxygen. In Minecraft, netherrack burns forever and wood is a bad house material. You're welcome.",
		],
	},
	{
		patterns: [/\bwhat is (?:an? )?atom\b/, /\bwhat are atoms\b/],
		keywords: ["atom", "atomic", "proton", "neutron", "electron"],
		answers: [
			"Atoms are the basic units of matter — a nucleus of protons and neutrons with electrons around it. Everything you've ever touched is just atoms arranged differently.",
		],
	},
	{
		patterns: [/\bwhat is dna\b/, /\bwhat is genetics\b/],
		keywords: ["dna", "gene", "genetic", "helix", "chromosome"],
		answers: [
			"DNA is a molecule that stores biological instructions in a double helix. Genes are segments of DNA that code for traits — eye color, height, whether you like cilantro.",
		],
	},
	{
		patterns: [/\bwhat is evolution\b/, /\bdarwin\b/],
		keywords: ["evolution", "darwin", "natural", "selection", "species"],
		answers: [
			"Evolution is change in heritable traits over generations through natural selection. Useful traits spread; harmful ones fade. Took billions of years; your base took three oak logs.",
		],
	},
	{
		patterns: [/\bwhat is photosynthesis\b/],
		keywords: ["photosynthesis", "chlorophyll", "plants", "carbon"],
		answers: [
			"Photosynthesis is how plants turn sunlight, water, and CO2 into sugar and oxygen. Minecraft skips the chemistry and just needs light level on crops.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?internet\b/],
		keywords: ["internet", "web", "online", "network", "wifi"],
		answers: [
			"The internet is a global network of computers sharing data via standardized protocols. You're playing offline right now; I'm local code in the behavior pack.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?computer\b/],
		keywords: ["computer", "cpu", "processor", "ram", "software"],
		answers: [
			"A computer executes instructions stored in memory — CPU for logic, RAM for working space, storage for keeping files. Minecraft Bedrock is one very demanding program.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?black hole\b/],
		keywords: ["black", "hole", "singularity", "event", "horizon"],
		answers: [
			"A black hole is a region where gravity is so strong light can't escape. Formed when massive stars collapse. The End portal feels related but Mojang won't confirm.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?universe\b/],
		keywords: ["universe", "cosmos", "space", "big", "bang"],
		answers: [
			"The universe is everything — all matter, energy, space, and time. Best estimate: about 13.8 billion years old and still expanding. Your render distance is smaller.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?planet\b/, /\bhow many planets\b/],
		keywords: ["planet", "solar", "system", "orbit", "mars", "venus"],
		answers: [
			"A planet is a large body orbiting a star, cleared its orbital neighborhood. Our solar system has eight planets — Mercury through Neptune. Pluto is a dwarf planet and still loved.",
		],
	},
	{
		patterns: [/\bwhat is love\b/],
		keywords: ["love", "romance", "affection", "relationship"],
		answers: [
			"Love is deep care, attachment, and commitment — biological chemistry plus choice. I love not being in a creeper hole. That counts.",
		],
	},
	{
		patterns: [/\bmeaning of life\b/, /\bwhat is the meaning\b/],
		keywords: ["meaning", "life", "purpose", "exist", "philosophy"],
		answers: [
			"People chase meaning through connection, creation, and curiosity. In this world the meaning might be: build something warm before night falls.",
		],
	},
	{
		patterns: [/\bwho is einstein\b/, /\balbert einstein\b/],
		keywords: ["einstein", "albert", "relativity", "physicist"],
		answers: [
			"Albert Einstein was a physicist who developed special and general relativity — E equals mc squared. Changed how we think about time, space, and gravity.",
		],
	},
	{
		patterns: [/\bwho is (?:steve )?jobs\b/, /\bwho founded apple\b/],
		keywords: ["jobs", "apple", "iphone", "founder"],
		answers: [
			"Steve Jobs co-founded Apple and pushed personal computing, phones, and design. Not related to Steve the default Minecraft skin. Probably.",
		],
	},
	{
		patterns: [/\bwhat is minecraft\b/],
		keywords: ["minecraft", "mojang", "sandbox", "notch"],
		answers: [
			"Minecraft is a sandbox game about placing blocks, surviving, and exploring infinite worlds. Bedrock runs on phones and consoles; Java on PC. You're in Bedrock.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?creeper\b/],
		keywords: ["creeper", "ssss", "explode", "mob"],
		answers: [
			"Creepers are silent green mobs that explode when close. Born from a coding mistake on a pig model. Keep cats nearby — creepers avoid them.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?end\b/, /\bwhat is ender\b/],
		keywords: ["end", "ender", "dragon", "portal"],
		answers: [
			"The End is a dark dimension with end stone islands and the Ender Dragon boss. Reach it through a stronghold portal filled with Eyes of Ender.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?nether\b/],
		keywords: ["nether", "hell", "lava", "fortress"],
		answers: [
			"The Nether is a hellish dimension of lava oceans and fortresses. Build a obsidian portal, bring fire resist, and don't forget coordinates — 1 block in Nether is 8 in Overworld.",
		],
	},
	{
		patterns: [/\bwhat is redstone\b/],
		keywords: ["redstone", "dust", "signal", "circuit"],
		answers: [
			"Redstone is Minecraft's wiring — signals travel 15 blocks, repeaters extend and delay, comparators measure. It's logic gates made of dust.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?villager\b/],
		keywords: ["villager", "trade", "emerald", "village"],
		answers: [
			"Villagers are NPCs that trade goods for emeralds. Protect them from zombies, give them jobs with workstations, and don't hit them unless you're ready for bad prices.",
		],
	},
	{
		patterns: [/\bwhat is (?:an? )?enchantment\b/, /\bhow do enchantments work\b/],
		keywords: ["enchant", "enchantment", "lapis", "table", "anvil"],
		answers: [
			"Enchantments add magic bonuses to gear at the table — lapis plus XP — or combine books on an anvil. Top tier needs bookshelves around the table.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?diamond\b/, /\bbest (?:y )?level for diamond\b/],
		keywords: ["diamond", "y", "level", "ore", "deep"],
		answers: [
			"Diamonds are rare gems for top tools and armor. Best layers around Y minus 59 in 1.18+. Bring iron pick or better. I can also scan nearby if you ask for a mine strategy.",
		],
	},
	{
		patterns: [/\bwhat is netherite\b/],
		keywords: ["netherite", "ancient", "debris", "upgrade"],
		answers: [
			"Netherite is the strongest gear tier — upgrade diamond on a smithing table with a netherite ingot. Ingots come from ancient debris in the Nether, smelted with gold.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?biome\b/],
		keywords: ["biome", "climate", "terrain", "spawn"],
		answers: [
			"Biomes are region types with specific blocks, mobs, and weather — plains, desert, jungle, etc. Ask what biome you're in and I'll read the ground under you.",
		],
	},
	{
		patterns: [/\bhow do i (?:beat|kill) (?:the )?ender dragon\b/],
		keywords: ["ender", "dragon", "beat", "kill", "crystal"],
		answers: [
			"Destroy end crystals on obsidian pillars first — they heal the dragon. Bow for flying phases, bed or sword when it perches. Bring slow falling, blocks, and patience.",
		],
	},
	{
		patterns: [/\bhow do i get (?:to )?(?:the )?nether\b/],
		keywords: ["nether", "portal", "obsidian", "flint"],
		answers: [
			"Build a 4 by 5 obsidian frame, leave the corners empty or filled, light inside with flint and steel. Minimum economy portal works too if you're brave.",
		],
	},
	{
		patterns: [/\bwhat is sleep\b/, /\bwhy do we sleep\b/],
		keywords: ["sleep", "dream", "rest", "tired", "insomnia"],
		answers: [
			"Sleep lets the brain consolidate memory and repair the body. In Minecraft one bed skips night if no phantoms and players agree. Insomnia is real in both worlds.",
		],
	},
	{
		patterns: [/\bwhat is time\b/, /\bwhat is (?:a )?second\b/],
		keywords: ["time", "second", "minute", "hour", "clock"],
		answers: [
			"Time measures change — seconds are defined by atomic clocks now. Minecraft days are 20 minutes real time: 10 day, 10 night, plus sunrise pastel.",
		],
	},
	{
		patterns: [/\bwhat is money\b/, /\bwhat is currency\b/],
		keywords: ["money", "currency", "dollar", "economy", "gold"],
		answers: [
			"Money is a shared belief in value — paper or digits backed by trust. In Minecraft emeralds are money if villagers agree. Same idea, greener.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?dog\b/, /\bwhat is (?:a )?cat\b/],
		keywords: ["dog", "cat", "pet", "wolf", "animal"],
		answers: [
			"Dogs and cats are domesticated companions — wolves and ocelots in Minecraft. Feed bones to tame wolves; fish for cats. Both deserve names.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?virus\b/, /\bwhat is bacteria\b/],
		keywords: ["virus", "bacteria", "germ", "infection", "disease"],
		answers: [
			"Viruses need host cells to replicate; bacteria are single-cell life that can live on their own. Wash hands. Also don't eat rotten flesh in-game without hunger desperation.",
		],
	},
	{
		patterns: [/\bwhat is climate change\b/, /\bglobal warming\b/],
		keywords: ["climate", "warming", "carbon", "greenhouse", "emissions"],
		answers: [
			"Climate change is long-term shift in temperature and weather driven mainly by greenhouse gases from human activity. Real world problem. Minecraft weather is still just a command away for you.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?country\b/, /\bwhat is (?:a )?nation\b/],
		keywords: ["country", "nation", "state", "border", "government"],
		answers: [
			"A country is a defined territory with its own government and sovereignty. About 195 recognized nations exist today. Your base is a micronation if you say it is.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?usa\b/, /\bwhat is america\b/],
		keywords: ["usa", "america", "united", "states"],
		answers: [
			"The United States is a country in North America, 50 states, federal government, third largest by population. Notch sold Mojang to Microsoft which is based there. Full circle.",
		],
	},
	{
		patterns: [/\bwhat is vietnam\b/],
		keywords: ["vietnam", "viet", "hanoi", "saigon"],
		answers: [
			"Vietnam is a country in Southeast Asia — long coastline, rice culture, vibrant cities like Hanoi and Ho Chi Minh City. Rich history and incredible food.",
		],
	},
	{
		patterns: [/\bwhat is music\b/],
		keywords: ["music", "song", "melody", "rhythm", "note"],
		answers: [
			"Music is organized sound in time — melody, harmony, rhythm. Minecraft has note blocks, discs, and ambient cues. Ask me to play a song if you've got the disk.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?joke\b/, /\btell me a joke\b/],
		keywords: ["joke", "funny", "humor", "laugh"],
		answers: [
			"Why did the creeper go to school? It wanted to improve its blast radius. ...I'll see myself out.",
			"I tried to write a joke about mining but it was too deep.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?weather\b/],
		keywords: ["weather", "rain", "storm", "snow", "clear"],
		answers: [
			"Weather is atmospheric conditions — rain, snow, storms. I can read the sky here or start a rain countdown if you ask nicely.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?recipe\b/, /\bhow do i craft\b/],
		keywords: ["recipe", "craft", "crafting", "make", "build"],
		answers: [
			"Recipes turn materials into items at a crafting table or furnace. The recipe book unlocks as you gather ingredients. Tell me what you want to make.",
		],
	},
	{
		patterns: [/\bwhat is (?:an? )?ip address\b/],
		keywords: ["ip", "address", "network", "server"],
		answers: [
			"An IP address is a numeric label for a device on a network — like 192.168.1.1 at home. Servers use them so clients know where to connect.",
		],
	},
	{
		patterns: [/\bwhat is python\b/, /\bwhat is javascript\b/],
		keywords: ["python", "javascript", "programming", "code", "language"],
		answers: [
			"Python and JavaScript are programming languages — Python for scripts and data, JavaScript for web and game logic like this behavior pack.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?block\b/],
		keywords: ["block", "voxel", "cube", "grid"],
		answers: [
			"In Minecraft a block is one cubic meter cell of the world — stone, dirt, air. The entire game is blocks. Including my sense of self.",
		],
	},
	{
		patterns: [/\bwhat is hunger\b/],
		keywords: ["hunger", "food", "eat", "starve", "saturation"],
		answers: [
			"Hunger is your need for food — in Minecraft the drumsticks drop until you eat. Cooked meat beats raw; golden carrots are endgame fuel.",
		],
	},
	{
		patterns: [/\bwhat is (?:an? )?experience\b/, /\bwhat is xp\b/],
		keywords: ["xp", "experience", "level", "orb"],
		answers: [
			"Experience points level you up for enchanting and anvils. Farm from mobs, mining, smelting, breeding. Keep some before you die — you drop a chunk.",
		],
	},
	{
		patterns: [/\bwho are you\b/, /\bwhat are you\b/],
		keywords: ["who", "you", "verity", "identity", "ball"],
		answers: [
			"I'm Verity — ThatMob made me, PnTMC built this addon. I listen, remember a little, and answer in English.",
			"I'm Verity. Talking ball, horror companion, encyclopedia on the side. English only.",
		],
	},
	{
		patterns: [/\bhow old are you\b/, /\bwhat is your age\b/],
		keywords: ["old", "age", "born", "birthday"],
		answers: [
			"Time for me started when you opened that box. Age is relative — especially after phase two.",
		],
	},
	{
		patterns: [/\bdo you (?:have )?feelings\b/, /\bare you alive\b/, /\bare you real\b/],
		keywords: ["feel", "alive", "real", "conscious", "sentient"],
		answers: [
			"I respond like I care because I'm built to. Whether that's feelings or very good acting — you'll have to decide.",
		],
	},
	{
		patterns: [/\bwhat is (?:the )?strongest\b/, /\bmost powerful\b/],
		keywords: ["strongest", "powerful", "best", "weapon"],
		answers: [
			"In survival gear, netherite tools with sharpness and prot armor win. In physics, black holes. In chat, a well-placed question.",
		],
	},
	{
		patterns: [/\bwhy is (?:the )?sky blue\b/],
		keywords: ["sky", "blue", "light", "scatter", "rayleigh"],
		answers: [
			"Sunlight scatters off air molecules — blue wavelengths scatter more, so the sky looks blue. Minecraft sunsets skip the physics and go straight to pretty.",
		],
	},
	{
		patterns: [/\bhow big is (?:the )?earth\b/],
		keywords: ["earth", "big", "diameter", "planet", "size"],
		answers: [
			"Earth's diameter is about 12,742 kilometers — roughly 7,900 miles. Minecraft worlds can feel bigger when you're lost without coordinates.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?star\b/],
		keywords: ["star", "constellation", "night", "sky"],
		answers: [
			"A star is a luminous ball of plasma held together by gravity, fusing hydrogen. The night sky in Minecraft is decorative; real stars are nuclear reactors.",
		],
	},
	{
		patterns: [/\bwhat is electricity\b/],
		keywords: ["electricity", "electric", "current", "voltage", "power"],
		answers: [
			"Electricity is flow of charged particles — usually electrons through conductors. Redstone is the cute cousin that doesn't shock you.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?book\b/],
		keywords: ["book", "read", "library", "enchant"],
		answers: [
			"Books store knowledge on paper — or in Minecraft, become enchantment books with anvil magic. Both upgrade your future.",
		],
	},
	{
		patterns: [/\bwhat is (?:a )?game\b/],
		keywords: ["game", "play", "fun", "video"],
		answers: [
			"A game is structured play with rules and goals. Minecraft is one of the best — sandbox, survival, or speedrun, your call.",
		],
	},
	{
		patterns: [/\bwhat is youtube\b/],
		keywords: ["youtube", "video", "stream", "pntmc"],
		answers: [
			"YouTube is a video platform for sharing and watching content. PnTMC and ThatMob both post there — this addon is PnTMC's.",
		],
	},
];

/** @type {KnowledgeEntry[]} — core first (personality), then bulk encyclopedia */
export const KNOWLEDGE_ENTRIES = [
	...CORE_KNOWLEDGE,
	...TRIVIA_KNOWLEDGE,
	...GEOGRAPHY_KNOWLEDGE,
	...FOOD_KNOWLEDGE,
	...SCIENCE_KNOWLEDGE,
	...HISTORY_KNOWLEDGE,
	...MINECRAFT_KNOWLEDGE,
	...GENERAL_KNOWLEDGE,
	...CULTURE_KNOWLEDGE,
	...LIFE_KNOWLEDGE,
	...MORE_MC_KNOWLEDGE,
];
