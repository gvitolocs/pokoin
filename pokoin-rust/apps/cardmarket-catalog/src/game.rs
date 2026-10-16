//! Per-game configuration: Cardmarket idGame, TCGplayer category and the
//! Cardmarket expansion → Pokoin set table.
//!
//! Cardmarket's public product list has no expansion names, so the table is
//! fixed by hand from the card names each idExpansion holds and the sealed
//! products (`products_nonsingles_<idGame>.json`) filed under it.

/// What one Cardmarket expansion is in the Pokoin catalog.
#[derive(Debug, Clone, Copy)]
pub enum Expansion {
    /// A set the official catalog already has (`expansion->>'name'`). Its cards
    /// carry TCGplayer numbers in `tcg_groups`; `numbers` limits those rows to
    /// a collector prefix (the PR- promos sit in two promo groups).
    Set {
        name: &'static str,
        tcg_groups: &'static [i64],
        numbers: &'static str,
    },
    /// Event, judge, tournament and prerelease printings the official site does
    /// not list. Each becomes a Pokoin set of its own; TCGplayer rows belong to
    /// it when their pack tag names one of its sealed products, or when they sit
    /// in one of `tcg_groups` (prerelease groups carry no tag), or when the tag
    /// is one of `aliases` (TCGplayer's own name for a pack).
    Promo {
        name: &'static str,
        code: &'static str,
        tcg_groups: &'static [i64],
        aliases: &'static [&'static str],
    },
}

#[derive(Debug, Clone, Copy)]
pub struct Game {
    /// Pokoin game slug: database `pokoin_<slug>`, schema `marketplace_<slug>`.
    pub slug: &'static str,
    pub cardmarket_game: i64,
    pub tcgplayer_category: i64,
    pub expansions: &'static [(i64, Expansion)],
    /// Official-site promo scans (`<number>_p`) and the TCGplayer pack tag they
    /// show: a promo number is printed in several packs, so these pair only by
    /// pin.
    pub promo_pins: &'static [(&'static str, &'static str)],
}

impl Game {
    pub fn database(&self) -> String {
        format!("pokoin_{}", self.slug)
    }

    pub fn schema(&self) -> String {
        format!("marketplace_{}", self.slug)
    }

    pub fn expansion(&self, id: i64) -> Option<&'static Expansion> {
        self.expansions
            .iter()
            .find(|(e, _)| *e == id)
            .map(|(_, x)| x)
    }
}

const fn set(name: &'static str, tcg_groups: &'static [i64]) -> Expansion {
    Expansion::Set {
        name,
        tcg_groups,
        numbers: "",
    }
}

/// Battle Spirits Saga: Cardmarket idGame 20, TCGplayer category 72. Our set
/// names are the official site's (`_bss_set_name`, title case).
pub const BATTLE_SPIRITS_SAGA: Game = Game {
    slug: "battle_spirits_saga",
    cardmarket_game: 20,
    tcgplayer_category: 72,
    // All three sit on the BSS01/BSS02 booster pages next to that pack's promos.
    promo_pins: &[
        ("BSS01-103_p", "Tamagotchi"),
        ("ST04-016_p", "Tamagotchi"),
        ("BSS02-005_p1", "X Rare Special Pack Vol. 2"),
    ],
    expansions: &[
        (5439, set("Dawn Of History", &[23045])),
        (5467, set("False Gods", &[23194])),
        (5500, set("Aquatic Invaders", &[23283])),
        (5581, set("Savior Of Chaos", &[23285])),
        (5829, set("Strangers In The Sky", &[23546])),
        (5910, set("Generational Link", &[23774])),
        (5734, set("Halo Of Awakening", &[23396])),
        (5455, set("Elemental Spark", &[23162])),
        (5498, set("Ancient Heroes", &[23184])),
        (5445, set("Dragon Onslaught", &[23046])),
        (5452, set("Call Of The Curse", &[23047])),
        (5453, set("Aegis Of The Machine", &[23048])),
        (5454, set("Forbidden Magic", &[23049])),
        (5459, set("Verdant Wings", &[23129])),
        (5499, set("Bodies Of Steel", &[23239])),
        // Starter deck + its "Destined Assault Promotion Pack" (ST07-004/008 P).
        (5733, set("Destined Assault", &[23397])),
        // Tournament Packs and Store Tournament & Sealed Deck Packs: the
        // official PR-001… promo numbers.
        (
            5456,
            Expansion::Set {
                name: "Promotion Card",
                tcg_groups: &[23094, 23057],
                numbers: "PR-",
            },
        ),
        // Half Deck, All Foil Deck, Premium Card Collection -Summoner's Best-.
        (
            5458,
            Expansion::Promo {
                name: "Special Decks & Collections",
                code: "SDC",
                tcg_groups: &[],
                aliases: &["Silver Foil"],
            },
        ),
        (
            5461,
            Expansion::Promo {
                name: "Judge Packs",
                code: "JUDGE",
                tcg_groups: &[],
                aliases: &[],
            },
        ),
        (
            5462,
            Expansion::Promo {
                name: "Promotion Packs",
                code: "PP",
                tcg_groups: &[],
                aliases: &[],
            },
        ),
        // Event Packs, Finalist / Champion sets, X Rare Special Packs,
        // Championship and World Championship packs of 2023.
        (
            5464,
            Expansion::Promo {
                name: "Event Packs 2023",
                code: "EV23",
                tcg_groups: &[],
                aliases: &[],
            },
        ),
        // Savior of Chaos pre-release pack + Evangelion collaboration rares.
        (
            5646,
            Expansion::Promo {
                name: "Savior Of Chaos Promos",
                code: "BSS04-P",
                tcg_groups: &[23466],
                aliases: &[],
            },
        ),
        // Event Packs, Finalist sets, Pro Fest and Nexus packs of 2024.
        (
            5704,
            Expansion::Promo {
                name: "Event Packs 2024",
                code: "EV24",
                tcg_groups: &[],
                aliases: &[],
            },
        ),
        // Halo of Awakening pre-release + promotion packs.
        (
            5793,
            Expansion::Promo {
                name: "Halo Of Awakening Promos",
                code: "CB01-P",
                tcg_groups: &[23574],
                aliases: &[],
            },
        ),
    ],
};

pub fn by_slug(slug: &str) -> Option<Game> {
    match slug {
        "battle_spirits_saga" | "bss" | "battle_spirits" => Some(BATTLE_SPIRITS_SAGA),
        _ => None,
    }
}
