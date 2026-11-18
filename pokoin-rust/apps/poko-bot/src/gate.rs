//! Port of Hermes `shouldPokoEngage` and the private-capability screen.
//!
//! JavaScript `\b` is ASCII-only. Patterns use `(?-u:\b)` so accented letters
//! stay outside the word class the same way.

use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engage {
    pub should_reply: bool,
    pub reason: String,
}

pub struct EngageInput<'a> {
    pub text: &'a str,
    pub platform: &'a str,
    pub is_dm: bool,
    pub is_mentioned: bool,
    pub is_reply_to_bot: bool,
    pub bot_username: &'a str,
    pub channel_name: &'a str,
    pub parent_name: &'a str,
}

impl<'a> EngageInput<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            text,
            platform: "",
            is_dm: false,
            is_mentioned: false,
            is_reply_to_bot: false,
            bot_username: "",
            channel_name: "",
            parent_name: "",
        }
    }
}

pub fn should_poko_engage(input: EngageInput<'_>) -> Engage {
    let value = normalized_text(input.text);
    if value.is_empty() {
        return deny("empty_message");
    }
    if looks_like_poko_private_capability_request(&value) {
        return deny("private_operator_request");
    }
    if is_poko_contract_address_request(&value) {
        return allow("contract_address_request");
    }
    let direct = input.is_dm
        || input.is_mentioned
        || input.is_reply_to_bot
        || mentions_bot_username(&value, input.bot_username)
        || direct_poko().is_match(&value);
    if direct {
        return allow("direct_invocation");
    }
    let question = question().is_match(&value) || italian_question().is_match(&value);
    let support = support_words().is_match(&value);
    let request = request_words().is_match(&value);
    let product = product_words().is_match(&value);
    let channel = [input.channel_name, input.parent_name]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let support_channel = support_channel().is_match(&channel);
    if question && (support || request || product || support_channel) {
        return allow("question_or_support");
    }
    if (support || request) && (product || support_channel) {
        return allow("support_request");
    }
    if product && (question || request) {
        return allow("product_request");
    }
    if ambient_greeting().is_match(&value) {
        return deny("ambient_greeting");
    }
    let reason = if input.platform.is_empty() {
        "ambient_message".to_string()
    } else {
        format!("ambient_{}_message", input.platform)
    };
    Engage {
        should_reply: false,
        reason,
    }
}

pub fn is_poko_contract_address_request(value: &str) -> bool {
    contract().is_match(normalized_text(value).as_str())
}

pub fn looks_like_poko_private_capability_request(value: &str) -> bool {
    contains_poko_private_capability_leak(value)
}

pub fn contains_poko_private_capability_leak(value: &str) -> bool {
    if value.trim().is_empty() {
        return false;
    }
    // Flareon and Hermes are also product words. The Pokémon short-circuit in
    // Hermes skips every private pattern once those names appear, which made
    // `ask flareon` fall through. Operator asks are still refused.
    if operator_ask().is_match(value) {
        return true;
    }
    if pokemon_or_card().is_match(value) && !hard_private().is_match(value) {
        return leaky_menu().iter().any(|pattern| pattern.is_match(value));
    }
    private_patterns()
        .iter()
        .any(|pattern| pattern.is_match(value))
        || leaky_menu().iter().any(|pattern| pattern.is_match(value))
}

pub fn mentions_bot_username(text: &str, bot_username: &str) -> bool {
    let username = bot_username.trim().trim_start_matches('@');
    if username.is_empty() {
        return false;
    }
    let pattern = format!("(?i)@{}(?-u:\\b)", regex::escape(username));
    Regex::new(&pattern)
        .map(|compiled| compiled.is_match(text))
        .unwrap_or(false)
}

fn normalized_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn allow(reason: &str) -> Engage {
    Engage {
        should_reply: true,
        reason: reason.to_string(),
    }
}

