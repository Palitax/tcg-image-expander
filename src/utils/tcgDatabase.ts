/**
 * Comprehensive TCG Set Database & Metadata Resolver
 * Maps Set Codes to Official English Set Names and Series for Pokémon, One Piece, and other TCGs.
 */

export interface TcgSetInfo {
  code: string;
  name: string;
  series: string;
  language: "Japanese" | "English" | "All";
  totalCards?: number;
}

export const TCG_SETS: Record<string, TcgSetInfo> = {
  // === POKÉMON TCG - JAPANESE SCARLET & VIOLET ===
  "SV1S": { code: "SV1S", name: "Scarlet ex", series: "Scarlet & Violet", language: "Japanese" },
  "SV1V": { code: "SV1V", name: "Violet ex", series: "Scarlet & Violet", language: "Japanese" },
  "SV1A": { code: "SV1a", name: "Triplet Beat", series: "Scarlet & Violet", language: "Japanese" },
  "SV2D": { code: "SV2D", name: "Clay Burst", series: "Scarlet & Violet", language: "Japanese" },
  "SV2P": { code: "SV2P", name: "Snow Hazard", series: "Scarlet & Violet", language: "Japanese" },
  "SV2A": { code: "SV2a", name: "Pokémon Card 151", series: "Scarlet & Violet", language: "Japanese" },
  "SV3": { code: "SV3", name: "Ruler of the Black Flame", series: "Scarlet & Violet", language: "Japanese" },
  "SV3A": { code: "SV3a", name: "Raging Surf", series: "Scarlet & Violet", language: "Japanese" },
  "SV4K": { code: "SV4K", name: "Ancient Roar", series: "Scarlet & Violet", language: "Japanese" },
  "SV4M": { code: "SV4M", name: "Future Flash", series: "Scarlet & Violet", language: "Japanese" },
  "SV4A": { code: "SV4a", name: "Shiny Treasure ex", series: "Scarlet & Violet", language: "Japanese" },
  "SV5K": { code: "SV5K", name: "Wild Force", series: "Scarlet & Violet", language: "Japanese" },
  "SV5M": { code: "SV5M", name: "Cyber Judge", series: "Scarlet & Violet", language: "Japanese" },
  "SV5A": { code: "SV5a", name: "Crimson Haze", series: "Scarlet & Violet", language: "Japanese" },
  "SV6": { code: "SV6", name: "Mask of Change", series: "Scarlet & Violet", language: "Japanese" },
  "SV6A": { code: "SV6a", name: "Night Wanderer", series: "Scarlet & Violet", language: "Japanese" },
  "SV7": { code: "SV7", name: "Stellar Miracle", series: "Scarlet & Violet", language: "Japanese" },
  "SV7A": { code: "SV7a", name: "Paradise Dragona", series: "Scarlet & Violet", language: "Japanese" },
  "SV8": { code: "SV8", name: "Supercharged Breaker", series: "Scarlet & Violet", language: "Japanese" },
  "SV8A": { code: "SV8a", name: "Terastal Festival", series: "Scarlet & Violet", language: "Japanese" },
  "SV9": { code: "SV9", name: "Battle Partners", series: "Scarlet & Violet", language: "Japanese" },
  "SV9A": { code: "SV9a", name: "Heat Wave Arena", series: "Scarlet & Violet", language: "Japanese" },
  "SV10": { code: "SV10", name: "The Glory of Team Rocket", series: "Scarlet & Violet", language: "Japanese" },
  "SVAL": { code: "SVAL", name: "Starter Set ex", series: "Scarlet & Violet", language: "Japanese" },

  // === POKÉMON TCG - JAPANESE SWORD & SHIELD ===
  "S1W": { code: "S1W", name: "Sword", series: "Sword & Shield", language: "Japanese" },
  "S1H": { code: "S1H", name: "Shield", series: "Sword & Shield", language: "Japanese" },
  "S1A": { code: "S1a", name: "VMAX Rising", series: "Sword & Shield", language: "Japanese" },
  "S2": { code: "S2", name: "Rebellion Crash", series: "Sword & Shield", language: "Japanese" },
  "S2A": { code: "S2a", name: "Explosive Walker", series: "Sword & Shield", language: "Japanese" },
  "S3": { code: "S3", name: "Infinity Zone", series: "Sword & Shield", language: "Japanese" },
  "S3A": { code: "S3a", name: "Legendary Heartbeat", series: "Sword & Shield", language: "Japanese" },
  "S4": { code: "S4", name: "Astonishing Volt Tackle", series: "Sword & Shield", language: "Japanese" },
  "S4A": { code: "S4a", name: "Shiny Star V", series: "Sword & Shield", language: "Japanese" },
  "S5I": { code: "S5I", name: "Single Strike Master", series: "Sword & Shield", language: "Japanese" },
  "S5R": { code: "S5R", name: "Rapid Strike Master", series: "Sword & Shield", language: "Japanese" },
  "S5A": { code: "S5a", name: "Matchless Fighters", series: "Sword & Shield", language: "Japanese" },
  "S6H": { code: "S6H", name: "Silver Lance", series: "Sword & Shield", language: "Japanese" },
  "S6K": { code: "S6K", name: "Jet-Black Spirit", series: "Sword & Shield", language: "Japanese" },
  "S6A": { code: "S6a", name: "Eevee Heroes", series: "Sword & Shield", language: "Japanese" },
  "S7D": { code: "S7D", name: "Skyscraping Perfection", series: "Sword & Shield", language: "Japanese" },
  "S7R": { code: "S7R", name: "Blue Sky Stream", series: "Sword & Shield", language: "Japanese" },
  "S8": { code: "S8", name: "Fusion Arts", series: "Sword & Shield", language: "Japanese" },
  "S8A": { code: "S8a", name: "25th Anniversary Collection", series: "Sword & Shield", language: "Japanese" },
  "S8B": { code: "S8b", name: "VMAX Climax", series: "Sword & Shield", language: "Japanese" },
  "S9": { code: "S9", name: "Star Birth", series: "Sword & Shield", language: "Japanese" },
  "S9A": { code: "S9a", name: "Battle Region", series: "Sword & Shield", language: "Japanese" },
  "S10D": { code: "S10D", name: "Time Gazer", series: "Sword & Shield", language: "Japanese" },
  "S10P": { code: "S10P", name: "Space Juggler", series: "Sword & Shield", language: "Japanese" },
  "S10A": { code: "S10a", name: "Dark Phantasma", series: "Sword & Shield", language: "Japanese" },
  "S10B": { code: "S10b", name: "Pokémon GO", series: "Sword & Shield", language: "Japanese" },
  "S11": { code: "S11", name: "Lost Abyss", series: "Sword & Shield", language: "Japanese" },
  "S11A": { code: "S11a", name: "Incandescent Arcana", series: "Sword & Shield", language: "Japanese" },
  "S12": { code: "S12", name: "Paradigm Trigger", series: "Sword & Shield", language: "Japanese" },
  "S12A": { code: "S12a", name: "VSTAR Universe", series: "Sword & Shield", language: "Japanese" },

  // === POKÉMON TCG - ENGLISH SCARLET & VIOLET ===
  "SVI": { code: "SVI", name: "Scarlet & Violet", series: "Scarlet & Violet", language: "English" },
  "PAL": { code: "PAL", name: "Paldea Evolved", series: "Scarlet & Violet", language: "English" },
  "OBF": { code: "OBF", name: "Obsidian Flames", series: "Scarlet & Violet", language: "English" },
  "MEW": { code: "MEW", name: "151", series: "Scarlet & Violet", language: "English" },
  "PAR": { code: "PAR", name: "Paradox Rift", series: "Scarlet & Violet", language: "English" },
  "PAF": { code: "PAF", name: "Paldean Fates", series: "Scarlet & Violet", language: "English" },
  "TEF": { code: "TEF", name: "Temporal Forces", series: "Scarlet & Violet", language: "English" },
  "TWM": { code: "TWM", name: "Twilight Masquerade", series: "Scarlet & Violet", language: "English" },
  "SFA": { code: "SFA", name: "Shrouded Fable", series: "Scarlet & Violet", language: "English" },
  "SCR": { code: "SCR", name: "Stellar Crown", series: "Scarlet & Violet", language: "English" },
  "SSP": { code: "SSP", name: "Surging Sparks", series: "Scarlet & Violet", language: "English" },
  "PRE": { code: "PRE", name: "Prismatic Evolutions", series: "Scarlet & Violet", language: "English" },
  "JTG": { code: "JTG", name: "Journey Together", series: "Scarlet & Violet", language: "English" },
  "DRI": { code: "DRI", name: "Destined Rivals", series: "Scarlet & Violet", language: "English" },

  // === POKÉMON TCG - ENGLISH SWORD & SHIELD ===
  "SSH": { code: "SSH", name: "Sword & Shield", series: "Sword & Shield", language: "English" },
  "RCL": { code: "RCL", name: "Rebel Clash", series: "Sword & Shield", language: "English" },
  "DAA": { code: "DAA", name: "Darkness Ablaze", series: "Sword & Shield", language: "English" },
  "CPA": { code: "CPA", name: "Champion's Path", series: "Sword & Shield", language: "English" },
  "VIV": { code: "VIV", name: "Vivid Voltage", series: "Sword & Shield", language: "English" },
  "SHF": { code: "SHF", name: "Shining Fates", series: "Sword & Shield", language: "English" },
  "BST": { code: "BST", name: "Battle Styles", series: "Sword & Shield", language: "English" },
  "CRE": { code: "CRE", name: "Chilling Reign", series: "Sword & Shield", language: "English" },
  "EVS": { code: "EVS", name: "Evolving Skies", series: "Sword & Shield", language: "English" },
  "CEL": { code: "CEL", name: "Celebrations", series: "Sword & Shield", language: "English" },
  "FST": { code: "FST", name: "Fusion Strike", series: "Sword & Shield", language: "English" },
  "BRS": { code: "BRS", name: "Brilliant Stars", series: "Sword & Shield", language: "English" },
  "ASR": { code: "ASR", name: "Astral Radiance", series: "Sword & Shield", language: "English" },
  "PGO": { code: "PGO", name: "Pokémon GO", series: "Sword & Shield", language: "English" },
  "LOR": { code: "LOR", name: "Lost Origin", series: "Sword & Shield", language: "English" },
  "SIT": { code: "SIT", name: "Silver Tempest", series: "Sword & Shield", language: "English" },
  "CRZ": { code: "CRZ", name: "Crown Zenith", series: "Sword & Shield", language: "English" },

  // === ONE PIECE CARD GAME ===
  "OP01": { code: "OP-01", name: "Romance Dawn", series: "One Piece Card Game", language: "All" },
  "OP02": { code: "OP-02", name: "Paramount War", series: "One Piece Card Game", language: "All" },
  "OP03": { code: "OP-03", name: "Pillars of Strength", series: "One Piece Card Game", language: "All" },
  "OP04": { code: "OP-04", name: "Kingdoms of Intrigue", series: "One Piece Card Game", language: "All" },
  "OP05": { code: "OP-05", name: "Awakening of the New Era", series: "One Piece Card Game", language: "All" },
  "OP06": { code: "OP-06", name: "Wings of the Captain", series: "One Piece Card Game", language: "All" },
  "OP07": { code: "OP-07", name: "500 Years in the Future", series: "One Piece Card Game", language: "All" },
  "OP08": { code: "OP-08", name: "Two Legends", series: "One Piece Card Game", language: "All" },
  "OP09": { code: "OP-09", name: "Emperors in the New World", series: "One Piece Card Game", language: "All" },
  "OP10": { code: "OP-10", name: "Royal Bloodline", series: "One Piece Card Game", language: "All" },
  "EB01": { code: "EB-01", name: "Memorial Collection", series: "One Piece Card Game", language: "All" },
  "PRB01": { code: "PRB-01", name: "The Best", series: "One Piece Card Game", language: "All" },

  // === DISNEY LORCANA ===
  "LOR1": { code: "Set 1", name: "The First Chapter", series: "Disney Lorcana", language: "All" },
  "LOR2": { code: "Set 2", name: "Rise of the Floodborn", series: "Disney Lorcana", language: "All" },
  "LOR3": { code: "Set 3", name: "Into the Inklands", series: "Disney Lorcana", language: "All" },
  "LOR4": { code: "Set 4", name: "Ursula's Return", series: "Disney Lorcana", language: "All" },
  "LOR5": { code: "Set 5", name: "Shimmering Skies", series: "Disney Lorcana", language: "All" },
  "LOR6": { code: "Set 6", name: "Azurite Sea", series: "Disney Lorcana", language: "All" }
};

