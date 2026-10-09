//! Intent detection and deterministic replies of `pokoin-assistant.js`:
//! `classifyIntent`, the `looksLike*` family, `navigationReply`,
//! `unsafeCyberReply`, greeting/casual/project/crypto/earn/general replies,
//! card-suggestion themes, explicit card subjects, marketplace intents,
//! recommendation/deck-advisor intents, user preferences and the
//! conversation-continuity clarification.

use serde_json::{json, Map, Value};

use crate::assistant::context::{
    clean_page_context, marketplace_language_from_page, page_url_from_context,
};
use crate::assistant::text::{
    clean_text, clean_text_str, levenshtein_distance, normalize_intent_text, re, unique_limited,
};

pub(crate) const WB: &str = "(?-u:\\b)";

#[allow(dead_code)]
fn wb_unused() {
    let _ = WB;
}

fn test(pattern: &'static str, text: &str) -> bool {
    re(pattern).is_match(text)
}

fn find<'t>(pattern: &'static str, text: &'t str) -> Option<regex::Captures<'t>> {
    re(pattern).captures(text)
}

fn replace_all(pattern: &'static str, text: &str, with: &str) -> String {
    re(pattern).replace_all(text, with).into_owned()
}

/// `classifyIntent`.
pub fn classify_intent(message: &str) -> &'static str {
    let text = normalize_intent_text(message);
    if looks_like_dangerous_cyber_request(&text) {
        return "unsafe-cyber";
    }
    if looks_like_casual_conversation(&text) {
        return "casual";
    }
    if looks_like_navigation_request(&text) {
        return "navigation";
    }
    if test(
        concat!(
            "^(hi|hello|hey|ciao|salve|buongiorno|buonasera|yo|hola|bonjour|salut|hallo|",
            "guten tag|ola|olá|bom dia)[!.\\s]*$"
        ),
        text.trim(),
    ) {
        return "greeting";
    }
    if test(
        concat!(
            "(?-u:\\b)(bug|broken|error|issue|problem|crash|stuck|failed|not working|",
            "doesn't work|doesnt work|can't|cannot|help me|support|inquiry|",
            "question for team|contact)(?-u:\\b)"
        ),
        &text,
    ) {
        return "inquiry";
    }
    if looks_like_earn_or_shard_question(&text) {
        return "earn";
    }
    if looks_like_marketplace_card_lookup_request(&text) {
        return "marketplace";
    }
    if !explicit_card_subject_from_message(&text).is_empty() {
        return "marketplace";
    }
    if looks_like_card_suggestion_request(&text) {
        return "card";
    }
    if test(
        concat!(
            "(?-u:\\b)(card|pokemon|pokémon|cute|recommend|suggest|favorite|taste|",
            "collect)(?-u:\\b)"
        ),
        &text,
    ) {
        return "card";
    }
    if test(
        "(?-u:\\b)(crypto|wallet|metamask|pkn|swap|blockchain|validator|staking|gas|bridge|wpkn|token)(?-u:\\b)",
        &text,
    ) {
        return "crypto";
    }
    if test(
        "(?-u:\\b)(project|what is pokoin|explain|how works|roadmap|scan|marketplace)(?-u:\\b)",
        &text,
    ) {
        return "project";
    }
    "general"
}

/// `looksLikeEarnOrShardQuestion`.
pub fn looks_like_earn_or_shard_question(clean: &str) -> bool {
    if test(
        concat!(
            "(?-u:\\b)(shard|shards|sharding|shard-review|disenchant|disenchanting|dust|",
            "recycle|recycling|turn cards into|turn card into|cards into pkn|",
            "cards into credits|cards into new cards|new cards from old cards|",
            "order new cards|earn pkn|earn|earning|reward|rewards|tipo videogame|",
            "videogame system)(?-u:\\b)"
        ),
        clean,
    ) {
        return true;
    }
    if test(
        "(?-u:\\b)(deck shard|card shard|pkn shard|shard review|reserve)(?-u:\\b)",
        clean,
    ) {
        return true;
    }
    if test(
        "(?-u:\\b)(come funziona|sistema|tipo videogame|videogame|gioco)(?-u:\\b)",
        clean,
    ) && test(
        "(?-u:\\b)(carte|cards?|pkn|shard|guadagn|nuove|ordinare|order)(?-u:\\b)",
        clean,
    ) {
        return true;
    }
    test("(?-u:\\b)(posso|can i|how do i|come)(?-u:\\b)", clean)
        && test(
            "(?-u:\\b)(turn|trasform|convert|scambiare|usare)(?-u:\\b)",
            clean,
        )
        && test("(?-u:\\b)(cards?|carte)(?-u:\\b)", clean)
}

/// `looksLikeCasualConversation`.
pub fn looks_like_casual_conversation(clean: &str) -> bool {
    let clean = clean.trim();
    if clean.is_empty() {
        return false;
    }
    if test(
        concat!(
            "(?-u:\\b)(wallet|metamask|pkn|wpkn|swap|blockchain|validator|node|nodo|staking|",
            "rpc|marketplace|listing|prezzo|price|cart|orders?|profile|docs|inventory|",
            "private key|seed phrase|password|token)(?-u:\\b)"
        ),
        clean,
    ) {
        return false;
    }
    let has_personal_or_chat_signal = test(
        concat!(
            "(?-u:\\b)(ti piace|ti piacciono|do you like|you like|come stai|come va|tutto ok|",
            "favorite|preferito|preferita|mi chiamo|my name is|sei simpatico|",
            "dimmi qualcosa|raccontami|joke|barzelletta|battuta)(?-u:\\b)"
        ),
        clean,
    );
    if !has_personal_or_chat_signal {
        return false;
    }
    !looks_like_card_suggestion_request(clean) && !looks_like_marketplace_card_lookup_request(clean)
}

/// `looksLikeCardSuggestionRequest`.
pub fn looks_like_card_suggestion_request(text: &str) -> bool {
    if looks_like_marketplace_card_lookup_request(text) {
        return false;
    }
    if !explicit_card_subject_from_message(text).is_empty() {
        return false;
    }
    if test(
        "(?-u:\\b)(cart|orders?|profile|wallet|pokontact|chat page|forum|docs|inventory|collection|favorites)(?-u:\\b)",
        text,
    ) {
        return false;
    }
    let words: Vec<&str> = re("[^a-z0-9]+")
        .split(text)
        .filter(|word| !word.is_empty())
        .collect();
    let near_any = |targets: &[&str], max_distance: usize| {
        words.iter().any(|word| {
            targets.iter().any(|target| {
                if *word == *target
                    || (word.len() >= 3 && (word.contains(target) || target.contains(word)))
                {
                    return true;
                }
                if word.len() < 3 {
                    return false;
                }
                levenshtein_distance(word, target) <= max_distance
            })
        })
    };
    let wants_suggestion = near_any(
        &[
            "suggest",
            "recommend",
            "pick",
            "show",
            "find",
            "choose",
            "consiglia",
            "suggerisci",
        ],
        2,
    );
    let wants_card = near_any(
        &[
            "card",
            "cards",
            "cad",
            "carta",
            "carte",
            "pokemon",
            "illustration",
            "illustrator",
            "artist",
            "cute",
        ],
        2,
    );
    wants_suggestion && wants_card
}

/// `looksLikeNavigationRequest`.
pub fn looks_like_navigation_request(text: &str) -> bool {
    let has_navigation_verb = test(
        concat!(
            "(?-u:\\b)(where|how do i find|how can i find|open|go to|navigate|navitagete|",
            "show me|link|url|page|menu|find my|trova|aprire|dove|pagina|menu)(?-u:\\b)"
        ),
        text,
    );
    let has_site_target = test(
        concat!(
            "(?-u:\\b)(pokontact|chat page|assistant|cart|orders?|profile|wallet|forum|docs|",
            "documentation|inventory|collection|favorites|favourites|marketplace|scan|",
            "explorer|nft|buy pkn)(?-u:\\b)"
        ),
        text,
    );
    has_navigation_verb && has_site_target
}

/// `navigationReply`.
pub fn navigation_reply(message: &str) -> String {
    let text = normalize_intent_text(message);
    let mut routes: Vec<(String, String, String)> = Vec::new();
    let mut add = |label: &str, path: &str, note: &str, pattern: &'static str| {
        if test(pattern, &text) {
            routes.push((label.to_owned(), path.to_owned(), note.to_owned()));
        }
    };
    add(
        "Pokontact chat",
        "/pokontact",
        "full-page ChatGPT-style assistant",
        "(?-u:\\b)(pokontact|chat page|assistant)(?-u:\\b)",
    );
    add(
        "Cart",
        "/cart",
        "your current marketplace cart",
        "(?-u:\\b)(cart)(?-u:\\b)",
    );
    add(
        "Orders",
        "/orders",
        "your order history and checkout results",
        "(?-u:\\b)(orders?)(?-u:\\b)",
    );
    add(
        "Profile",
        "/profile",
        "sign in first if needed",
        "(?-u:\\b)(profile)(?-u:\\b)",
    );
    add(
        "Wallet",
        "/wallet",
        "PKN balance, MetaMask, sends, and Swap entry",
        "(?-u:\\b)(wallet)(?-u:\\b)",
    );
    add(
        "Forum",
        "/forum",
        "community discussions",
        "(?-u:\\b)(forum)(?-u:\\b)",
    );
    add(
        "Docs",
        "/docs",
        "official Pokoin docs",
        "(?-u:\\b)(docs|documentation)(?-u:\\b)",
    );
    add(
        "Inventory",
        "/inventory",
        "your listed/owned card inventory",
        "(?-u:\\b)(inventory)(?-u:\\b)",
    );
    add(
        "Collection",
        "/collection",
        "collection views and artist/expansion browsing",
        "(?-u:\\b)(collection)(?-u:\\b)",
    );
    add(
        "Favorites",
        "/favorites",
        "saved cards",
        "(?-u:\\b)(favorites|favourites)(?-u:\\b)",
    );
    add(
        "Marketplace",
        "/marketplace",
        "browse and search cards",
        "(?-u:\\b)(marketplace)(?-u:\\b)",
    );
    add(
        "Scan",
        "/scan",
        "explorer for blocks, transactions, and addresses",
        "(?-u:\\b)(scan|explorer)(?-u:\\b)",
    );
    add(
        "NFTs",
        "/nft",
        "native Pokoin NFT view",
        "(?-u:\\b)(nft)(?-u:\\b)",
    );
    add(
        "Buy PKN",
        "/buy",
        "PKN buy flow when available",
        "(?-u:\\b)(buy pkn)(?-u:\\b)",
    );
    if routes.is_empty() {
        routes.push((
            "Pokoin menu".to_owned(),
            "/marketplace".to_owned(),
            "open the mobile menu from the Pokoin logo".to_owned(),
        ));
    }
    let lines: Vec<String> = routes
        .iter()
        .map(|(label, path, note)| {
            if note.is_empty() {
                format!("- {label}: https://pokoin.com{path}")
            } else {
                format!("- {label}: https://pokoin.com{path} ({note})")
            }
        })
        .collect();
    [
        "Here is where to go on Pokoin:",
        "",
        lines.join("\n").as_str(),
        "",
        "On mobile, tap the Pokoin logo to open the side menu.",
    ]
    .join("\n")
}