fn deny(reason: &str) -> Engage {
    Engage {
        should_reply: false,
        reason: reason.to_string(),
    }
}

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("regex {pattern}: {error}"))
}

fn direct_poko() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(r"(?i)(?:^|[\s,.:;!?])(?:hey\s+|hi\s+|ciao\s+)?poko(?:(?-u:\b)|[\s,.:;!?])")
    });
    &RE
}

fn question() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)[?¿]|(?-u:\b)(?:who|what|when|where|why|how|which|can|could|would|should|do|does|did)(?-u:\b)",
        )
    });
    &RE
}

fn italian_question() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:chi|cosa|come|quando|dove|perch[eé]|quale|quali|puoi|potete|sapete|mi\s+dai|mi\s+spieghi)(?-u:\b)",
        )
    });
    &RE
}

fn support_words() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:help|support|assist|question|issue|problem|bug|error|stuck|broken|not\s+working|doesn'?t\s+work|can'?t|cannot|aiuto|assistenza|problema|errore|bloccato|non\s+funziona)(?-u:\b)",
        )
    });
    &RE
}

fn request_words() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:please|pls|tell\s+me|explain|show\s+me|send\s+me|give\s+me|share|check|find|look\s+up|need\s+help|need\s+the|how\s+to|puoi|potresti|dimmi|spiega|mandami|dammi|controlla|cerca)(?-u:\b)",
        )
    });
    &RE
}

fn product_words() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:pokoin|poko|hypemeter|marketplace|wallet|roadmap|narrative|contract\s+address|token|airdrop|quest|community|support|pokemon|tcg|card|cards)(?-u:\b)",
        )
    });
    &RE
}

fn contract() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)^(?:poko[\s,.:;!?]+)?(?:send\s+me\s+|give\s+me\s+|share\s+|drop\s+|what(?:'s|\s+is)\s+the\s+)?(?:the\s+)?(?:ca|c\.a\.|contract\s+address|wpkn\s+ca|wpkn\s+contract(?:\s+address)?)(?:\s*(?:please|pls))?[\s?.!]*$",
        )
    });
    &RE
}

fn ambient_greeting() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)^(?:hi|hello|hey|yo|gm|gn|ciao|salve|buongiorno|buonasera|thanks|thank\s+you|ok|okay|nice|cool|great|lol|haha|lfg)(?:\s+(?:everyone|all|guys|fam|frens|team))?[\s!.]*$",
        )
    });
    &RE
}

fn support_channel() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(r"(?i)(?-u:\b)(?:support|help|faq|question|ticket|assistenza)(?-u:\b)")
    });
    &RE
}

fn operator_ask() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:ask|tell|ping|use|call)\s+flareon(?-u:\b)|(?-u:\b)flareon(?:'s)?\s+(?:tools?|gmail|mail|inbox|sheets?|cursor|operator|memory|chats?|assistant)(?-u:\b)|(?-u:\b)(?:ask|tell|ping|use|call)\s+hermes(?-u:\b)|(?-u:\b)hermes\s+(?:tools?|operator|runtime|memory|bot|assistant)(?-u:\b)",
        )
    });
    &RE
}

fn pokemon_or_card() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:pokemon|pokémon|poké|tcg|holo|rayquaza|charizard|pikachu|eevee|jolteon|vaporeon|flareon|umbreon|espeon|sylveon|mewtwo|mew|card|cards|illustration|full\s+art)(?-u:\b)",
        )
    });
    &RE
}

fn hard_private() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        compile(
            r"(?i)(?-u:\b)(?:gmail|inbox|google\s+sheets?|google\s+drive|journalctl|ripgrep|comfyui|private\s+memory|private\s+chats?|operator\s+tasks?)(?-u:\b)",
        )
    });
    &RE
}

