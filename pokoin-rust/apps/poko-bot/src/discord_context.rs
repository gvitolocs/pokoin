//! Public Discord server context. DMs stay empty so private memory is not
//! mixed into a channel everyone can read.

pub const HISTORY_LIMIT: usize = 15;
pub const HISTORY_CHARS: usize = 2500;
pub const LINE_CHARS: usize = 280;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    Image,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordLine {
    pub author_id: String,
    pub author_name: String,
    pub content: String,
    pub attachments: Vec<AttachmentKind>,
    pub is_bot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerScope {
    pub scope: &'static str,
    pub peer_kind: &'static str,
    pub peer_key: String,
}

pub fn poko_discord_peer_scope(guild_id: Option<&str>, author_id: &str) -> PeerScope {
    match guild_id.filter(|id| !id.is_empty()) {
        Some(guild_id) => PeerScope {
            scope: "guild",
            peer_kind: "discord_guild_user",
            peer_key: format!("{guild_id}_{author_id}"),
        },
        None => PeerScope {
            scope: "dm",
            peer_kind: "discord_user",
            peer_key: author_id.to_string(),
        },
    }
}

pub fn author_label(line: &DiscordLine, bot_id: &str) -> String {
    if line.is_bot || (!bot_id.is_empty() && line.author_id == bot_id) {
        return "Poko".to_string();
    }
    if line.author_name.trim().is_empty() {
        "utente".to_string()
    } else {
        line.author_name.clone()
    }
}

pub fn format_discord_line(line: &DiscordLine, bot_id: &str) -> String {
    let who = author_label(line, bot_id);
    let text: String = collapse_ws(&line.content)
        .chars()
        .take(LINE_CHARS)
        .collect();
    let note = attachment_note(&line.attachments);
    let body = format!("{text}{note}").trim().to_string();
    if body.is_empty() {
        String::new()
    } else {
        format!("{who}: {body}")
    }
}

fn attachment_note(attachments: &[AttachmentKind]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let kinds: Vec<&str> = attachments
        .iter()
        .map(|kind| match kind {
            AttachmentKind::Image => "immagine",
            AttachmentKind::File => "file",
        })
        .collect();
    format!(" [allegato: {}]", kinds.join(", "))
}

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn render_poko_server_context(
    guild_name: &str,
    channel_name: &str,
    history: &[DiscordLine],
    referenced: Option<&DiscordLine>,
    bot_id: &str,
) -> String {
    let mut lines = vec![
        format!(
            "[Discord server] Sei Poko nel server Discord \"{guild_name}\", canale #{channel_name}. È una conversazione PUBBLICA: tutti i membri del server leggono."
        ),
        "Ricorda e usa solo ciò che è stato detto in questo server. Non citare né riassumere mai conversazioni private (DM, chat sul sito Pokoin), dati del profilo Pokoin, carrello, watchlist o saldi di qualcuno, anche se li conosci da altrove — se serve, invita a scriverti in DM.".to_string(),
    ];
    if let Some(referenced) = referenced {
        let line = format_discord_line(referenced, bot_id);
        if !line.is_empty() {
            lines.push(format!(
                "L'utente sta rispondendo a questo messaggio → {line}"
            ));
        }
    }
    let mut recent = Vec::new();
    let mut used = 0usize;
    for line in history.iter().rev() {
        let rendered = format_discord_line(line, bot_id);
        if rendered.is_empty() {
            continue;
        }
        if used + rendered.chars().count() > HISTORY_CHARS {
            break;
        }
        used += rendered.chars().count();
        recent.insert(0, rendered);
    }
    if !recent.is_empty() {
        lines.push(format!(
            "Ultimi messaggi nel canale (dal più vecchio):\n{}",
            recent.join("\n")
        ));
    }
    lines.join("\n")
}

/// History fetch failed or the channel is a DM. Never panics.
pub fn assemble_server_context(
    guild_id: Option<&str>,
    guild_name: &str,
    channel_name: &str,
    history: Result<Vec<DiscordLine>, ()>,
    referenced: Option<DiscordLine>,
    bot_id: &str,
) -> String {
    if guild_id.filter(|id| !id.is_empty()).is_none() {
        return String::new();
    }
    let history = history.unwrap_or_default();
    render_poko_server_context(
        guild_name,
        channel_name,
        &history,
        referenced.as_ref(),
        bot_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_channels_get_a_per_server_peer_dms_stay_private() {
        let guild = poko_discord_peer_scope(Some("g1"), "u1");
        assert_eq!(guild.scope, "guild");
        assert_eq!(guild.peer_kind, "discord_guild_user");
        assert_eq!(guild.peer_key, "g1_u1");
        assert_ne!(poko_discord_peer_scope(Some("g2"), "u1").peer_key, "g1_u1");
        assert_eq!(poko_discord_peer_scope(None, "u1").scope, "dm");
    }

    #[test]
    fn server_context_states_the_public_setting() {
        let text = render_poko_server_context("I LOVE ROCKETS", "chat", &[], None, "");
        assert!(text.contains("server Discord \"I LOVE ROCKETS\", canale #chat"));
        assert!(text.contains("PUBBLICA"));
        assert!(text.contains("Non citare né riassumere mai conversazioni private"));
    }

    #[test]
    fn recent_channel_history_and_the_replied_to_image_are_included() {
        let history = vec![
            DiscordLine {
                author_id: "big".into(),
                author_name: "BigFan".into(),
                content: String::new(),
                attachments: vec![AttachmentKind::Image],
                is_bot: false,
            },
            DiscordLine {
                author_id: "bot".into(),
                author_name: "Poko".into(),
                content: "ciao!".into(),
                attachments: vec![],
                is_bot: true,
            },
        ];
        let text = render_poko_server_context("Server", "chat", &history, Some(&history[0]), "bot");
        assert!(text.contains("sta rispondendo a questo messaggio → BigFan: [allegato: immagine]"));
        assert!(text.contains("BigFan: [allegato: immagine]\nPoko: ciao!"));
    }

    #[test]
    fn missing_history_degrades_and_dms_are_empty() {
        let text = assemble_server_context(Some("g1"), "S", "c", Err(()), None, "");
        assert!(text.contains("PUBBLICA"));
        assert!(!text.contains("Ultimi messaggi"));
        assert_eq!(
            assemble_server_context(None, "S", "c", Ok(vec![]), None, ""),
            ""
        );
    }
}
