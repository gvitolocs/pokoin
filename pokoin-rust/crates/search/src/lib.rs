#![recursion_limit = "256"]

mod page;
mod powersort;
mod redis_query;
mod suggest;

pub use page::{
    local_name_score, page_body, print_matches, rank_rows, react_card, SearchCandidate, SearchRow,
};

pub use redis_query::redis_search_query;
pub use suggest::{
    assemble_pokemon_suggest, catalog_sql_needed, clean_print_language, clean_text, empty_suggest,
    group_suggest_hits, parse_limit, suggest_meili_hit_limit, SuggestHitPage, SuggestParts,
};

pub use page::has_collector;
