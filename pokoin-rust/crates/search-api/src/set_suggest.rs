//! Catalog-backed set-only browse for the web suggest route.
use serde_json::Value;
use sqlx::PgPool;

pub fn set_prefix(query: &str) -> Option<String> {
    let q = query.trim().to_lowercase();
    let words: Vec<_> = q.split_whitespace().collect();
    if words.last()?.len() < 3 || q.contains(['%', '_', '\\']) {
        return None;
    }
    Some(q)
}

pub async fn set_hits(pool: &PgPool, query: &str) -> Result<Vec<Value>, sqlx::Error> {
    let Some(prefix) = set_prefix(query) else {
        return Ok(Vec::new());
    };
    let sql = r#"
      with expansion as (
        select name, nationality from public.pokoin_pokemon_expansions
        where lower(name) = $1 or ($2 and lower(name) like $1 || '%')
        order by (lower(name) = $1) desc, length(name), name limit 1
      )
      select jsonb_build_object(
        'card_id', c.card_id::text, 'name', c.name, 'card_number', c.card_number,
        'set_name', c.set_name, 'rarity', c.rarity,
        'cdn_image_url', coalesce(c.cdn_image_url, c.image_url, ''),
        'nationality', coalesce(e.nationality, ''))
      from expansion e join public.marketplace_search_candidates c on c.set_name = e.name
      where c.item_kind = 'single' and c.product_type = 'card'
      order by coalesce(nullif(c.set_order, 0),
          substring(c.card_number from '([0-9]{1,4})')::int, 2147483647),
        c.card_id asc limit 12
    "#;
    let allow_prefix = prefix.split_whitespace().count() > 1;
    sqlx::query_scalar(sql)
        .bind(prefix)
        .bind(allow_prefix)
        .fetch_all(pool)
        .await
}

pub fn merge_set_groups(hits: &[Value], ordinary: Vec<Value>, limit: usize) -> Vec<Value> {
    if hits.is_empty() {
        return ordinary;
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let single_cap = 12.min(if ordinary.is_empty() {
        limit
    } else {
        limit.saturating_sub(1)
    });
    for hit in hits.iter().take(single_cap) {
        for mut group in pokoin_search::group_suggest_hits(std::slice::from_ref(hit), 1, 1, "") {
            group["printings"][0]["item_kind"] = "single".into();
            group["printings"][0]["product_type"] = "card".into();
            if let Some(id) = group["printings"][0]["id"].as_str() {
                seen.insert(id.to_string());
            }
            out.push(group);
        }
    }
    for mut group in ordinary {
        if let Some(printings) = group.get_mut("printings").and_then(Value::as_array_mut) {
            printings.retain(|row| row["id"].as_str().is_none_or(|id| !seen.contains(id)));
            if !printings.is_empty() {
                out.push(group);
            }
        }
    }
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn set_query_adds_ordered_capped_singles_and_keeps_products() {
        let hits: Vec<_> = (1..=15).map(|n| json!({"card_id":(n*2).to_string(),"name":format!("Card {n}"),"card_number":format!("{n:03}"),"set_name":"Delta Reign"})).collect();
        let products = vec![json!({"name":"Delta Reign Booster Box", "printings":[{"id":"100"}]})];
        let groups = merge_set_groups(&hits, products, 20);
        assert_eq!(groups.len(), 13);
        assert_eq!(groups[0]["printings"][0]["number"], "001");
        assert_eq!(groups[0]["printings"][0]["item_kind"], "single");
        assert_eq!(groups[11]["printings"][0]["number"], "012");
        assert_eq!(groups[12]["name"], "Delta Reign Booster Box");
        assert_eq!(set_prefix("delta reign"), Some("delta reign".into()));
        assert_eq!(set_prefix("delta rei"), Some("delta rei".into()));
        let limited = merge_set_groups(
            &hits,
            vec![json!({"name":"Booster", "printings":[{"id":"100"}]})],
            8,
        );
        assert_eq!(limited.len(), 8);
        assert_eq!(limited[7]["name"], "Booster");
    }
    #[test]
    fn card_name_query_without_set_match_is_unchanged() {
        let groups = vec![json!({"name":"Meowscarada ex", "printings":[{"id":"836920"}]})];
        assert_eq!(merge_set_groups(&[], groups.clone(), 20), groups);
        assert_eq!(set_prefix("pika"), Some("pika".into()));
        assert!(set_prefix("pi").is_none());
    }
}