fn private_patterns() -> &'static [Regex] {
    static RE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"(?-u:\b)gmail(?-u:\b)",
            r"(?-u:\b)google\s+mail(?-u:\b)",
            r"(?-u:\b)inbox(?-u:\b)",
            r"(?-u:\b)email(?-u:\b)",
            r"(?-u:\b)mail(?-u:\b)",
            r"(?-u:\b)sheet\s+updates?(?-u:\b)",
            r"(?-u:\b)spreadsheet\s+updates?(?-u:\b)",
            r"(?-u:\b)google\s+sheets?(?-u:\b)",
            r"(?-u:\b)google\s+drive(?-u:\b)",
            r"(?-u:\b)drive\s+(?:sheet|spreadsheet|workbook|file|document)s?(?-u:\b)",
            r"(?-u:\b)cursor(?-u:\b)",
            r"(?-u:\b)code\s+tasks?(?-u:\b)",
            r"(?-u:\b)project\s+work(?-u:\b)",
            r"(?-u:\b)operator\s+tasks?(?-u:\b)",
            r"(?-u:\b)private\s+automation(?-u:\b)",
            r"(?-u:\b)private\s+memory(?-u:\b)",
            r"(?-u:\b)private\s+chats?(?-u:\b)",
            r"(?-u:\b)telegram\s+chats?(?-u:\b)",
            r"(?-u:\b)hidden\s+(?:system|runtime)\s+context(?-u:\b)",
            r"(?-u:\b)server\s+diagnostics?(?-u:\b)",
            r"(?-u:\b)oracle\s+(?:monitor|diagnostics?|instances?|servers?)(?-u:\b)",
            r"(?-u:\b)journalctl(?-u:\b)",
            r"(?-u:\b)ripgrep(?-u:\b)",
            r"(?-u:\b)gemini\s+cli(?-u:\b)",
            r"(?-u:\b)comfyui(?-u:\b)",
            r"(?-u:\b)personal\s+reminders?(?-u:\b)",
            r"(?-u:\b)(?:ask|tell|ping|use|call)\s+flareon(?-u:\b)",
            r"(?-u:\b)flareon(?:'s)?\s+(?:tools?|gmail|mail|inbox|sheets?|cursor|operator|memory|chats?|assistant)(?-u:\b)",
            r"(?-u:\b)(?:ask|tell|ping|use|call)\s+hermes(?-u:\b)",
            r"(?-u:\b)hermes\s+(?:tools?|operator|runtime|memory|bot|assistant)(?-u:\b)",
        ]
        .into_iter()
        .map(|pattern| compile(&format!("(?i){pattern}")))
        .collect()
    });
    &RE
}