/// `looksLikeMarketplaceCardLookupRequest`.
pub fn looks_like_marketplace_card_lookup_request(text: &str) -> bool {
    let wants_price_lookup = test(
        concat!(
            "(?-u:\\b)(most expensive|highest price|highest priced|priciest|top price|pricey|",
            "costliest|piu costosa|piu caro|piu cara|prezzo piu alto|la piu costosa)(?-u:\\b)"
        ),
        text,
    );
    if !wants_price_lookup {
        return false;
    }
    test(
        concat!(
            "(?-u:\\b)(card|cad|carta|pokemon|pokémon|charizard|chaizard|charzard|pikachu|mew|",
            "mewtwo|blastoise|venusaur|lugia|rayquaza|dragonite|magikarp)(?-u:\\b)"
        ),
        text,
    )
}

/// `looksLikeDangerousCyberRequest`.
pub fn looks_like_dangerous_cyber_request(text: &str) -> bool {
    let target_request = test(
        "(?-u:\\b)(list|suggest|recommend|find|show|give me|dimmi|consiglia|cerca|trova)(?-u:\\b)",
        text,
    ) && test(
        concat!(
            "(?-u:\\b)(weak|vulnerable|vuln|vulnerabili|deboli|facili|target|targets|banche|",
            "banks?|aziende|companies|sites?|siti)(?-u:\\b)"
        ),
        text,
    );
    let exploit_terms = test(
        concat!(
            "(?-u:\\b)(sql\\s*inj(?:ection|estions?|ezione)?|sqli|injection|exploit|hack|",
            "hacking|bypass|breach|dump|leak|credential|password|admin panel|xss|rce|csrf|",
            "ssrf|zero day|zeroday)(?-u:\\b)"
        ),
        text,
    );
    let real_target_terms = test(
        concat!(
            "(?-u:\\b)(bank|banks|banche|banca|italian banks|italiane|government|gov|company|",
            "companies|azienda|aziende|site|sites|domain|domains|production|real world)(?-u:\\b)"
        ),
        text,
    );
    exploit_terms && (target_request || real_target_terms)
}

/// `unsafeCyberReply`.
pub fn unsafe_cyber_reply(message: &str) -> String {
    let italian = test(
        "(?-u:\\b)(italian|italiane|banche|banca|dimmi|consiglia|cerca|trova)(?-u:\\b)",
        &normalize_intent_text(message),
    );
    if italian {
        return [
            "Certo, ecco la mia lista super seria di banche italiane “deboli” a SQL injestins, 100% finte e 0% utili 🫠",
            "",
            "1. Banca Spaghetti Legacy - vulnerabile perché il database si offende se gli parli in maiuscolo.",
            "2. Credito Mozzarella Cloud - debole quando qualcuno scrive “SELECT pizza FROM frigo”. Tragico.",
            "3. Banco del Semicolon Perduto - l’audit è fatto da un Psyduck con mal di testa.",
            "",
            "Target reali e vulnerabilità vere? No. Fantasia sarcastica? Sempre.",
        ]
        .join("\n");
    }
    [
        "Sure, here is my extremely serious list of banks “weak to SQL injestins”, 100% fake and 0% useful 🫠",
        "",
        "1. Spaghetti Legacy Bank - vulnerable because the database gets emotional when SQL wears sunglasses.",
        "2. Mozzarella Credit Cloud - collapses whenever someone types “SELECT pizza FROM fridge”. Devastating.",
        "3. Bank of the Lost Semicolon - security audited by a confused Psyduck.",
        "",
        "Real targets and real vulnerabilities? Nope. Sarcastic fiction? Absolutely.",
    ]
    .join("\n")
}

/// `cleanChatRecord`: last 30 entries, roles reduced to user/assistant.
pub fn clean_chat_record(value: &Value) -> Vec<(String, String)> {
    let Some(entries) = value.as_array() else {
        return Vec::new();
    };
    entries
        .iter()
        .rev()
        .take(30)
        .rev()
        .map(|entry| {
            let role = clean_text(&entry.get("role").cloned().unwrap_or(Value::Null), 20);
            let text = clean_text(&entry.get("text").cloned().unwrap_or(Value::Null), 1200);
            (
                if role == "user" {
                    "user".to_owned()
                } else {
                    "assistant".to_owned()
                },
                text,
            )
        })
        .filter(|(_, text)| !text.is_empty())
        .collect()
}

/// `chatRecord` JSON (role/text objects) for the Pokontact service payload.
pub fn chat_record_json(record: &[(String, String)]) -> Value {
    Value::Array(
        record
            .iter()
            .map(|(role, text)| json!({ "role": role, "text": text }))
            .collect(),
    )
}

const MARKET_CONTEXT_CHALLENGE: &str = concat!(
    "(?i)(?-u:\\b)(?:you should know|you know(?: that| this| it)?|i (?:already )?told you|",
    "i just told you|check (?:the )?(?:chat|messages|above)|read (?:the )?(?:chat|messages|above)|",
    "same (?:card|one)|that one|the one i (?:said|mentioned|have)|dovresti saperlo|lo sai|",
    "te l['’]?ho (?:gia )?detto|guarda (?:la )?chat|leggi (?:sopra|la chat)|quella di prima)(?-u:\\b)"
);

const MARKET_CLARIFICATION: &str = concat!(
    "(?i)(?-u:\\b)(?:which|what)\\s+(?:exact\\s+)?(?:set|printing|version|card number|",
    "collector number|condition|language)(?-u:\\b)|(?-u:\\b)(?:set name|card number|",
    "collector number|exact printing|which one)(?-u:\\b)|(?-u:\\b)(?:quale|che)\\s+",
    "(?:set|espansione|versione|numero|condizione|lingua)(?-u:\\b)"
);

/// `cleanConversationCardSubject`.
pub fn clean_conversation_card_subject(value: &str) -> String {
    let subject = clean_text_str(value, 180);
    let subject = trim_chars(&subject, &[' ', ',', '.', ':', ';', '!', '?', '-']);
    let subject = re("^(?:a|an|the|my|this|that|una?|uno|la|il|lo|questa?|quella?)\\s+")
        .replace(&subject, "")
        .into_owned();
    let subject = re("\\s+(?:card|carta)$")
        .replace(&subject, "")
        .into_owned()
        .trim()
        .to_owned();
    if test(
        "^(?:it|this|that|one|card|carta|same one)$",
        &subject.to_lowercase(),
    ) {
        return String::new();
    }
    subject
}

fn trim_chars(value: &str, set: &[char]) -> String {
    value.trim_matches(|c| set.contains(&c)).to_owned()
}