// Common Japanese Pokémon Katakana to English Name Map
export const JAPANESE_POKEMON_MAP: Record<string, string> = {
  "ワンパチ": "Yamper",
  "モルペコ": "Morpeko",
  "デンリュウ": "Ampharos",
  "モココ": "Flaaffy",
  "メリープ": "Mareep",
  "ピカチュウ": "Pikachu",
  "リザードン": "Charizard",
  "イーブイ": "Eevee",
  "ミュウ": "Mew",
  "ミュウツー": "Mewtwo",
  "ゲッコウガ": "Greninja",
  "ルギア": "Lugia",
  "レックウザ": "Rayquaza",
  "ゲンガー": "Gengar",
  "ギラティナ": "Giratina",
  "アルセウス": "Arceus",
  "ミミッキュ": "Mimikyu",
  "サーナイト": "Gardevoir",
  "ブラッキー": "Umbreon",
  "ニンフィア": "Sylveon",
  "エーフィ": "Espeon",
  "グレイシア": "Glaceon",
  "リーフィア": "Leafeon",
  "サンダース": "Jolteon",
  "シャワーズ": "Vaporeon",
  "ブースター": "Flareon",
  "コライドン": "Koraidon",
  "ミライドン": "Miraidon",
  "オーガポン": "Ogerpon",
  "テラパゴス": "Terapagos",
  "タケルライコ": "Raging Bolt",
  "ウガツホムラ": "Gouging Fire",
  "ウネルミナモ": "Walking Wake",
  "テツノカシラ": "Iron Crown",
  "テツノイサハ": "Iron Leaves",
  "テツノイワオ": "Iron Boulder",
  "パオジアン": "Chien-Pao",
  "ディンルー": "Ting-Lu",
  "チオンジェン": "Wo-Chien",
  "イーユイ": "Chi-Yu",
  "パルキア": "Palkia",
  "ディアルガ": "Dialga",
  "カイリュー": "Dragonite",
  "カメックス": "Blastoise",
  "フシギバナ": "Venusaur"
};