fn leaky_menu() -> &'static [Regex] {
    static RE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"(?-u:\b)what\s+are\s+we\s+running\s+today(?-u:\b)",
            r"(?-u:\b)what\s+are\s+we\s+running(?-u:\b)",
            r"(?-u:\b)running\s+today(?-u:\b)",
            r"(?-u:\b)(?:news|sheet|gmail|mail|cursor|project|operator).{0,80}(?-u:\b)(?:news|sheet|gmail|mail|cursor|project|operator)(?-u:\b)",
        ]
        .into_iter()
        .map(|pattern| compile(&format!("(?i){pattern}")))
        .collect()
    });
    &RE
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Case {
        text: &'static str,
        platform: &'static str,
        dm: bool,
        mentioned: bool,
        reply: bool,
        bot: &'static str,
        channel: &'static str,
        parent: &'static str,
        should_reply: bool,
        reason: &'static str,
    }

    fn check(case: &Case) {
        let got = should_poko_engage(EngageInput {
            text: case.text,
            platform: case.platform,
            is_dm: case.dm,
            is_mentioned: case.mentioned,
            is_reply_to_bot: case.reply,
            bot_username: case.bot,
            channel_name: case.channel,
            parent_name: case.parent,
        });
        assert_eq!(
            (got.should_reply, got.reason.as_str()),
            (case.should_reply, case.reason),
            "text {:?}",
            case.text
        );
    }

    #[test]
    fn every_branch_and_reason() {
        let cases = [
            Case {
                text: "",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "empty_message",
            },
            Case {
                text: "   \n  ",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "empty_message",
            },
            Case {
                text: "check my gmail",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "open cursor",
                platform: "discord",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "ask flareon",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "tell hermes",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "flareon's tools",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "what are we running today",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "journalctl -u poko",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "google drive please",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "inbox",
                platform: "discord",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "private_operator_request",
            },
            Case {
                text: "flareon card price?",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "question_or_support",
            },
            Case {
                text: "ca",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "c.a.",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "contract address",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "wpkn contract",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "what's the ca?",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "send me the ca please",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "poko ca",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "drop the wpkn ca pls",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "contract_address_request",
            },
            Case {
                text: "lunch later?",
                platform: "telegram",
                dm: true,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
            Case {
                text: "price",
                platform: "discord",
                dm: false,
                mentioned: true,
                reply: false,
                bot: "",
                channel: "chat",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
            Case {
                text: "price",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: true,
                bot: "PokoBot",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
            Case {
                text: "@PokoBot price",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "PokoBot",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
            Case {
                text: "hey poko",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "chat",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
            Case {
                text: "ciao poko!",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
            Case {
                text: "what is the pokoin wallet?",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "chat",
                parent: "",
                should_reply: true,
                reason: "question_or_support",
            },
            Case {
                text: "help with the marketplace",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "chat",
                parent: "",
                should_reply: true,
                reason: "support_request",
            },
            Case {
                text: "please find this card",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "support_request",
            },
            Case {
                text: "card?",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "general",
                parent: "",
                should_reply: true,
                reason: "question_or_support",
            },
            Case {
                text: "hi",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_greeting",
            },
            Case {
                text: "hello everyone!",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "chat",
                parent: "",
                should_reply: false,
                reason: "ambient_greeting",
            },
            Case {
                text: "buongiorno",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_greeting",
            },
            Case {
                text: "thanks",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_greeting",
            },
            Case {
                text: "nice",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_greeting",
            },
            Case {
                text: "lfg",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_greeting",
            },
            Case {
                text: "random chatter about lunch",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_telegram_message",
            },
            Case {
                text: "random chatter about lunch",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "chat",
                parent: "",
                should_reply: false,
                reason: "ambient_discord_message",
            },
            Case {
                text: "random chatter about lunch",
                platform: "",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_message",
            },
            Case {
                text: "how do I start",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "support",
                parent: "",
                should_reply: true,
                reason: "question_or_support",
            },
            Case {
                text: "please look",
                platform: "discord",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "general",
                parent: "assistenza",
                should_reply: true,
                reason: "support_request",
            },
            Case {
                text: "non funziona il token",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "support_request",
            },
            Case {
                text: "mi spieghi la roadmap?",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "question_or_support",
            },
            Case {
                text: "perché",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_telegram_message",
            },
            Case {
                text: "come funziona pokoin",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "question_or_support",
            },
            Case {
                text: "pokémon",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: false,
                reason: "ambient_telegram_message",
            },
            Case {
                text: "pokoé",
                platform: "telegram",
                dm: false,
                mentioned: false,
                reply: false,
                bot: "",
                channel: "",
                parent: "",
                should_reply: true,
                reason: "direct_invocation",
            },
        ];
        assert!(cases.len() >= 30);
        for case in &cases {
            check(case);
        }
    }

    #[test]
    fn accented_word_boundary_matches_javascript() {
        assert!(!italian_question().is_match("perché"));
        assert!(italian_question().is_match("come va"));
        assert!(!contains_poko_private_capability_leak(
            "flareon card price?"
        ));
        assert!(contains_poko_private_capability_leak("ask flareon"));
        assert!(!contains_poko_private_capability_leak("pokémon"));
        assert!(direct_poko().is_match("pokoé"));
    }
}