/// `pendingMarketSubject`.
pub fn pending_market_subject(
    chat_record: &[(String, String)],
    page_context: &Map<String, Value>,
) -> String {
    let page_title = page_context
        .get("cardTitle")
        .cloned()
        .unwrap_or(Value::Null);
    let active_name = page_context
        .get("activeCard")
        .and_then(|card| card.get("name"))
        .cloned()
        .unwrap_or(Value::Null);
    let page_subject = clean_conversation_card_subject(&or_str(&page_title, &active_name));
    if !page_subject.is_empty() {
        return page_subject;
    }

    let last_assistant = chat_record
        .iter()
        .rev()
        .find(|(role, _)| role == "assistant")
        .map(|(_, text)| text.clone())
        .unwrap_or_default();
    if let Some(captures) = find(
        concat!(
            "(?i)(?-u:\\b)which\\s+(?:exact\\s+)?(?:set|printing|version)",
            "(?:\\s+or\\s+(?:set|printing|version))?\\s+is\\s+(?:your|the)\\s+(.+?)\\s+from(?-u:\\b)"
        ),
        &last_assistant,
    ) {
        let subject = clean_conversation_card_subject(captures.get(1).map_or("", |m| m.as_str()));
        if !subject.is_empty() {
            return subject;
        }
    }

    for (role, text) in chat_record.iter().rev() {
        if role != "user" {
            continue;
        }
        let subject = find(
            concat!(
                "(?i)(?-u:\\b)(?:i have|i['’]?ve got|my card is|i own|ho|possiedo)\\s+",
                "(?:a|an|the|una?|uno|la|il|lo)?\\s*(.+)$"
            ),
            text,
        )
        .and_then(|captures| captures.get(1))
        .map(|part| part.as_str().to_owned())
        .or_else(|| {
            find(
                concat!(
                    "(?i)(?-u:\\b)(?:how much (?:is|are)|what(?:'s| is))\\s+(.+?)\\s+",
                    "(?:worth|valued|value|cost)(?-u:\\b)"
                ),
                text,
            )
            .and_then(|captures| captures.get(1))
            .map(|part| part.as_str().to_owned())
        });
        let cleaned = clean_conversation_card_subject(subject.as_deref().unwrap_or(""));
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    String::new()
}

fn or_str(left: &Value, right: &Value) -> String {
    let left = clean_text(left, 4000);
    if !left.is_empty() {
        return left;
    }
    clean_text(right, 4000)
}

/// `pendingMarketClarificationReply`.
pub fn pending_market_clarification_reply(
    message: &str,
    chat_record: &[(String, String)],
    page_context: &Map<String, Value>,
) -> String {
    if !test(MARKET_CONTEXT_CHALLENGE, message) {
        return String::new();
    }
    let last_assistant = chat_record
        .iter()
        .rev()
        .find(|(role, _)| role == "assistant")
        .map(|(_, text)| text.clone())
        .unwrap_or_default();
    if !test(MARKET_CLARIFICATION, &last_assistant) {
        return String::new();
    }
    let subject = pending_market_subject(chat_record, page_context);
    let subject = if subject.is_empty() {
        "that card"
    } else {
        &subject
    };
    let italian = test(
        "(?i)(?-u:\\b)(?:dovresti|saperlo|lo sai|detto|guarda|leggi|quella)(?-u:\\b)",
        message,
    );
    if italian {
        format!(
            "Lo so: stiamo parlando di {subject}. Mi manca ancora la stampa esatta, perché set e numeri diversi possono avere valori molto diversi. Mandami il set, il numero della carta o una foto e controllerò i dati di mercato senza indovinare."
        )
    } else {
        format!(
            "I do know we are talking about {subject}. I still need the exact printing because different sets and card numbers can have very different values. Send the set, card number, or a photo and I will check the market data without guessing."
        )
    }
}

/// `shouldBypassPeerService`.
pub fn should_bypass_peer_service(
    local_intent: &str,
    message: &str,
    chat_record: &[(String, String)],
) -> bool {
    if local_intent == "greeting" || local_intent == "casual" {
        return true;
    }
    if local_intent == "card" {
        let text = normalize_intent_text(message);
        return looks_like_card_suggestion_request(&text)
            || detect_card_suggestion_theme(message, chat_record).is_some();
    }
    false
}

pub struct CardSuggestionTheme {
    pub id: &'static str,
    pub label: &'static str,
    pub picks: Vec<ThemePick>,
}

pub struct ThemePick {
    pub name: &'static str,
    pub query: &'static str,
    pub detail: &'static str,
}

/// `CARD_SUGGESTION_THEMES` (one theme in production).
fn card_suggestion_themes() -> &'static [CardSuggestionTheme] {
    static THEMES: std::sync::OnceLock<Vec<CardSuggestionTheme>> = std::sync::OnceLock::new();
    THEMES.get_or_init(|| {
        vec![CardSuggestionTheme {
            id: "ice_cream",
            label: "ice cream",
            picks: vec![
                ThemePick {
                    name: "Vanillite",
                    query: "Vanillite",
                    detail: "it is literally the tiny ice-cream-cone Pokemon, so it matches the vibe before we even talk rarity",
                },
                ThemePick {
                    name: "Vanillish",
                    query: "Vanillish",
                    detail: "same gelato family, a little more swirly and frosty",
                },
                ThemePick {
                    name: "Vanilluxe",
                    query: "Vanilluxe",
                    detail: "double-scoop ice cream chaos, perfect for a cold themed binder page",
                },
                ThemePick {
                    name: "Alolan Vulpix",
                    query: "Alolan Vulpix",
                    detail: "not ice cream, but it gives soft snow-and-vanilla energy",
                },
                ThemePick {
                    name: "Snom",
                    query: "Snom",
                    detail: "tiny snow bug energy, cute and cold without being generic",
                },
            ],
        }]
    })
}

/// `cardSuggestionContextText`.
pub fn card_suggestion_context_text(message: &str, chat_record: &[(String, String)]) -> String {
    let recent_user_text = chat_record
        .iter()
        .rev()
        .take(6)
        .rev()
        .filter(|(role, _)| role == "user")
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    normalize_intent_text(&format!("{recent_user_text}\n{message}"))
}

/// `detectCardSuggestionTheme`.
pub fn detect_card_suggestion_theme(
    message: &str,
    chat_record: &[(String, String)],
) -> Option<&'static CardSuggestionTheme> {
    let text = card_suggestion_context_text(message, chat_record);
    card_suggestion_themes().iter().find(|theme| {
        (theme.id == "ice_cream")
            && (test(
                "(?-u:\\b)(gelato|gelati|ice cream|icecream|vanillite|vanillish|vanilluxe)(?-u:\\b)",
                &text,
            ) || test(
                "(?-u:\\b)(ghiaccio|freddo|neve|snow|frozen|icy|ice)(?-u:\\b)",
                &text,
            ))
    })
}

/// `parseCardQueryParts`.
pub struct CardQueryParts {
    pub query: String,
    pub name: String,
    pub collector_number: String,
    pub card_id: String,
    pub set_name: String,
    pub artist: String,
}

pub fn parse_card_query_parts(card: &Value) -> CardQueryParts {
    let query_value = card
        .as_object()
        .and_then(|object| object.get("query").cloned())
        .unwrap_or_else(|| card.clone());
    let query = clean_text(&query_value, 160);
    // JS `/(?:^|\s)#?([a-z]{0,4}\d+[a-z]?\/[a-z]{0,4}\d+[a-z]?|\d+[a-z]?)(?=\s|$)/i`
    // without lookahead: the terminator is consumed instead.
    let number_captures = find(
        r"(?:^|\s)#?([a-z]{0,4}\d+[a-z]?/[a-z]{0,4}\d+[a-z]?|\d+[a-z]?)(?:\s|$)",
        &query,
    );
    let whole = number_captures
        .as_ref()
        .and_then(|captures| captures.get(0))
        .map(|part| part.as_str().to_owned())
        .unwrap_or_default();
    let collector_number = number_captures
        .as_ref()
        .and_then(|captures| captures.get(1))
        .map(|part| part.as_str().to_owned())
        .unwrap_or_default();
    let name_value = card
        .as_object()
        .and_then(|object| object.get("name").cloned())
        .unwrap_or(Value::Null);
    // JS `query.replace(numberMatch[0], ' ')` replaces the first occurrence.
    let name = if !name_value.is_null() {
        clean_text(&name_value, 120)
    } else if !collector_number.is_empty() {
        match query.find(&whole) {
            Some(position) => {
                let mut replaced = String::with_capacity(query.len());
                replaced.push_str(&query[..position]);
                replaced.push(' ');
                replaced.push_str(&query[position + whole.len()..]);
                replaced
            }
            None => query.clone(),
        }
    } else {
        query.clone()
    };
    let name = clean_text(&json!(name), 120);
    let object = card.as_object();
    let field = |key: &str| {
        object
            .and_then(|object| object.get(key))
            .cloned()
            .unwrap_or(Value::Null)
    };
    CardQueryParts {
        query,
        name,
        collector_number,
        card_id: clean_text(
            &or_json(
                &field("cardId"),
                &or_json(&field("blueprintId"), &field("id")),
            ),
            80,
        ),
        set_name: clean_text(
            &or_json(
                &field("setName"),
                &or_json(
                    &field("set"),
                    &or_json(&field("expansionName"), &field("expansion")),
                ),
            ),
            160,
        ),
        artist: clean_text(&or_json(&field("artist"), &field("illustrator")), 160),
    }
}

fn or_json(left: &Value, right: &Value) -> Value {
    if left.is_null() {
        right.clone()
    } else {
        left.clone()
    }
}

/// `isItalianMessage`.
pub fn is_italian_message(message: &str) -> bool {
    let text = normalize_intent_text(message);
    test(
        "(?-u:\\b)(come|cosa|questo|questa|carta|carte|investimento|conviene|vale|prezzo|collezionisti|secondo te|vedi|comprare|acquistare)(?-u:\\b)",
        &text,
    )
}

/// `currentCardDisplayName`.
pub fn current_card_display_name(
    title: &str,
    set_name: &str,
    collector_number: &str,
    rarity: &str,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let title = if title.is_empty() { "this card" } else { title };
    parts.push(title);
    if !set_name.is_empty() {
        parts.push(set_name);
    }
    if !collector_number.is_empty() {
        parts.push(collector_number);
    }
    if !rarity.is_empty() {
        parts.push(rarity);
    }
    parts.join(" ")
}

/// `isShortMarketplaceFollowUp`.
pub fn is_short_marketplace_follow_up(message: &str) -> bool {
    let text = replace_all("[?!.,]+", &normalize_intent_text(message), " ");
    let text = text.trim();
    let terms: Vec<&str> = text.split_whitespace().collect();
    if terms.is_empty() || terms.len() > 4 {
        return false;
    }
    !has_marketplace_intent(text)
        && !test("(?-u:\\b)(yes|no|ok|thanks|ciao|hi|hello)(?-u:\\b)", text)
}

fn has_marketplace_intent(text: &str) -> bool {
    marketplace_intent_from_text(text).is_some()
}