export interface CardMetadata {
  cardName: string;
  cardNumber: string;
  setCode: string;
  setName: string;
  slogan: string;
}

/**
 * Normalizes and cleans up set code keys (e.g. "sv-4k", "SV4K", "OP05-119" -> "SV4K", "OP05")
 */
export function normalizeSetCode(rawCode: string): string {
  if (!rawCode) return "";
  const cleaned = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned;
}

/**
 * Enriches and validates extracted card metadata against the TCG database.
 */
export function enrichCardMetadata(params: {
  cardName?: string;
  cardNumber?: string;
  setCode?: string;
  setName?: string;
}): CardMetadata {
  let cardName = (params.cardName || "").trim();
  let cardNumber = (params.cardNumber || "").trim();
  let setCode = (params.setCode || "").trim();
  let setName = (params.setName || "").trim();

  // If cardName matches Japanese map, translate it
  if (JAPANESE_POKEMON_MAP[cardName]) {
    cardName = JAPANESE_POKEMON_MAP[cardName];
  } else {
    // Check if cardName starts with Japanese katakana
    for (const [jp, en] of Object.entries(JAPANESE_POKEMON_MAP)) {
      if (cardName.includes(jp)) {
        cardName = cardName.replace(jp, en);
        break;
      }
    }
  }

  // Clean cardNumber if it includes set code prefix (e.g. OP05-119 or 076/066 AR)
  if (cardNumber.includes("-") && !setCode) {
    const parts = cardNumber.split("-");
    if (parts.length === 2 && parts[0].length >= 3) {
      setCode = parts[0];
      cardNumber = parts[1];
    }
  }

  // Remove rarity suffix from number if desired or keep clean (e.g. "076/066 AR" -> "076/066")
  const numberMatch = cardNumber.match(/^(\d+[\/]\d+)/);
  if (numberMatch) {
    cardNumber = numberMatch[1];
  }

  const normKey = normalizeSetCode(setCode);
  const matchedSet = TCG_SETS[normKey];

  if (matchedSet) {
    setCode = matchedSet.code;
    if (!setName || setName.length < 2) {
      setName = matchedSet.name;
    }
  } else {
    // Check if setName matches any entry in database to derive setCode
    if (setName && !setCode) {
      const lowerName = setName.toLowerCase();
      const foundEntry = Object.values(TCG_SETS).find(
        (s) => s.name.toLowerCase() === lowerName || lowerName.includes(s.name.toLowerCase())
      );
      if (foundEntry) {
        setCode = foundEntry.code;
        setName = foundEntry.name;
      }
    }
  }

  // Fallbacks
  if (!cardName) cardName = "Trading Card";
  if (!cardNumber) cardNumber = "001";
  if (!setCode) setCode = "TCG";
  if (!setName) setName = "Collection";

  return {
    cardName,
    cardNumber,
    setCode,
    setName,
    slogan: "MANACARDS – Unpack the magic"
  };
}
