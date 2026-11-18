use crate::{
    array, iso,
    model::{Completion, Provider, Reason},
    text,
};
use anyhow::Result;
use serde_json::{json, Value};

pub fn reporter_schema() -> Value {
    serde_json::from_str(include_str!("../assets/reporter-schema.json")).unwrap_or(Value::Null)
}
pub fn editor_schema() -> Value {
    serde_json::from_str(include_str!("../assets/editor-schema.json")).unwrap_or(Value::Null)
}
fn definitions() -> Value {
    serde_json::from_str(include_str!("../assets/templates.json")).unwrap_or(Value::Null)
}
pub fn type_ok(value: &Value, schema: &Value) -> bool {
    if let Some(options) = schema.get("anyOf") {
        return array(options).iter().any(|s| type_ok(value, s));
    }
    match text(schema, "type") {
        "null" => value.is_null(),
        "string" => {
            value.is_string()
                && (schema.get("enum").is_none() || array(&schema["enum"]).contains(value))
        }
        "integer" => value
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.fract() == 0.0),
        "boolean" => value.is_boolean(),
        "array" => value
            .as_array()
            .is_some_and(|a| a.iter().all(|v| type_ok(v, &schema["items"]))),
        "object" => value.as_object().is_some_and(|o| {
            o.keys().all(|k| schema["properties"].get(k).is_some())
                && array(&schema["required"])
                    .iter()
                    .filter_map(Value::as_str)
                    .all(|k| {
                        o.get(k)
                            .is_some_and(|v| type_ok(v, &schema["properties"][k]))
                    })
        }),
        _ => true,
    }
}
pub fn schema_errors(value: &Value, schema: &Value, at: &str) -> Vec<String> {
    if let Some(options) = schema.get("anyOf") {
        if array(options).iter().any(|s| type_ok(value, s)) {
            return vec![];
        }
        let branch = if value.is_object() && value["type"].is_string() {
            array(options)
                .iter()
                .find(|s| array(&s["properties"]["type"]["enum"]).contains(&value["type"]))
        } else {
            None
        };
        if value.is_object() && value["type"].is_string() {
            return branch
                .map(|s| schema_errors(value, s, &format!("{at}({})", text(value, "type"))))
                .unwrap_or_else(|| {
                    vec![format!("{at}: unknown type \"{}\"", text(value, "type"))]
                });
        }
        return vec![format!("{at}: does not match any allowed shape")];
    }
    let mut errors = Vec::new();
    match text(schema, "type") {
        "array" if value.is_array() => {
            for (i, v) in array(value).iter().enumerate() {
                errors.extend(schema_errors(v, &schema["items"], &format!("{at}[{i}]")));
            }
        }
        "object" if value.is_object() => {
            if let Some(o) = value.as_object() {
                for k in o.keys() {
                    if schema["properties"].get(k).is_none() {
                        errors.push(format!("{at}.{k}: not allowed"));
                    }
                }
            }
            for k in array(&schema["required"]).iter().filter_map(Value::as_str) {
                if let Some(v) = value.get(k) {
                    errors.extend(schema_errors(
                        v,
                        &schema["properties"][k],
                        &format!("{at}.{k}"),
                    ));
                } else {
                    errors.push(format!("{at}.{k}: missing"));
                }
            }
        }
        "string"
            if value.is_string()
                && schema.get("enum").is_some()
                && !array(&schema["enum"]).contains(value) =>
        {
            errors.push(format!(
                "{at}: \"{}\" is not one of {}",
                value.as_str().unwrap_or(""),
                array(&schema["enum"])
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        _ if !type_ok(value, schema) => {
            errors.push(format!("{at}: expected {}", text(schema, "type")))
        }
        _ => {}
    }
    errors
}
pub fn coerce(value: &Value, schema: &Value) -> Value {
    if let Some(options) = schema.get("anyOf") {
        if value.is_object() && value["type"].is_string() {
            if let Some(s) = array(options).iter().find(|s| {
                array(&s["properties"]["type"]["enum"])
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|t| t.eq_ignore_ascii_case(text(value, "type")))
            }) {
                return coerce(value, s);
            }
        }
        if let Some(s) = array(options)
            .iter()
            .find(|s| text(s, "type") != "null" && type_ok(&coerce(value, s), s))
        {
            return coerce(value, s);
        }
        return value.clone();
    }
    match text(schema, "type") {
        "string"
            if value.is_string()
                && schema.get("enum").is_some()
                && !array(&schema["enum"]).contains(value) =>
        {
            array(&schema["enum"])
                .iter()
                .find(|s| {
                    s.as_str().is_some_and(|s| {
                        s.eq_ignore_ascii_case(value.as_str().unwrap_or("").trim())
                    })
                })
                .cloned()
                .unwrap_or_else(|| value.clone())
        }
        "array" if value.is_array() => json!(array(value)
            .iter()
            .map(|v| coerce(v, &schema["items"]))
            .collect::<Vec<_>>()),
        "object" if value.is_object() => {
            let mut out = serde_json::Map::new();
            if let Some(props) = schema["properties"].as_object() {
                for (k, s) in props {
                    if let Some(v) = value.get(k) {
                        out.insert(k.clone(), coerce(v, s));
                    } else if array(&s["anyOf"]).iter().any(|s| text(s, "type") == "null") {
                        out.insert(k.clone(), Value::Null);
                    }
                }
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}
pub fn normalize_draft(value: &Value) -> Value {
    if !value.is_object() {
        return value.clone();
    }
    let mut out = value.clone();
    let defs = definitions();
    let def = &defs[text(value, "template")];
    if def.is_object() {
        out["articleType"] = def["articleType"].clone();
        let contract: Value =
            serde_json::from_str(include_str!("../assets/contract.json")).unwrap_or(Value::Null);
        if !array(&contract["SECTIONS"]).contains(&out["section"]) {
            out["section"] = def["defaultSection"].clone();
        }
    }
    let image = &value["image_plan"];
    let hero = if ["catalog_card", "source_image", "fallback"].contains(&text(image, "hero")) {
        text(image, "hero")
    } else {
        "fallback"
    };
    out["image_plan"] = json!({"hero":hero,"heroCardId":image.get("heroCardId").filter(|v|v.is_string()).unwrap_or(&Value::Null),"gallery":array(&image["gallery"]).iter().filter(|v|v.is_string()).cloned().collect::<Vec<_>>()});
    if value["related_entities"].is_array() {
        out["related_entities"] = json!(array(&value["related_entities"])
            .iter()
            .filter(
                |e| ["card", "set", "pokemon", "artist", "product"].contains(&text(e, "type"))
                    && e["name"].is_string()
            )
            .collect::<Vec<_>>());
    }
    for k in ["telegram", "discord", "x", "notes"] {
        if !out[k].is_string() {
            out[k] = json!("");
        }
    }
    for (k, kind) in [
        ("analysis_required", "analysis"),
        ("market_module_required", "market"),
    ] {
        if !out[k].is_boolean() {
            out[k] = json!(array(&value["blocks"])
                .iter()
                .any(|b| text(b, "type") == kind));
        }
    }
    out
}
pub fn collect_refs(block: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    let mut push = |v: &Value| {
        if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
            refs.push(s.into());
        }
    };
    for k in ["sourceIds", "supportedBy", "contradictedBy"] {
        for v in array(&block[k]) {
            push(v);
        }
    }
    for k in ["primarySourceId", "sourceId"] {
        push(&block[k]);
    }
    for item in array(&block["items"]) {
        for v in array(&item["sourceIds"]) {
            push(v);
        }
    }
    for row in array(&block["rows"]) {
        for say in array(&row["says"]) {
            push(&say["sourceId"]);
        }
    }
    refs
}
pub fn validate_reporter(value: &Value, valid_templates: &[String], pack: &Value) -> Vec<String> {
    let schema = reporter_schema();
    if !type_ok(value, &schema) {
        return schema_errors(value, &schema, "$")
            .into_iter()
            .take(25)
            .collect();
    }
    let mut errors = Vec::new();
    let template = text(value, "template");
    if !value["template"].is_null() && !valid_templates.iter().any(|t| t == template) {
        errors.push(format!(
            "template \"{template}\" is not one of the valid templates: {}",
            valid_templates.join(", ")
        ));
    }
    let blocks = array(&value["blocks"]);
    if !value["template"].is_null() && blocks.is_empty() {
        errors.push("blocks must not be empty".into());
    }
    let defs = definitions();
    let def = &defs[template];
    let types: Vec<_> = blocks.iter().map(|b| text(b, "type")).collect();
    if def.is_object() {
        for required in array(&def["required"]).iter().filter_map(Value::as_str) {
            if !types.contains(&required) {
                errors.push(format!(
                    "template {template} requires a \"{required}\" block"
                ));
            }
        }
        let mut unique = std::collections::HashSet::new();
        for kind in &types {
            if unique.insert(*kind)
                && !["paragraph", "heading", "update_note", "quote", "list"].contains(kind)
                && !array(&def["required"]).contains(&json!(kind))
                && !array(&def["optional"]).contains(&json!(kind))
            {
                errors.push(format!(
                    "template {template} does not allow a \"{kind}\" block; remove it"
                ));
            }
        }
        let present: Vec<_> = array(&def["required"])
            .iter()
            .filter_map(Value::as_str)
            .filter(|t| types.contains(t))
            .collect();
        for pair in present.windows(2) {
            if types.iter().position(|t| *t == pair[1]) < types.iter().position(|t| *t == pair[0]) {
                errors.push(format!(
                    "template {template}: \"{}\" must come after \"{}\"",
                    pair[1], pair[0]
                ));
            }
        }
        if value["articleType"] != def["articleType"] {
            errors.push(format!(
                "template {template} uses articleType \"{}\"",
                text(def, "articleType")
            ));
        }
    }
    let contains =
        |rows: &Value, key: &str, id: &str| array(rows).iter().any(|s| text(s, key) == id);
    for (i, b) in blocks.iter().enumerate() {
        let kind = text(b, "type");
        for id in collect_refs(b) {
            if !contains(&pack["sourceList"], "id", &id) {
                errors.push(format!("blocks[{i}] ({kind}): unknown source id \"{id}\""));
            }
        }
        for (kind, key, rows, id_key, label) in [
            (
                "chart",
                "chartId",
                &pack["market"]["charts"],
                "id",
                "chartId",
            ),
            (
                "related_card",
                "cardId",
                &pack["related"]["cards"],
                "cardId",
                "cardId",
            ),
            (
                "related_set",
                "slug",
                &pack["related"]["sets"],
                "slug",
                "set slug",
            ),
        ] {
            if text(b, "type") == kind && !contains(rows, id_key, text(b, key)) {
                errors.push(format!(
                    "blocks[{i}]: {label} \"{}\" is not in the evidence pack",
                    text(b, key)
                ));
            }
        }
        if kind == "market" && pack["market"]["sufficient"] != true {
            errors.push(format!(
                "blocks[{i}]: market block used but no sufficient Pokoin market module exists"
            ));
        }
        if kind == "gallery" {
            for id in array(&b["imageIds"]).iter().filter_map(Value::as_str) {
                if !contains(&pack["images"], "id", id) {
                    errors.push(format!(
                        "blocks[{i}]: image \"{id}\" is not in the evidence pack"
                    ));
                }
            }
        }
    }
    if !value["first_reported_source_id"].is_null()
        && !contains(
            &pack["sourceList"],
            "id",
            text(value, "first_reported_source_id"),
        )
    {
        errors.push("first_reported_source_id is not a pack source id".into());
    }
    errors
}
pub fn validate_editor(value: &Value) -> Vec<String> {
    if !type_ok(value, &editor_schema()) {
        return schema_errors(value, &editor_schema(), "$")
            .into_iter()
            .take(25)
            .collect();
    }
    if value["verdict"] == "revise" && value["revised"].is_null() {
        return vec!["verdict \"revise\" requires revised content".into()];
    }
    vec![]
}
fn project(value: &Value, fields: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for k in fields {
        if let Some(v) = value.get(k) {
            out.insert((*k).into(), v.clone());
        }
    }
    Value::Object(out)
}
fn or<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|k| v.get(k))
        .find(|v| !v.is_null() && **v != false && **v != "")
}
pub fn trimmed_pack(pack: &Value) -> Value {
    let game = crate::game(pack);
    let games: Value =
        serde_json::from_str(include_str!("../assets/games.json")).unwrap_or(Value::Null);
    let row = array(&games).iter().find(|r| text(r, "id") == game);
    let name = row
        .and_then(|r| or(r, &["short", "name"]))
        .cloned()
        .unwrap_or_else(|| json!(game));
    let sources: Vec<_> = array(&pack["sourceList"])
        .iter()
        .map(|s| {
            let mut out = project(s, &["id", "outlet", "tier"]);
            out["title"] = or(s, &["title", "headline"]).cloned().unwrap_or(json!(""));
            out["url"] = or(s, &["url", "link"]).cloned().unwrap_or(Value::Null);
            out["publishedAt"] = or(s, &["publishedAt"]).cloned().unwrap_or(Value::Null);
            out
        })
        .collect();
    let market = if pack["market"].is_object() {
        let m = &pack["market"];
        json!({"sufficient":m["sufficient"]==true,"subject":or(&m["subject"],&["name"]).cloned().unwrap_or(Value::Null),
            "window":if m["window"].is_object(){json!(format!("{} to {}",text(&m["window"],"from"),text(&m["window"],"to")))}else{Value::Null},
            "metrics":array(&m["metrics"]).iter().map(|v|project(v,&["id","label","measurement"])).collect::<Vec<_>>(),
            "charts":array(&m["charts"]).iter().map(|v|project(v,&["id","title","measurement"])).collect::<Vec<_>>()})
    } else {
        Value::Null
    };
    let entities = or(pack, &["resolvedEntities", "pokoinEntities"])
        .map(array)
        .unwrap_or(&[]);
    json!({"canonicalStoryId":or(pack,&["canonicalStoryId","storyId"]).cloned().unwrap_or(Value::Null),"game":game,"gameName":name,
        "summaryOfEvent":or(pack,&["summaryOfEvent","topic"]).cloned().unwrap_or(json!("")),"status":or(pack,&["status"]).cloned().unwrap_or(Value::Null),"angle":or(pack,&["angle"]).cloned().unwrap_or(Value::Null),
        "sourceList":sources,"claimLedger":array(&pack["claimLedger"]).iter().map(|v|project(v,&["claim","kind","subject","value","variants","supportedBy","contradictedBy","primarySourceId","confidence"])).collect::<Vec<_>>(),
        "conflicts":array(&pack["conflicts"]).iter().map(|c|c["summary"].clone()).collect::<Vec<_>>(),
        "confirmedClaims":pack.get("confirmedClaims").unwrap_or(&json!([])),"pressClaims":array(&pack["pressClaims"]).iter().take(10).collect::<Vec<_>>(),
        "unconfirmedClaims":pack.get("unconfirmedClaims").unwrap_or(&json!([])),"dates":pack.get("dates").unwrap_or(&json!([])),"numbers":pack.get("numbers").unwrap_or(&json!([])),
        "entities":entities.iter().filter(|v|v["resolved"]==true).map(|v|project(v,&["type","name","pokoinId"])).collect::<Vec<_>>(),
        "isUpdate":pack["isUpdate"]==true,"previousCoverage":or(pack,&["previousCoverage"]).cloned().unwrap_or(Value::Null),"market":market,
        "related":{"cards":array(&pack["related"]["cards"]).iter().map(|v|project(v,&["cardId","name","setName","number"])).collect::<Vec<_>>(),"sets":array(&pack["related"]["sets"]).iter().map(|v|project(v,&["slug","name"])).collect::<Vec<_>>()},
        "images":array(&pack["images"]).iter().map(|v|project(v,&["id","alt","origin"])).collect::<Vec<_>>()})
}
pub fn reporter_request(
    pack: &Value,
    hints: &Value,
    templates: &[String],
    memory: &str,
    previous: Option<&Value>,
    now: i64,
    strict: bool,
) -> Value {
    let mut out: Value = serde_json::from_str(include_str!("../assets/reporter-request.json"))
        .unwrap_or(Value::Null);
    let trimmed = trimmed_pack(pack);
    out["instructions"][5] = json!(format!(
        "This is {} news: use that game's own terminology.",
        text(&trimmed, "gameName")
    ));
    if previous.is_some() {
        if let Some(instructions) = out["instructions"].as_array_mut() {
            let end = instructions.pop();
            for line in ["previous_article is already published at a permanent URL. Revise it: keep what is still true, change what the new evidence changes, keep the same template unless the evidence no longer fits it.","Start blocks with one update_note block (at = now) stating in one sentence what changed since the previous version.","If the previous version stated something the evidence now shows was wrong, say so plainly in that update note."]{instructions.push(json!(line));}
            if let Some(end) = end {
                instructions.push(end);
            }
        }
    }
    out["validTemplates"] = json!(templates);
    out["hints"] = hints.clone();
    out["reporter_memory"] = json!(memory);
    out["now"] = json!(iso(now));
    out["previous_article"] = previous
        .map(|p| {
            project(
                p,
                &["template", "headline", "dek", "blocks", "datePublished"],
            )
        })
        .unwrap_or(Value::Null);
    out["evidence_pack"] = trimmed;
    out["availableModules"] = json!({"market":pack["market"]["sufficient"]==true,
        "charts":array(&pack["market"]["charts"]).iter().map(|v|&v["id"]).collect::<Vec<_>>(),
        "relatedCards":array(&pack["related"]["cards"]).iter().map(|v|&v["cardId"]).collect::<Vec<_>>(),
        "relatedSets":array(&pack["related"]["sets"]).iter().map(|v|&v["slug"]).collect::<Vec<_>>(),
        "galleryImages":array(&pack["images"]).iter().map(|v|&v["id"]).collect::<Vec<_>>()});
    if !strict {
        out["output_schema"] = reporter_schema();
        out["output_rules"]=json!(["Every timeline item and update_note needs \"at\" as an ISO-8601 date (YYYY-MM-DD or full timestamp) taken from the evidence.","Every listed key is required; use null where the schema allows it."]);
    }
    out
}
pub fn editor_request(pack: &Value, draft: &Value, strict: bool) -> Value {
    let mut out: Value =
        serde_json::from_str(include_str!("../assets/editor-request.json")).unwrap_or(Value::Null);
    out["evidence_pack"] = trimmed_pack(pack);
    out["draft"] = project(
        draft,
        &[
            "template",
            "headline",
            "dek",
            "articleType",
            "section",
            "blocks",
        ],
    );
    if !strict {
        out["output_schema"] = editor_schema();
    }
    out
}
async fn generate_repair(
    provider: &Provider,
    pass: &str,
    user: &Value,
    pack: &Value,
    templates: &[String],
) -> Result<Value> {
    let schema = if pass == "editor" {
        editor_schema()
    } else {
        reporter_schema()
    };
    let system = if pass == "editor" {
        include_str!("../assets/editor-system.txt")
    } else {
        include_str!("../assets/reporter-system.txt")
    };
    let mut request = user.clone();
    let mut errors: Vec<String> = Vec::new();
    for attempt in 0..2 {
        let (value, previous, checked) = match provider
            .generate(
                if attempt == 0 { pass } else { "repair" },
                system,
                &request.to_string(),
                &schema,
            )
            .await?
        {
            Completion::Ready { json, .. } => {
                let mut value = coerce(&json, &schema);
                if pass != "editor" {
                    value = coerce(&normalize_draft(&value), &schema);
                }
                let checked = if pass == "editor" {
                    validate_editor(&value)
                } else {
                    validate_reporter(&value, templates, pack)
                };
                (value, None, checked)
            }
            // claude.js:564 — an unparseable text block is the one repairable failure.
            Completion::Failed(failure) if failure.reason == Reason::Malformed => (
                Value::Null,
                Some(json!(failure.raw.chars().take(20000).collect::<String>())),
                vec!["response was not valid JSON".to_owned()],
            ),
            // claude.js:563 — every other reason is fatal, before any repair call.
            Completion::Failed(failure) => {
                return Ok(json!({"ok":false,"reason":failure.reason.as_str(),"errors":[]}));
            }
        };
        errors = checked;
        if errors.is_empty() {
            return Ok(json!({"ok":true,"json":value}));
        }
        if attempt == 0 {
            request = json!({"task":"repair","errors":errors,"previous":previous.unwrap_or_else(||value.clone()),"schema_reminder":"Return only one JSON object matching the schema. Fix every listed error; change nothing else.","original_request":user});
            if !provider.strict {
                request["output_schema"] = schema.clone();
            }
        }
    }
    // claude.js:581 — a draft that still fails after repair is reported malformed.
    Ok(json!({"ok":false,"reason":"malformed","errors":errors}))
}
pub async fn run_passes(
    provider: &Provider,
    pack: &Value,
    hints: &Value,
    templates: &[String],
    memory: &str,
    now: i64,
) -> Result<Value> {
    let user = reporter_request(pack, hints, templates, memory, None, now, provider.strict);
    let drafted = generate_repair(provider, "reporter", &user, pack, templates).await?;
    if drafted["ok"] != true {
        // claude.js:669 — a failed draft carries its reason up unchanged.
        return Ok(drafted);
    }
    let draft = drafted["json"].clone();
    if draft["template"].is_null() {
        return Ok(json!({"ok":true,"skip":true,"reason":"no_template"}));
    }
    let edited = generate_repair(
        provider,
        "editor",
        &editor_request(pack, &draft, provider.strict),
        pack,
        templates,
    )
    .await?;
    if edited["ok"] != true {
        // claude.js:694 — an editor call failure surfaces as editor_<reason>.
        return Ok(
            json!({"ok":false,"reason":format!("editor_{}",text(&edited,"reason")),"errors":edited["errors"].clone(),"draft":draft}),
        );
    }
    let editor = edited["json"].clone();
    let mut final_draft = draft.clone();
    let mut verdict = text(&editor, "verdict").to_owned();
    let mut reason = editor["reason"].clone();
    if verdict == "revise" {
        for key in ["headline", "dek", "blocks"] {
            final_draft[key] = editor["revised"][key].clone();
        }
        // claude.js:648-663: a revision that breaks the reporter contract is a
        // rejection, and its first three errors become the editor's reason.
        let errors = validate_reporter(&final_draft, &[text(&draft, "template").into()], pack);
        if !errors.is_empty() {
            verdict = "reject".into();
            reason = json!(format!(
                "editor revision failed validation: {}",
                errors.into_iter().take(3).collect::<Vec<_>>().join("; ")
            ));
        }
    }
    let editor = json!({"verdict":verdict,"reason":reason,"issues":editor["issues"]});
    Ok(if verdict == "reject" {
        // claude.js:699-706
        json!({"ok":false,"reason":"editor_rejected","draft":draft,"editor":editor,"finalDraft":Value::Null})
    } else {
        json!({"ok":true,"draft":draft,"editor":editor,"finalDraft":final_draft})
    })
}