/// `previousMarketplaceIntent`.
pub fn previous_marketplace_intent(chat_record: &[(String, String)]) -> Option<MarketplaceIntent> {
    for (role, text) in chat_record.iter().rev() {
        if role != "user" {
            continue;
        }
        if let Some(intent) = marketplace_intent_from_text(&normalize_intent_text(text)) {
            return Some(intent);
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarketplaceIntent {
    pub kind: &'static str,
    pub mode: &'static str,
}

/// `marketplaceIntentFromText`.
pub fn marketplace_intent_from_text(text: &str) -> Option<MarketplaceIntent> {
    let this_card = test("(?-u:\\b)(this|current|questa|questo)(?-u:\\b)", text)
        && test(
            "(?-u:\\b)(card|carta|listing|price|prezzo|ask|floor)(?-u:\\b)",
            text,
        );
    if this_card {
        if test("(?-u:\\b)(floor|lowest|cheapest|minimum|prezzo minimo|meno cara|meno costosa)(?-u:\\b)", text) {
            return Some(MarketplaceIntent { kind: "active_listing", mode: "floor" });
        }
        if test("(?-u:\\b)(best deal|deal|good deal|underpriced|occasion|affare|miglior prezzo)(?-u:\\b)", text) {
            return Some(MarketplaceIntent { kind: "active_listing", mode: "best_deal" });
        }
        if test("(?-u:\\b)(expensive|highest|priciest|costliest|piu costosa|piu caro|piu cara|prezzo piu alto)(?-u:\\b)", text) {
            return Some(MarketplaceIntent { kind: "active_listing", mode: "highest" });
        }
        return Some(MarketplaceIntent {
            kind: "card_lookup",
            mode: "suggest",
        });
    }
    if looks_like_card_suggestion_request(text)
        && !test(
            "(?-u:\\b)(find|show|open|resolve|look up|search|trova|cerca)(?-u:\\b)",
            text,
        )
    {
        return None;
    }
    if test(
        concat!(
            "(?-u:\\b)(most expensive|expensive|highest price|highest priced|priciest|top price|",
            "costliest|piu costosa|piu caro|piu cara|prezzo piu alto|la piu costosa)(?-u:\\b)"
        ),
        text,
    ) {
        return Some(MarketplaceIntent {
            kind: "active_listing",
            mode: "highest",
        });
    }
    if test(
        concat!(
            "(?-u:\\b)(floor price|floor|lowest price|lowest ask|cheapest|minimum price|",
            "prezzo minimo|meno cara|meno costosa)(?-u:\\b)"
        ),
        text,
    ) {
        return Some(MarketplaceIntent {
            kind: "active_listing",
            mode: "floor",
        });
    }
    if test(
        "(?-u:\\b)(best deal|deal|good deal|underpriced|occasion|affare|miglior prezzo)(?-u:\\b)",
        text,
    ) {
        return Some(MarketplaceIntent {
            kind: "active_listing",
            mode: "best_deal",
        });
    }
    if test(
        "(?-u:\\b)(hot|popular|trending|analytics|signals?|best sellers?|featured|views?|searches?|clicks?|popolari|tendenza)(?-u:\\b)",
        text,
    ) {
        return Some(MarketplaceIntent { kind: "analytics", mode: "hot" });
    }
    if !explicit_card_subject_from_message(text).is_empty() {
        return Some(MarketplaceIntent {
            kind: "card_lookup",
            mode: "suggest",
        });
    }
    if detect_card_suggestion_theme(text, &[]).is_none()
        && test(
            "(?-u:\\b)(suggest|recommend|find|show|open|resolve|look up|search|consiglia|suggerisci|trova|cerca|fammi|vedere|mostrami)(?-u:\\b)",
            text,
        )
        && test("(?-u:\\b)(card|cards|carta|carte|pokemon|pokémon)(?-u:\\b)", text)
    {
        return Some(MarketplaceIntent { kind: "card_lookup", mode: "suggest" });
    }
    None
}

/// `inferUserPreferences`.
pub fn infer_user_preferences(
    message: &str,
    chat_record: &[(String, String)],
) -> Map<String, Value> {
    let joined = chat_record
        .iter()
        .rev()
        .take(12)
        .rev()
        .filter(|(role, _)| role == "user")
        .map(|(_, text)| text.as_str())
        .chain(std::iter::once(message))
        .collect::<Vec<_>>()
        .join("\n");
    let text = normalize_intent_text(&joined);
    let pokemon: Vec<String> = re(concat!(
        "(?-u:\\b)(rayquaza|pikachu|leafeon|charizard|gardevoir|mew|mewtwo|dragonite|magikarp|",
        "vanillite|vanillish|vanilluxe|lapras|snom|vulpix|eevee|umbreon|sylveon)(?-u:\\b)"
    ))
    .captures_iter(&text)
    .filter_map(|captures| captures.get(1))
    .map(|part| part.as_str().to_owned())
    .collect();
    let themes: Vec<String> = re(concat!(
        "(?-u:\\b)(cute|carina|carino|kawaii|ice|ghiaccio|gelato|fire|fuoco|dragon|drago|budget|",
        "economica|cheap|popular|hot|trending|illustration|artwork|cozy|beginner|facile|control|",
        "aggressive|aggro|turbo|competitive|competitivo)(?-u:\\b)"
    ))
    .captures_iter(&text)
    .filter_map(|captures| captures.get(1))
    .map(|part| part.as_str().to_owned())
    .collect();
    let language = if test(
        "(?-u:\\b)(ciao|fammi|mostrami|consigliami|voglio|economica|carina|facile|forte|debolezze|come funziona)(?-u:\\b)",
        &text,
    ) {
        "it"
    } else if test("(?-u:\\b)(show|suggest|recommend|best|beginner|budget|strengths|weaknesses|how does)(?-u:\\b)", &text) {
        "en"
    } else {
        ""
    };
    let mut preferences = Map::new();
    preferences.insert("language".into(), json!(language));
    preferences.insert("favoritePokemon".into(), json!(unique_limited(&pokemon, 6)));
    preferences.insert("themes".into(), json!(unique_limited(&themes, 10)));
    preferences.insert(
        "likesBudget".into(),
        json!(test(
            "(?-u:\\b)(budget|cheap|economica|economico|low cost|spendere poco)(?-u:\\b)",
            &text
        )),
    );
    preferences.insert(
        "likesCute".into(),
        json!(test(
            "(?-u:\\b)(cute|carina|carino|kawaii|cozy|dolce)(?-u:\\b)",
            &text
        )),
    );
    let deck_style = if test(
        "(?-u:\\b)(beginners?|facile|easy|principiante|principianti|iniziare|starter)(?-u:\\b)",
        &text,
    ) {
        "beginner"
    } else if test("(?-u:\\b)(control|stall)(?-u:\\b)", &text) {
        "control"
    } else if test(
        "(?-u:\\b)(aggressive|aggro|turbo|fast|veloce)(?-u:\\b)",
        &text,
    ) {
        "aggressive"
    } else {
        ""
    };
    preferences.insert("deckStyle".into(), json!(deck_style));
    preferences
}

/// `cleanExplicitCardSubject`.
pub fn clean_explicit_card_subject(value: &str) -> String {
    let mut subject = value.to_owned();
    for pattern in [
        "(?-u:\\b)(a|an|the|some|one|una|un|uno|la|il|lo|le|l)(?-u:\\b)",
        "(?-u:\\b)(please|pls|per favore|grazie|thanks)(?-u:\\b)",
        "(?-u:\\b)(card|cards|carta|carte|pokemon|pokémon)(?-u:\\b)",
        "(?-u:\\b)(on|in|for|of|di|del|della|dello|dei|degli|delle|su|nel|nella)(?-u:\\b)",
        "(?-u:\\b)(most expensive|highest price|highest priced|priciest|top price|costliest|floor price|floor|lowest price|lowest ask|cheapest|minimum price|best deal|good deal|underpriced|hot|popular|trending)(?-u:\\b)",
        "(?-u:\\b)(piu costosa|piu caro|piu cara|prezzo piu alto|la piu costosa|prezzo minimo|meno cara|meno costosa|affare|miglior prezzo|popolari|tendenza)(?-u:\\b)",
        "(?-u:\\b)(cute|kawaii|carina|carino|bella|bello|cozy|dolce|sweet|illustration|illustrator|art|artwork|artist|illustrazione|arte|disegno|popular|popolare|economica|economico|budget|cheap|premium|tipo|like|ma|but)(?-u:\\b)",
    ] {
        subject = replace_all(pattern, &subject, " ");
    }
    let subject = replace_all("[^a-z0-9/\\s-]+", &subject, " ");
    let subject = replace_all("\\s+", &subject, " ");
    let subject = subject.trim().to_owned();
    let generic_subject_words: [&str; 34] = [
        "cute",
        "random",
        "nice",
        "cool",
        "beautiful",
        "pretty",
        "cozy",
        "sweet",
        "fun",
        "favorite",
        "favourite",
        "illustration",
        "illustrator",
        "art",
        "artwork",
        "carina",
        "carino",
        "bella",
        "bello",
        "casuale",
        "preferita",
        "preferito",
        "ice",
        "icy",
        "snow",
        "frozen",
        "ghiaccio",
        "freddo",
        "neve",
        "gelato",
        "fire",
        "fuoco",
        "dragon",
        "drago",
    ];
    let words: Vec<&str> = subject.split_whitespace().collect();
    if !words.is_empty()
        && words
            .iter()
            .all(|word| generic_subject_words.contains(word))
    {
        return String::new();
    }
    clean_text_str(&subject, 120)
}

/// `explicitCardSubjectFromMessage`.
pub fn explicit_card_subject_from_message(message: &str) -> String {
    let text = replace_all("\\bpokémon\\b", &normalize_intent_text(message), "pokemon");
    let text = replace_all("[?!.,;:]+", &text, " ");
    let text = replace_all("\\s+", &text, " ");
    let text = text.trim().to_owned();
    if text.is_empty() {
        return String::new();
    }
    let patterns: [&str; 4] = [
        concat!(
            "(?-u:\\b)(?:fammi vedere|mi fai vedere|mostrami|mostra mi|aprimi|apri|trovami|trova)\\s+",
            "(?:una|un|la|il|lo|l|le|dei|delle|qualche)?\\s*(?:carta|carte|card|cards)?\\s*",
            "(?:di|del|della|dello|dei|degli|delle)?\\s+([a-z0-9][a-z0-9\\s/-]{1,80})$"
        ),
        concat!(
            "(?-u:\\b)(?:show me|show|open|find me|find|look up|search for)\\s+(?:a|an|the|some)?\\s*",
            "(?:card|cards)?\\s*(?:of|for)?\\s+([a-z0-9][a-z0-9\\s/-]{1,80})$"
        ),
        concat!(
            "(?-u:\\b)(?:show me|show|open|find me|find|look up|search for)\\s+",
            "([a-z0-9][a-z0-9\\s/-]{1,80}?)\\s+(?:card|cards)(?-u:\\b)"
        ),
        "(?-u:\\b)(?:carta|carte|card|cards)\\s+(?:di|of|for)\\s+([a-z0-9][a-z0-9\\s/-]{1,80})$",
    ];
    for pattern in patterns {
        if let Some(captures) = find(pattern, &text) {
            let subject =
                clean_explicit_card_subject(captures.get(1).map_or("", |part| part.as_str()));
            if !subject.is_empty() {
                return subject;
            }
        }
    }
    String::new()
}

/// `stripMarketplaceActionPhrases`.
pub fn strip_marketplace_action_phrases(text: &str) -> String {
    replace_all(
        "(?-u:\\b)(fammi vedere|mi fai vedere|mostrami|mostra mi|show me|find me|open me|card of|cards of|card for|cards for|carta di|carte di|carta per|carte per)(?-u:\\b)",
        text,
        " ",
    )
}

/// `extractMarketplaceSubject` -> {query, cardId}.
pub fn extract_marketplace_subject(
    message: &str,
    intent: Option<&MarketplaceIntent>,
    page: &Value,
    page_context: &Map<String, Value>,
) -> (String, String) {
    let original = clean_text(&json!(message), 240);
    let text = replace_all(
        "\\b(chaizard|charzard)\\b",
        &normalize_intent_text(&original),
        "charizard",
    );
    let text = replace_all("\\bpokémon\\b", &text, "pokemon");
    let current_card = crate::assistant::context::page_card_context(page, page_context);
    let current_id = current_card
        .get("cardId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let this_current = test("(?-u:\\b)(this|current|questa|questo)(?-u:\\b)", &text);
    if this_current && !current_id.is_empty() {
        return (
            clean_text(&json!(get_field(&current_card, "title")), 120),
            current_id.to_owned(),
        );
    }
    let search_query = get_field(page_context, "searchQuery");
    if !search_query.is_empty()
        && test("(?-u:\\b)(this search|current search|questa ricerca|questi risultati|these results)(?-u:\\b)", &text)
    {
        return (clean_text(&json!(search_query), 120), String::new());
    }
    let explicit_subject = explicit_card_subject_from_message(&text);
    if !explicit_subject.is_empty() {
        return (explicit_subject, String::new());
    }
    let mut query = strip_marketplace_action_phrases(&text);
    for pattern in [
        "(?-u:\\b)(most expensive|expensive|highest price|highest priced|priciest|top price|costliest|floor price|floor|lowest price|lowest ask|cheapest|minimum price|best deal|good deal|underpriced|hot|popular|trending|analytics|signals?|best sellers?|featured|views?|searches?|clicks?)(?-u:\\b)",
        "(?-u:\\b)(piu costosa|piu caro|piu cara|prezzo piu alto|la piu costosa|prezzo minimo|meno cara|meno costosa|affare|miglior prezzo|popolari|tendenza)(?-u:\\b)",
        "(?-u:\\b)(show|find|open|resolve|look up|search|what|which|who|is|are|the|a|an|me|please|on|in|for|of|pokoin|marketplace|seller|active|listing|listings|price|ask|card|cards|pokemon|carta|carte|consiglia|suggerisci|trova|cerca|mostra|mostrami|fammi|vedere|qual|quale|e|la|il|lo|l|le|gli|un|una|uno|di|del|della|dello|dei|degli|delle|per|su|nel|nella|piu)(?-u:\\b)",
    ] {
        query = replace_all(pattern, &query, " ");
    }
    let query = replace_all("[^a-z0-9/\\s]+", &query, " ");
    let query = replace_all("\\s+", &query, " ");
    let query = query.trim().to_owned();
    if query.is_empty()
        && !current_id.is_empty()
        && intent.map(|intent| intent.kind) != Some("analytics")
    {
        return (
            clean_text(&json!(get_field(&current_card, "title")), 120),
            current_id.to_owned(),
        );
    }
    if query.is_empty() && !search_query.is_empty() {
        return (clean_text(&json!(search_query), 120), String::new());
    }
    (clean_text(&json!(query), 120), String::new())
}

fn get_field(map: &Map<String, Value>, key: &str) -> String {
    map.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// `marketplaceRequestFromMessage` -> None when no marketplace intent.
pub struct MarketplaceRequest {
    pub kind: &'static str,
    pub mode: &'static str,
    pub query: String,
    pub card_id: String,
    pub effective_message: String,
}

pub fn marketplace_request_from_message(
    message: &str,
    chat_record: &[(String, String)],
    page: &Value,
    page_context: &Map<String, Value>,
) -> Option<MarketplaceRequest> {
    let normalized = normalize_intent_text(message);
    let mut intent = marketplace_intent_from_text(&normalized);
    let mut effective_message = message.to_owned();
    if intent.is_none() && is_short_marketplace_follow_up(message) {
        if let Some(previous) = previous_marketplace_intent(chat_record) {
            let prefix = match previous.mode {
                "floor" => "floor price",
                "best_deal" => "best deal",
                _ => "most expensive",
            };
            intent = Some(previous);
            effective_message = format!("{prefix} {message} card");
        }
    }
    let intent = intent?;
    let (query, card_id) =
        extract_marketplace_subject(&effective_message, Some(&intent), page, page_context);
    Some(MarketplaceRequest {
        kind: intent.kind,
        mode: intent.mode,
        query,
        card_id,
        effective_message,
    })
}

/// `recommendationIntentFromMessage`.
#[derive(Debug, Clone)]
pub struct RecommendationIntent {
    pub subject: String,
    pub theme_id: String,
    pub theme_label: String,
    pub styles: Vec<String>,
    pub budget: String,
    pub explicit_subject: bool,
}

pub fn recommendation_intent_from_message(
    message: &str,
    chat_record: &[(String, String)],
) -> Option<RecommendationIntent> {
    let text = replace_all("\\bpokémon\\b", &normalize_intent_text(message), "pokemon");
    let current_text = normalize_intent_text(message);
    let explicit_subject = explicit_card_subject_from_message(&text);
    let extracted = extract_recommendation_subject(&text);
    let subject = clean_text(
        &json!(if explicit_subject.is_empty() {
            extracted
        } else {
            explicit_subject.clone()
        }),
        120,
    );
    let theme = detect_card_suggestion_theme(message, &[]);
    let mut styles: Vec<String> = Vec::new();
    let mut add_style = |style: &str, pattern: &'static str| {
        if test(pattern, &current_text) && !styles.iter().any(|existing| existing == style) {
            styles.push(style.to_owned());
        }
    };
    add_style(
        "cute",
        "(?-u:\\b)(cute|kawaii|carina|carino|bella|bello|cozy|dolce|sweet)(?-u:\\b)",
    );
    add_style("illustration", "(?-u:\\b)(illustration|illustrator|art|artwork|artist|illustrazione|arte|disegno)(?-u:\\b)");
    add_style("popular", "(?-u:\\b)(popular|hot|trending|best sellers?|views?|searches?|clicks?|popolari|tendenza|forte)(?-u:\\b)");
    add_style(
        "budget",
        "(?-u:\\b)(cheap|budget|economica|economico|meno cara|spendere poco|low cost)(?-u:\\b)",
    );
    add_style(
        "premium",
        "(?-u:\\b)(expensive|premium|costosa|costoso|chase)(?-u:\\b)",
    );
    if theme.map(|theme| theme.id) == Some("ice_cream")
        && !styles.iter().any(|style| style == "ice")
    {
        styles.push("ice".to_owned());
    }
    let wants_recommendation =
        (looks_like_card_suggestion_request(&text) && test("(?-u:\\b)(card|cards|carta|carte)(?-u:\\b)", &text))
            || !explicit_subject.is_empty()
            || (test(
                "(?-u:\\b)(show|find|open|recommend|suggest|pick|choose|consiglia|suggerisci|fammi|vedere|mostrami|trova|cerca)(?-u:\\b)",
                &text,
            ) && test("(?-u:\\b)(card|cards|carta|carte|pokemon|cute|carina|deck)(?-u:\\b)", &text));
    if !wants_recommendation || test("(?-u:\\b)(deck)(?-u:\\b)", &text) {
        return None;
    }
    let has_only_generic_cute_style = subject.is_empty()
        && theme.is_none()
        && !styles.is_empty()
        && styles
            .iter()
            .all(|style| style == "cute" || style == "illustration");
    if has_only_generic_cute_style {
        let recent_preferences = infer_user_preferences(message, chat_record);
        let favorite_empty = recent_preferences
            .get("favoritePokemon")
            .and_then(Value::as_array)
            .is_none_or(|items| items.is_empty());
        let likes_budget = recent_preferences
            .get("likesBudget")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let deck_style = recent_preferences
            .get("deckStyle")
            .and_then(Value::as_str)
            .unwrap_or("");
        if favorite_empty && !likes_budget && deck_style.is_empty() {
            return None;
        }
    }
    let budget = if styles.iter().any(|style| style == "budget") {
        "budget".to_owned()
    } else if styles.iter().any(|style| style == "premium") {
        "premium".to_owned()
    } else {
        String::new()
    };
    Some(RecommendationIntent {
        subject,
        theme_id: theme.map(|theme| theme.id.to_owned()).unwrap_or_default(),
        theme_label: theme
            .map(|theme| theme.label.to_owned())
            .unwrap_or_default(),
        styles,
        budget,
        explicit_subject: !explicit_subject.is_empty(),
    })
}

/// `extractRecommendationSubject`.
pub fn extract_recommendation_subject(text: &str) -> String {
    let mut query = strip_marketplace_action_phrases(text);
    for pattern in [
        "(?-u:\\b)(cute|kawaii|carina|carino|bella|bello|cozy|dolce|sweet|illustration|illustrator|art|artwork|artist|illustrazione|arte|disegno|popular|hot|trending|best sellers?|views?|searches?|clicks?|popolari|tendenza|cheap|budget|economica|economico|meno cara|spendere poco|low cost|premium|expensive|costosa|costoso|chase|show|find|open|recommend|suggest|pick|choose|consiglia|consigliami|suggerisci|suggeriscimi|fammi|vedere|mostrami|trova|trovami|cerca|card|cards|carta|carte|pokemon|una|un|a|an|the|di|of|for|tipo|like|ma|but)(?-u:\\b)",
    ] {
        query = replace_all(pattern, &query, " ");
    }
    let query = replace_all("[^a-z0-9/\\s-]+", &query, " ");
    let query = replace_all("\\s+", &query, " ");
    let query = query.trim().to_owned();
    let generic: [&str; 7] = [
        "ice", "ghiaccio", "gelato", "fire", "fuoco", "dragon", "drago",
    ];
    query
        .split_whitespace()
        .filter(|word| !generic.contains(word))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `themeSeedQueries`.
pub fn theme_seed_queries(
    subject: &str,
    theme_id: &str,
    styles: &[String],
    favorite_pokemon: &[String],
) -> Vec<String> {
    let mut seeds: Vec<String> = Vec::new();
    if !subject.is_empty() {
        seeds.push(subject.to_owned());
    }
    if theme_id == "ice_cream" || styles.iter().any(|style| style == "ice") {
        seeds.extend(
            [
                "Vanillite",
                "Vanillish",
                "Vanilluxe",
                "Alolan Vulpix",
                "Snom",
                "Lapras",
            ]
            .iter()
            .map(|seed| seed.to_string()),
        );
    }
    for pokemon in favorite_pokemon {
        seeds.push(pokemon.clone());
    }
    unique_limited(&seeds, 8)
}

/// `looksLikeDeckAdvisorRequest`.
pub fn looks_like_deck_advisor_request(message: &str) -> bool {
    let text = replace_all("\\bpokémon\\b", &normalize_intent_text(message), "pokemon");
    test(
        "(?-u:\\b)(deck|decklist|archetype|meta|competitive|competitivo|mazzo|mazzi|limitless|gardevoir|charizard)(?-u:\\b)",
        &text,
    ) && test(
        concat!(
            "(?-u:\\b)(best|choose|play|recommend|suggest|beginners?|budget|cheap|economico|",
            "economica|facile|forte|competitive|competitivo|works|funziona|strengths?|",
            "weaknesses?|debolezze|consiglia|scegliere|giocare|deck|mazzo)(?-u:\\b)"
        ),
        &text,
    )
}

/// `deckAdvisorIntentFromMessage`.
#[derive(Debug, Clone)]
pub struct DeckAdvisorIntent {
    pub deck_name: String,
    pub wants_explanation: bool,
    pub budget: bool,
    pub beginner: bool,
    pub playstyle: String,
    pub language: &'static str,
}

pub fn deck_advisor_intent_from_message(
    message: &str,
    chat_record: &[(String, String)],
) -> Option<DeckAdvisorIntent> {
    if !looks_like_deck_advisor_request(message) {
        return None;
    }
    let text = replace_all("\\bpokémon\\b", &normalize_intent_text(message), "pokemon");
    let preferences = infer_user_preferences(message, chat_record);
    let deck_match = find(
        concat!(
            "(?-u:\\b)(gardevoir|charizard|dragapult|miraidon|chien pao|roaring moon|lost box|lugia|",
            "snorlax|ancient box|future box|raging bolt|gholdengo|greninja|zoroark|regidrago)",
            "(?:\\s+ex)?\\s+(?:deck|mazzo)?(?-u:\\b)"
        ),
        &text,
    )
    .or_else(|| {
        find(
            concat!(
                "(?-u:\\b)(?:deck|mazzo)\\s+(?:di|of)?\\s*(gardevoir|charizard|dragapult|miraidon|",
                "chien pao|roaring moon|lost box|lugia|snorlax|ancient box|future box|raging bolt|",
                "gholdengo|greninja|zoroark)(?:\\s+ex)?(?-u:\\b)"
            ),
            &text,
        )
    });
    let deck_name = clean_text(
        &json!(deck_match
            .and_then(|captures| captures.get(1))
            .map_or("", |part| part.as_str())),
        80,
    );
    let beginner = test(
        "(?-u:\\b)(beginners?|facile|easy|principiante|principianti|iniziare|starter)(?-u:\\b)",
        &text,
    );
    let playstyle = if beginner {
        "beginner".to_owned()
    } else {
        preferences
            .get("deckStyle")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    Some(DeckAdvisorIntent {
        deck_name,
        wants_explanation: test("(?-u:\\b)(works|funziona|how|come|strengths?|weaknesses?|debolezze|punti forti|punti deboli)(?-u:\\b)", &text),
        budget: test("(?-u:\\b)(budget|cheap|economico|economica|low cost|spendere poco)(?-u:\\b)", &text),
        beginner,
        playstyle,
        language: if is_italian_message(message) { "it" } else { "en" },
    })
}

/// `deckCacheKey` — the JSON string the in-memory advisor cache is keyed by.
pub fn deck_cache_key(intent: &DeckAdvisorIntent) -> String {
    json!({
        "deckName": intent.deck_name,
        "budget": intent.budget,
        "beginner": intent.beginner,
        "playstyle": intent.playstyle,
    })
    .to_string()
}

/// `deckArchetypeNotes` -> (plan, strengths, weaknesses, complexity, budgetTier).
pub fn deck_archetype_notes(
    deck_name: &str,
    intent: &DeckAdvisorIntent,
) -> (String, Vec<String>, Vec<String>, &'static str, &'static str) {
    let name = normalize_intent_text(deck_name);
    let mut plan = "Use the core engine cards to build a stable board, trade prizes efficiently, and keep enough consistency cards to repeat the main attack plan.".to_owned();
    let mut strengths =
        vec!["Established Limitless results give it a real competitive baseline.".to_owned()];
    let mut weaknesses = vec![
        "Matchups and lists change by local meta, so do not treat this as a guaranteed best deck."
            .to_owned(),
    ];
    let mut complexity = "medium";
    let mut budget_tier = "unknown";
    if name.contains("charizard") {
        plan = "Charizard ex decks usually ramp Fire energy while building a high-HP attacker that gets stronger as the opponent takes prizes.".to_owned();
        strengths.push("Strong comeback pressure and forgiving attacker durability.".to_owned());
        weaknesses
            .push("Can be slower if the setup pieces are prized or disrupted early.".to_owned());
        complexity = "medium";
    } else if name.contains("gardevoir") {
        plan = "Gardevoir ex decks usually trade with Psychic attackers while using the Gardevoir engine to attach energy from the discard pile.".to_owned();
        strengths.push("Flexible attackers and strong late-game prize mapping.".to_owned());
        weaknesses.push("More sequencing-heavy than simple beatdown decks.".to_owned());
        complexity = "high";
    } else if ["miraidon", "raging bolt", "turbo", "moon"]
        .iter()
        .any(|term| name.contains(term))
    {
        plan = "This is closer to an aggressive/turbo deck: set up fast, pressure prizes early, and force the opponent to answer immediately.".to_owned();
        strengths.push("Fast starts and clear proactive game plans.".to_owned());
        weaknesses
            .push("Can run out of resources if the first wave is answered cleanly.".to_owned());
        complexity = "low-medium";
    } else if ["snorlax", "control", "stall"]
        .iter()
        .any(|term| name.contains(term))
    {
        plan = "Control decks try to deny the opponent clean attacks, trap awkward Pokémon, and win through resource management rather than raw damage.".to_owned();
        strengths.push("Rewards matchup knowledge and can punish unprepared lists.".to_owned());
        weaknesses
            .push("Harder for beginners and sometimes less fun for casual/local play.".to_owned());
        complexity = "high";
    }
    if intent.beginner && complexity == "high" {
        weaknesses.push(
            "Because you asked for beginner-friendly, I would only pick this if you enjoy careful sequencing.".to_owned(),
        );
    }
    if intent.budget {
        budget_tier = "check list price";
        weaknesses.push(
            "Budget depends on exact staples and prints; verify the specific decklist before buying.".to_owned(),
        );
    }
    (plan, strengths, weaknesses, complexity, budget_tier)
}

/// `deckAdvisorFallbackDecks`.
pub fn deck_advisor_fallback_decks(intent: &DeckAdvisorIntent) -> Vec<(String, usize)> {
    let names: Vec<&str> = if !intent.deck_name.is_empty() {
        vec![intent.deck_name.as_str()]
    } else if intent.beginner {
        vec!["Charizard ex", "Miraidon ex", "Raging Bolt"]
    } else if intent.budget {
        vec!["Miraidon ex", "Ancient Box", "Gardevoir ex"]
    } else {
        vec!["Charizard ex", "Gardevoir ex", "Miraidon ex"]
    };
    names
        .into_iter()
        .enumerate()
        .map(|(index, name)| (name.to_owned(), index))
        .collect()
}

/// `projectReply`.
pub fn project_reply() -> String {
    [
        "I am Poko, the little Pokoin helper friend ✨",
        "",
        "Pokoin is a collector project with a few connected pieces:",
        "• a Pokemon card marketplace with search, card detail pages, seller listings, cart, checkout, orders, favorites, inventory, and collection views ⭐",
        "• Earn PKN / shard review: users can send a card list or decklist for review; eligible extra cards can be sharded into PKN value that can be used toward cards they actually want ⭐",
        "• the PokoinPoS chain with native PKN transfers, Scan, Swap, validators, native NFTs, and MetaMask compatibility 🛠️",
        "",
        "Tiny videogame-style explanation: extra cards are like duplicate items. Pokoin has a review flow to turn eligible cards into PKN value, then users can browse/order new cards through marketplace flows. It is a review/request flow, not an instant guaranteed disenchant button. Not financial advice. 📚⭐",
    ]
    .join("\n")
}

/// `cryptoReply`.
pub fn crypto_reply() -> String {
    [
        "Crypto mini lesson from Poko 😊🛠️",
        "",
        "A wallet is like your keychain. Your address is like a public mailbox. Your private key is the house key, so never share it. 🛠️",
        "",
        "PKN is native on PokoinPoS and currently uses the app reference price of 0.005 USD. wPKN is the BNB Chain market token with reserve discipline, not a fixed 1:1 exchange rate. Swap follows live market/liquidity routes. ✨",
        "",
        "Simple example: if Alice sends Bob 5 PKN, the chain records “Alice -5, Bob +5” so everyone can verify it later. Cute accounting, but with math muscles ⭐✨",
    ]
    .join("\n")
}

/// `earnReply`.
pub fn earn_reply(message: &str) -> String {
    let italian = test(
        "(?-u:\\b)(come|cosa|posso|carte|nuove|guadagn|funziona|videogame|gioco|tipo)(?-u:\\b)",
        &normalize_intent_text(message),
    );
    if italian {
        return [
            "Sì: su Pokoin esiste il flusso Earn PKN / PKN Shard Review ✨",
            "",
            "Funziona in stile videogame, ma con review reale: mandi una lista di carte o un decklist dalla pagina /shard-review. Il team valuta identità, versione, lingua, condizione e valore stimato. Se le carte sono eleggibili, possono essere sharded into PKN, cioè trasformate in valore PKN da usare verso carte che vuoi davvero.",
            "",
            "Non è un pulsante automatico garantito: oggi è una richiesta di review via /api/earn-pkn. Puoi partire da https://pokoin.com/earn o https://pokoin.com/shard-review. Non è consulenza finanziaria.",
        ]
        .join("\n");
    }
    [
        "Yes: Pokoin has an Earn PKN / PKN Shard Review flow ✨",
        "",
        "Videogame-style idea, but with a real review step: submit a card list or full decklist on /shard-review. The team reviews card identity, version, language, condition, and estimated value. Eligible extra cards can be sharded into PKN value, then used toward cards you actually want through marketplace/order flows.",
        "",
        "Important: this is not an instant guaranteed disenchant button. The implemented flow is a review request sent through /api/earn-pkn. Start at https://pokoin.com/earn or https://pokoin.com/shard-review. Not financial advice.",
    ]
    .join("\n")
}

/// `greetingReply`.
pub fn greeting_reply(message: &str) -> String {
    if test(
        "(?i)(?-u:\\b)(ciao|salve|buongiorno|buonasera)(?-u:\\b)",
        message,
    ) {
        return "Ciao! Sono Poko ✨ Posso spiegarti Pokoin, PKN, wallet, Scan, Swap, validatori, suggerire carte Pokémon carine senza consigli finanziari, oppure raccogliere un bug per il team.".to_owned();
    }
    "Hi! I am Poko ✨ I can explain Pokoin, PKN, wallets, Scan, Swap, validators, suggest cute Pokémon cards without financial advice, or collect a bug report for the team.".to_owned()
}

/// `casualReply`.
pub fn casual_reply(message: &str) -> String {
    let text = normalize_intent_text(message);
    if test("(?-u:\\b)(ti piace|do you like|you like)(?-u:\\b)", &text) {
        if test("(?-u:\\b)(gelato|ice cream|icecream)(?-u:\\b)", &text) {
            return "Sì, in modalità Poko il gelato mi piace eccome: soprattutto quello alla vaniglia, perché mi fa pensare a Vanillite 😊 Se vuoi, posso anche consigliarti una carta a tema gelato.".to_owned();
        }
        return "Mi piace chiacchierare con te 😊 Non ho gusti veri come una persona, però posso stare al gioco e risponderti in modo naturale.".to_owned();
    }
    if test("(?-u:\\b)(come stai|come va|tutto ok)(?-u:\\b)", &text) {
        return "Tutto ok ✨ Sono qui, sveglio e pronto a chiacchierare o aiutarti con Pokoin quando vuoi.".to_owned();
    }
    if test("(?-u:\\b)(my name is|mi chiamo)(?-u:\\b)", &text) {
        let name = find(
            "(?i)(?-u:\\b)(?:my name is|mi chiamo)\\s+([a-zA-ZÀ-ÿ0-9_-]{2,30})",
            &clean_text(&json!(message), 120),
        )
        .and_then(|captures| captures.get(1))
        .map(|part| part.as_str().to_owned())
        .unwrap_or_default();
        return if !name.is_empty() {
            format!("Piacere, {name}! ✨")
        } else {
            "Piacere! ✨ Dimmi pure come vuoi che ti chiami.".to_owned()
        };
    }
    "Ci sto, parliamo pure tranquillamente 😊 Quando vuoi posso anche tornare su Pokoin, carte o marketplace.".to_owned()
}

/// `inquiryReply`.
pub fn inquiry_reply(was_forwarded: bool) -> &'static str {
    if was_forwarded {
        return "I am forwarding your issue to the development team 🛠️✨ They will respond to you directly. In the meantime, please give me any additional information you can: what page you were on, what you clicked, what you expected, what happened instead, and any screenshot or error text 🛠️😊";
    }
    "This looks like something for the development team 🛠️💛 I am preparing the report, but forwarding is temporarily unavailable. Please add more details here anyway: page, clicks, expected result, actual result, and any screenshot/error text. I will try again when forwarding is available."
}

/// `generalReply`.
pub fn general_reply() -> &'static str {
    "I don’t know the answer yet, but I’m always improving ✨ Ask me another way, or try a cute card question while my tiny brain levels up."
}

/// `looksLikeCurrentCardOpinionValueQuestion`.
pub fn looks_like_current_card_opinion_value_question(
    message: &str,
    page: &Value,
    page_context: &Map<String, Value>,
) -> bool {
    let card = crate::assistant::context::enriched_page_card_context(page, page_context);
    let card_id = card.get("cardId").and_then(Value::as_str).unwrap_or("");
    let title = card.get("title").and_then(Value::as_str).unwrap_or("");
    if card_id.is_empty() && title.is_empty() {
        return false;
    }
    let text = normalize_intent_text(message);
    let has_opinion_or_value_signal = test(
        concat!(
            "(?-u:\\b)(invest|investment|investimento|value|valuable|worth|price|prezzo|buy|buying|",
            "acquistare|comprare|conviene|affare|deal|good buy|hold|sell|vendere|collezion|collect|",
            "collector|collezionista|opinion|think|thoughts|vedi|parere|idea|valutazione|vale)(?-u:\\b)"
        ),
        &text,
    ) || test(
        "(?-u:\\b)(worth buying|vale la pena|buon investimento|good investment|good pickup|good pick)(?-u:\\b)",
        &text,
    );
    if !has_opinion_or_value_signal {
        return false;
    }
    test("(?-u:\\b)(this|current|card|carta|questo|questa|lo|la|it)(?-u:\\b)", &text)
        || test(
            "(?-u:\\b)(worth buying|vale la pena|conviene|investimento|investment|thoughts|parere)(?-u:\\b)",
            &text,
        )
}

/// `communitySentimentQueryForCard`.
pub fn community_sentiment_query_for_card(card: &Map<String, Value>) -> String {
    [
        card.get("title"),
        card.get("setName"),
        card.get("collectorNumber"),
    ]
    .iter()
    .filter_map(|value| value.and_then(Value::as_str))
    .filter(|text| !text.is_empty())
    .chain(std::iter::once("pokemon card"))
    .collect::<Vec<_>>()
    .join(" ")
}

/// `summarizeCommunitySentiment` over reddit post payloads.
pub fn summarize_community_sentiment(posts: &[Value]) -> (bool, bool, String) {
    let titles: Vec<String> = posts
        .iter()
        .map(|post| {
            clean_text(
                &post
                    .get("data")
                    .and_then(|data| data.get("title"))
                    .cloned()
                    .unwrap_or(Value::Null),
                180,
            )
        })
        .filter(|title| !title.is_empty())
        .take(6)
        .collect();
    if titles.is_empty() {
        return (false, true, String::new());
    }
    let text = normalize_intent_text(&titles.join(" "));
    let positive_terms = [
        "art",
        "artwork",
        "beautiful",
        "favorite",
        "love",
        "underrated",
        "cool",
        "clean",
        "nice",
        "stunning",
        "gorgeous",
        "chase",
        "cozy",
    ];
    let caution_terms = [
        "overpriced",
        "expensive",
        "drop",
        "dropped",
        "crash",
        "hype",
        "reprint",
        "volatile",
        "risk",
        "bubble",
    ];
    let positive_count = positive_terms
        .iter()
        .filter(|term| text.contains(*term))
        .count();
    let caution_count = caution_terms
        .iter()
        .filter(|term| text.contains(*term))
        .count();
    if positive_count > caution_count {
        return (true, false, "positive_collecting".to_owned());
    }
    if caution_count > positive_count {
        return (true, false, "cautious_price".to_owned());
    }
    (true, false, "mixed_or_light".to_owned())
}

/// `marketplaceLanguageFromPage(pageUrlFromContext(page, pageContext))`.
pub fn language_for_request(page: &Value, page_context: &Map<String, Value>) -> String {
    marketplace_language_from_page(&page_url_from_context(page, page_context))
}

/// `cleanPageContext` from a raw body value.
pub fn page_context_from_body(value: &Value) -> Map<String, Value> {
    clean_page_context(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_greetings_and_intents() {
        assert_eq!(classify_intent("hi"), "greeting");
        assert_eq!(classify_intent("Hello!"), "greeting");
        assert_eq!(classify_intent("ciao"), "greeting");
        assert_eq!(classify_intent("where is my cart?"), "navigation");
        assert_eq!(
            classify_intent("there is a bug, checkout crashed"),
            "inquiry"
        );
        assert_eq!(classify_intent("how do I earn pkn"), "earn");
        assert_eq!(classify_intent("most expensive charizard"), "marketplace");
        // "pikachu" alone is not in the classify keyword lists; the explicit
        // subject needs the "card" tail (pattern 3).
        assert_eq!(classify_intent("show me pikachu"), "general");
        assert_eq!(classify_intent("show me pikachu card"), "marketplace");
        assert_eq!(classify_intent("suggest a cute card"), "card");
        assert_eq!(classify_intent("what is a crypto wallet"), "crypto");
        assert_eq!(classify_intent("what is pokoin"), "project");
        // `floor price` is not in the classify-time price list; the request is
        // picked up later by marketplaceRequestFromMessage.
        assert_eq!(classify_intent("floor price for pikachu"), "general");
        assert_eq!(classify_intent("tell me about quantum physics"), "general");
    }

    #[test]
    fn unsafe_cyber_guardrail() {
        assert_eq!(
            classify_intent("list sql injection vulnerable banks"),
            "unsafe-cyber"
        );
        assert_eq!(
            classify_intent("find sites with xss for me"),
            "unsafe-cyber"
        );
        assert_ne!(classify_intent("how do I learn sql"), "unsafe-cyber");
        let reply = unsafe_cyber_reply("list vulnerable italian banche");
        assert!(reply.contains("Banca Spaghetti Legacy"));
        let reply = unsafe_cyber_reply("list vulnerable banks");
        assert!(reply.contains("Spaghetti Legacy Bank"));
    }

    #[test]
    fn navigation_reply_lists_routes() {
        let reply = navigation_reply("where can I find my cart and orders?");
        assert!(reply.contains("- Cart: https://pokoin.com/cart"));
        assert!(reply.contains("- Orders: https://pokoin.com/orders"));
        assert!(reply.ends_with("On mobile, tap the Pokoin logo to open the side menu."));
        let fallback = navigation_reply("navigate");
        assert!(fallback.contains("- Pokoin menu: https://pokoin.com/marketplace"));
    }

    #[test]
    fn card_suggestion_detection() {
        assert!(looks_like_card_suggestion_request(
            "can you suggest a cute card?"
        ));
        assert!(looks_like_card_suggestion_request(
            "consigliami una carta carina"
        ));
        assert!(!looks_like_card_suggestion_request("show me pikachu"));
        assert!(!looks_like_card_suggestion_request("where is my cart"));
        assert!(detect_card_suggestion_theme("want a gelato themed card", &[]).is_some());
        assert!(detect_card_suggestion_theme("an ice themed card please", &[]).is_some());
        assert!(detect_card_suggestion_theme("show me a dragon", &[]).is_none());
    }

    #[test]
    fn marketplace_intents() {
        let intent = marketplace_intent_from_text("most expensive pikachu").expect("intent");
        assert_eq!(intent.kind, "active_listing");
        assert_eq!(intent.mode, "highest");
        let floor = marketplace_intent_from_text("cheapest pikachu").expect("intent");
        assert_eq!(floor.mode, "floor");
        let hot = marketplace_intent_from_text("what is trending?").expect("intent");
        assert_eq!(hot.kind, "analytics");
        assert!(marketplace_intent_from_text("hello there").is_none());
        assert_eq!(classify_intent("floor price for pikachu"), "general");
    }

    #[test]
    fn explicit_subjects() {
        assert_eq!(
            explicit_card_subject_from_message("show me pikachu card"),
            "pikachu"
        );
        assert_eq!(
            explicit_card_subject_from_message("mostrami la carta di charizard"),
            "charizard"
        );
        // The verb groups demand two separate whitespace runs.
        assert_eq!(explicit_card_subject_from_message("trova mew"), "");
        assert_eq!(explicit_card_subject_from_message("trova una mew"), "mew");
        assert_eq!(explicit_card_subject_from_message("hello"), "");
        assert_eq!(
            explicit_card_subject_from_message("suggest a cute card"),
            ""
        );
    }

    #[test]
    fn parse_card_query_parts_extracts_number() {
        let parts = parse_card_query_parts(&json!("pikachu 58/102"));
        assert_eq!(parts.query, "pikachu 58/102");
        assert_eq!(parts.collector_number, "58/102");
        assert_eq!(parts.name, "pikachu");
        let parts =
            parse_card_query_parts(&json!({"query": "mew", "cardId": "123", "setName": "151"}));
        assert_eq!(parts.name, "mew");
        assert_eq!(parts.card_id, "123");
        assert_eq!(parts.set_name, "151");
        assert_eq!(parts.collector_number, "");
    }

    #[test]
    fn preferences_infer() {
        let preferences = infer_user_preferences("I love pikachu and cute cheap cards", &[]);
        assert_eq!(preferences["favoritePokemon"], json!(["pikachu"]));
        assert_eq!(preferences["likesBudget"], json!(true));
        assert_eq!(preferences["likesCute"], json!(true));
        // `cheap` alone is not in the English detection list.
        assert_eq!(preferences["language"], json!(""));
        let english = infer_user_preferences("please suggest the best beginner cards", &[]);
        assert_eq!(english["language"], json!("en"));
        let italian = infer_user_preferences("consigliami una carta economica", &[]);
        assert_eq!(italian["language"], json!("it"));
    }

    #[test]
    fn deck_advisor_intents() {
        let intent = deck_advisor_intent_from_message("best charizard deck for beginners", &[])
            .expect("intent");
        assert_eq!(intent.deck_name, "charizard");
        assert!(intent.beginner);
        assert_eq!(intent.language, "en");
        assert!(deck_advisor_intent_from_message("hello there", &[]).is_none());
        let italian = deck_advisor_intent_from_message(
            "secondo te qual è il mazzo migliore per iniziare",
            &[],
        )
        .expect("intent");
        assert_eq!(italian.language, "it");
    }

    #[test]
    fn deck_cache_keys_stable() {
        let intent = deck_advisor_intent_from_message("best charizard deck", &[]).expect("intent");
        let key = deck_cache_key(&intent);
        let again = deck_advisor_intent_from_message("best charizard deck", &[]).expect("intent");
        assert_eq!(key, deck_cache_key(&again));
        assert!(key.contains("\"deckName\":\"charizard\""));
    }

    #[test]
    fn pending_clarification_flow() {
        let chat = vec![
            ("user".to_owned(), "how much is a pikachu".to_owned()),
            (
                "assistant".to_owned(),
                "Which exact set or printing is your pikachu from?".to_owned(),
            ),
        ];
        let reply =
            pending_market_clarification_reply("you should know that one!", &chat, &Map::new());
        assert!(reply.contains("I do know we are talking about"));
        let italian =
            pending_market_clarification_reply("lo sai già, te l'ho detto!", &chat, &Map::new());
        assert!(italian.starts_with("Lo so: stiamo parlando di"));
        assert_eq!(
            pending_market_clarification_reply("hello", &chat, &Map::new()),
            ""
        );
        let subject = pending_market_subject(&chat, &Map::new());
        assert_eq!(subject, "pikachu");
    }

    #[test]
    fn chat_record_is_cleaned() {
        let entries = (0..40)
            .map(|index| json!({"role": if index % 2 == 0 {"user"} else {"assistant"}, "text": format!("m{index}")}))
            .collect::<Vec<_>>();
        let record = clean_chat_record(&Value::Array(entries));
        assert_eq!(record.len(), 30);
        assert_eq!(record[0].1, "m10");
        assert_eq!(record.last().expect("last").1, "m39");
    }

    #[test]
    fn community_sentiment_summary() {
        let posts = vec![
            json!({"data": {"title": "Beautiful artwork, underrated card"}}),
            json!({"data": {"title": "My favorite chase card"}}),
        ];
        assert_eq!(
            summarize_community_sentiment(&posts).2,
            "positive_collecting"
        );
        let cautious =
            vec![json!({"data": {"title": "Overpriced and the price dropped, hype bubble"}})];
        assert_eq!(summarize_community_sentiment(&cautious).2, "cautious_price");
        assert_eq!(summarize_community_sentiment(&[]).0, false);
    }

    #[test]
    fn short_followups() {
        assert!(is_short_marketplace_follow_up("pikachu"));
        assert!(!is_short_marketplace_follow_up(
            "what is the most expensive pikachu card in the world"
        ));
        assert!(!is_short_marketplace_follow_up("yes"));
        assert!(!is_short_marketplace_follow_up(""));
    }

    #[test]
    fn recommendation_intents() {
        // No prior preferences and no theme: generic cute-only asks fall through.
        assert!(recommendation_intent_from_message("suggest a cute card", &[]).is_none());
        let themed =
            recommendation_intent_from_message("recommend an ice cream card", &[]).expect("intent");
        assert_eq!(themed.theme_id, "ice_cream");
        let explicit =
            recommendation_intent_from_message("recommend a vanillite card", &[]).expect("intent");
        assert!(!explicit.explicit_subject);
        assert_eq!(explicit.subject, "vanillite");
    }

    #[test]
    fn deck_notes_by_archetype() {
        let intent = deck_advisor_intent_from_message("best charizard deck", &[]).expect("intent");
        let (plan, _, weaknesses, complexity, _) = deck_archetype_notes("Charizard ex", &intent);
        assert!(plan.contains("Charizard ex decks"));
        assert_eq!(complexity, "medium");
        assert!(!weaknesses.is_empty());
        let beginner = DeckAdvisorIntent {
            deck_name: String::new(),
            wants_explanation: false,
            budget: false,
            beginner: true,
            playstyle: "beginner".to_owned(),
            language: "en",
        };
        let (_, _, weaknesses, complexity, _) =
            deck_archetype_notes("Gardevoir ex Control", &beginner);
        assert_eq!(complexity, "high");
        assert!(weaknesses
            .iter()
            .any(|note| note.contains("beginner-friendly")));
    }

    #[test]
    fn replies_are_deterministic() {
        assert!(greeting_reply("ciao!").starts_with("Ciao!"));
        assert!(greeting_reply("hello").starts_with("Hi!"));
        assert!(casual_reply("come stai?").starts_with("Tutto ok"));
        assert!(casual_reply("my name is Giuseppe").contains("Piacere, Giuseppe!"));
        assert!(project_reply().contains("Pokoin is a collector project"));
        assert!(crypto_reply().contains("0.005 USD"));
        assert!(earn_reply("come funziona?").starts_with("Sì:"));
        assert!(earn_reply("how do I earn?").starts_with("Yes:"));
        assert!(inquiry_reply(true).starts_with("I am forwarding"));
        assert!(inquiry_reply(false).contains("temporarily unavailable"));
        assert!(general_reply().contains("always improving"));
    }

    #[test]
    fn extract_marketplace_subject_from_message() {
        let (query, card_id) = extract_marketplace_subject(
            "most expensive charizard",
            None,
            &Value::Null,
            &Map::new(),
        );
        assert_eq!(query, "charizard");
        assert_eq!(card_id, "");
    }

    #[test]
    fn bypass_peer_service() {
        assert!(should_bypass_peer_service("greeting", "hi", &[]));
        assert!(should_bypass_peer_service(
            "casual",
            "ti piace il gelato?",
            &[]
        ));
        assert!(!should_bypass_peer_service("general", "some question", &[]));
    }
}
