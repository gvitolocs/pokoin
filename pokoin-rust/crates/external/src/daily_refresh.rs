//! Native global CardTrader snapshot refresh. No request-time JS or subprocess.
use std::collections::HashSet;
use axum::http::{HeaderMap, Uri};
use serde_json::{json, Value};
use sqlx::Row;
use crate::{error::{ApiError, ApiResult, header_value}, state::DomainState, routes::util::query_first};
const MAX_IDS: usize = 100_000;
#[derive(Clone, Debug)]
pub struct Options {
    pub dry_run: bool, pub by_blueprint: bool, pub complete_book: bool,
    pub finalize: bool, pub record_asks: bool, pub archive_missing: bool,
    pub max_blueprints: usize, pub max_products: usize, pub max_expansions: usize,
    pub request_delay_ms: u64, pub blueprint_batch_size: usize, pub blueprint_concurrency: usize,
    pub expansion_concurrency: usize, pub persist_concurrency: usize, pub refresh_batch_blueprints: usize,
    pub removed_day: String, pub blueprint_ids: Vec<i64>, pub expansion_ids: Vec<i64>,
    pub catalog_ids: Vec<i64>, pub min_expansion: Option<i64>, pub shard_count: i64, pub shard_index: i64,
    pub language: String,
}
fn js_number(value: &Value) -> f64 {
    match value { Value::Null=>0.0, Value::Bool(b)=>if *b {1.0}else{0.0},
        Value::Number(n)=>n.as_f64().unwrap_or(f64::NAN),
        Value::String(s)=>if s.trim().is_empty(){0.0}else{s.trim().parse().unwrap_or(f64::NAN)}, _=>f64::NAN }
}
fn int(value: &Value) -> Option<i64> {
    if value.is_null() || value.as_str()==Some("") { return None; }
    let n=js_number(value); if n.is_finite() && n.fract()==0.0 && n.abs()<=9_007_199_254_740_991.0 {Some(n as i64)} else {None}
}
fn text(value: &Value, max: usize) -> String {
    match value { Value::String(s)=>s.trim().chars().take(max).collect(), Value::Number(n)=>n.to_string(),Value::Bool(true)=>"true".into(), _=>String::new() }
}
fn flag(value: &Value, fallback: bool) -> bool {
    if value==&json!(true)||value==&json!("true")||value==&json!("1")||value==&json!(1) {true}
    else if value==&json!(false)||value==&json!("false")||value==&json!("0")||value==&json!(0) {false} else {fallback}
}
fn unique(values: impl IntoIterator<Item=i64>) -> Vec<i64> {
    let mut seen=HashSet::new(); values.into_iter().filter(|n| *n>0 && seen.insert(*n)).collect()
}
fn ids(value: &Value) -> Vec<i64> {
    if let Some(rows)=value.as_array(){unique(rows.iter().filter_map(int))}
    else {unique(text(value,usize::MAX).split(',').filter_map(|s| int(&json!(s.trim()))))}
}
fn bounded(value: &Value, fallback: usize, min: usize, max: usize) -> usize {
    let n=js_number(value); if n.is_finite(){(n.trunc().max(min as f64).min(max as f64)) as usize}else{fallback}
}
pub fn request_options(uri: &Uri, body: &Value) -> Options {
    let get=|keys: &[&str]| {
        // body[name] ?? URLSearchParams.get(name), then aliases via ??.
        for key in keys {
            if let Some(v)=body.get(*key).filter(|v| !v.is_null()) { return v.clone(); }
            if let Some(v)=query_first(uri,key) { return json!(v); }
        }
        Value::Null
    };
    let dry=flag(&get(&["dryRun"]),false);
    let by=flag(&get(&["byBlueprint","by_blueprint"]),false);
    let complete=by||flag(&get(&["completeBook","complete_book"]),false);
    let mut blue=ids(&get(&["blueprintIds","blueprint_ids"]));
    if let Some(id)=int(&get(&["blueprintId","blueprint_id"])){blue.insert(0,id);}
    let mut expansions=ids(&get(&["expansionIds","expansion_ids"]));
    if let Some(id)=int(&get(&["expansionId","expansion_id"])){expansions.insert(0,id);}
    let removed=text(&get(&["removedDay"]),20);
    let removed=if regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").map(|re|re.is_match(&removed)).unwrap_or(false){removed}
      else {crate::time_util::iso_from_ms(crate::time_util::now_ms()-86_400_000).chars().take(10).collect()};
    Options{
        dry_run:dry,by_blueprint:by,complete_book:complete,finalize:flag(&get(&["finalize"]),!dry),
        record_asks:flag(&get(&["recordAskObservations","record_ask_observations"]),false),
        archive_missing:flag(&get(&["archiveMissing"]),!dry),
        max_blueprints:bounded(&get(&["maxBlueprints","maxBlueprintsPerRun"]),100_000,1,MAX_IDS),
        max_products:bounded(&get(&["maxProducts"]),if complete{20_000_000}else{1_000_000},1,20_000_000),
        max_expansions:bounded(&get(&["maxExpansions","max_expansions"]),if dry && expansions.is_empty() && blue.is_empty(){1}else{10_000},1,10_000),
        request_delay_ms:bounded(&get(&["requestDelayMs","request_delay_ms"]),200,0,10_000) as u64,
        blueprint_batch_size:bounded(&get(&["blueprintBatchSize","blueprint_batch_size","blueprint-batch-size"]),100,1,1000),
        blueprint_concurrency:bounded(&get(&["blueprintConcurrency","blueprint_concurrency","blueprint-concurrency"]),1,1,50),
        expansion_concurrency:bounded(&get(&["expansionConcurrency","expansion_concurrency","expansion-concurrency"]),1,1,16),
        persist_concurrency:bounded(&get(&["persistConcurrency","persist_concurrency","persist-concurrency"]),1,1,4),
        refresh_batch_blueprints:bounded(&get(&["refreshBatchBlueprints","refresh_batch_blueprints","refresh-batch-blueprints"]),0,0,10_000),
        removed_day:removed,blueprint_ids:unique(blue).into_iter().take(MAX_IDS).collect(),expansion_ids:unique(expansions).into_iter().take(10_000).collect(),
        catalog_ids:ids(&get(&["catalogBlueprintIds","catalog_blueprint_ids"])),
        min_expansion:int(&get(&["minExpansionId","min_expansion_id","min-expansion-id"])),
        shard_count:bounded(&get(&["expansionShardCount","expansion_shard_count","shard-count","shardCount"]),1,1,8) as i64,
        shard_index:bounded(&get(&["expansionShardIndex","expansion_shard_index","shard-index","shardIndex"]),0,0,7) as i64,
        language:text(&get(&["language"]),8),
    }
}
fn equal_secret(a: &str,b: &str)->bool {
    if a.is_empty() || a.len()!=b.len(){return false;}
    a.bytes().zip(b.bytes()).fold(0u8,|diff,(x,y)|diff|(x^y))==0
}
pub fn authorize(headers: &HeaderMap)->ApiResult<()> {
    let secrets:Vec<String>=["CARDTRADER_DAILY_LISTINGS_SECRET","CARDTRADER_DAILY_REFRESH_SECRET","CRON_SECRET"].iter()
        .filter_map(|key|std::env::var(key).ok()).map(|v|v.trim().chars().take(500).collect::<String>()).filter(|v|!v.is_empty()).collect();
    if secrets.is_empty(){return Err(ApiError::new(503,"CardTrader daily refresh secret is not configured.").with_code("CARDTRADER_REFRESH_SECRET_MISSING"));}
    let custom=header_value(headers,"x-cardtrader-refresh-secret");
    let authorization=header_value(headers,"authorization");
    let bearer=if authorization.to_lowercase().starts_with("bearer "){authorization.get(7..).unwrap_or("").trim()}else{""};
    let supplied=if custom.trim().is_empty(){bearer.to_string()}else{custom.trim().chars().take(500).collect()};
    if secrets.iter().any(|secret|equal_secret(&supplied,secret)){Ok(())}else{Err(ApiError::new(401,"CardTrader daily refresh access denied."))}
}
fn pick<'a>(v:&'a Value,keys:&[&str])->&'a Value { keys.iter().find_map(|key|v.get(*key).filter(|v|!v.is_null())).unwrap_or(&Value::Null) }
fn first(values: &[&Value],max:usize)->String { values.iter().map(|v|text(v,max)).find(|s|!s.is_empty()).unwrap_or_default() }
fn truthy(v:&Value)->bool { v==&json!(true)||v==&json!(1)||["true","1","yes"].contains(&text(v,20).to_lowercase().as_str()) }
fn comment(value:&str)->String {
    let mut output=value.chars().take(500).collect::<String>();
    for pattern in [r"(?is)<script\b[^>]*>.*?</script>",r"(?is)<style\b[^>]*>.*?</style>",r"<[^>]*>",r"[\x00-\x1f\x7f]+",r"\s+"] {
        if let Ok(re)=regex::Regex::new(pattern){output=re.replace_all(&output,if pattern==r"\s+"||pattern==r"[\x00-\x1f\x7f]+" {" "}else{""}).to_string();}
    }
    let lower=output.to_lowercase();
    let promotional=[r"\bcheck\s+(?:out\s+)?my\s+(?:store|shop|profile|page|cards|listings|other\s+items)\b",r"\bvisit\s+my\s+(?:store|shop|profile|page)\b",r"\bsee\s+my\s+(?:store|shop|profile|page|other\s+cards|listings)\b",r"\bmore\s+(?:cards|items|listings|products)\s+available\b",r"\b(?:other|more)\s+(?:cards|items|listings|products)\s+(?:in|on)\s+my\s+(?:store|shop|profile|page)\b",r"\b(?:message|contact|dm|pm)\s+me\b",r"\b(?:whatsapp|telegram|instagram|facebook|discord|ebay|vinted)\b",r"(?:https?://|www\.|(?:^|\s)[a-z0-9-]+\.(?:com|it|net|org|shop)\b)"];
    if promotional.iter().any(|p|regex::Regex::new(p).map(|r|r.is_match(&lower)).unwrap_or(false)){String::new()}else{output.trim().into()}
}
pub fn normalize_product(product:&Value,fallback:Option<i64>)->Value {
    let user=pick(product,&["user","seller"]); let source_props=pick(product,&["properties_hash","properties"]);
    let mut props=source_props.as_object().cloned().unwrap_or_default();
    let price_obj=product.get("price").filter(|v|v.is_object()).unwrap_or(&Value::Null);
    let id=pick(product,&["id","product_id","listing_id"]);
    let blueprint=pick(product,&["blueprint_id","blueprintId"]);
    let blueprint=if blueprint.is_null(){fallback.map(|n|json!(n)).unwrap_or(Value::Null)}else{blueprint.clone()};
    let blueprint_number=js_number(&blueprint);
    let price_cents=int(pick(product,&["price_cents","priceCents"]).as_null_fallback(price_obj.get("cents").unwrap_or(&Value::Null)));
    let price=product.get("price").and_then(Value::as_f64).or_else(||price_cents.map(|n|n as f64/100.0));
    if crate::cardtrader_live::infer_shipping_mode(product,user)=="one_day_ready"{props.insert("shipping_mode".into(),json!("one_day_ready"));}
    if truthy(pick(source_props,&["pokemon_reverse"]))||text(pick(source_props,&["foil_state","foilState"]),80).eq_ignore_ascii_case("reverse"){props.insert("foil_state".into(),json!("reverse"));}
    if ["first_edition","firstEdition","pokemon_first_edition"].iter().any(|key|truthy(&source_props[*key])){props.insert("first_edition".into(),json!(true));}
    if truthy(&product["graded"])||truthy(&source_props["graded"]){
        let seller_comment=comment(&first(&[pick(product,&["seller_comment","sellerComment","description"]),pick(source_props,&["seller_comment","sellerComment"])],240));
        if !seller_comment.is_empty(){props.insert("seller_comment".into(),json!(seller_comment));}
    }
    let mut slim=json!({"properties_hash":props,"user":{}});
    for (name,keys) in [("id",vec!["id","product_id","listing_id"]),("blueprint_id",vec!["blueprint_id","blueprintId"]),("quantity",vec!["quantity","qty"]),("price",vec!["price"]),("price_cents",vec!["price_cents","priceCents"]),("currency",vec!["currency","price_currency"]),("description",vec!["description"]),("graded",vec!["graded"]),("on_vacation",vec!["on_vacation"]),("bundle_size",vec!["bundle_size"])] {
        let v=pick(product,&keys); if !v.is_null(){slim[name]=v.clone();}
    }
    if slim.get("blueprint_id").is_none(){slim["blueprint_id"]=blueprint.clone();}
    if slim.get("price_cents").is_none(){if let Some(v)=price_obj.get("cents"){slim["price_cents"]=v.clone();}}
    if slim.get("currency").is_none(){if let Some(v)=price_obj.get("currency"){slim["currency"]=v.clone();}}
    if price_obj.is_object(){slim["price"]=json!({});for key in ["cents","currency"]{if let Some(v)=price_obj.get(key){slim["price"][key]=v.clone();}}}
    for (name,keys) in [("id",vec!["id","user_id"]),("username",vec!["username","name"]),("country_code",vec!["country_code","country"]),("user_type",vec!["user_type"]),("can_sell_via_hub",vec!["can_sell_via_hub"]),("can_sell_sealed_with_ct_zero",vec!["can_sell_sealed_with_ct_zero"])]{
        let v=pick(user,&keys);if !v.is_null(){slim["user"][name]=v.clone();}
    }
    if !product["expansion"]["id"].is_null(){slim["expansion"]=json!({});for key in ["id","code","name_en"]{if let Some(v)=product["expansion"].get(key){slim["expansion"][key]=v.clone();}}}
    let language=first(&[pick(product,&["language","lang"]),pick(source_props,&["language","pokemon_language","mtg_language"])],240);
    json!({
        "externalListingId":text(id,160),"externalProductId":text(id,160),"sellerAccountId":text(pick(user,&["id","user_id"]),160),
        "sellerAccountName":first(&[pick(user,&["username","name"])],240),"sellerCountry":text(pick(user,&["country_code","country"]),40),"sellerType":text(&user["user_type"],80),
        "blueprintId":if blueprint_number.is_finite(){json!(blueprint_number)}else{Value::Null},
        "cardtraderBlueprintId":if blueprint_number.is_finite(){json!(blueprint_number)}else{Value::Null},
        "pokoinCardId":if blueprint_number.is_finite(){format!("{}",blueprint_number*2.0)}else{String::new()},
        "quantity":int(pick(product,&["quantity","qty"])).unwrap_or(0).max(0),
        "condition":first(&[pick(product,&["condition","state"]),pick(source_props,&["condition","pokemon_condition"])],240),
        "language":crate::cardtrader_live::normalize_language(&language),"price":price,"priceCents":price_cents,
        "currency":text(slim.get("currency").unwrap_or(&json!("EUR")),12),"properties":props,"rawMetadata":slim,
    })
}
trait NullFallback { fn as_null_fallback<'a>(&'a self,fallback:&'a Value)->&'a Value; }
impl NullFallback for Value { fn as_null_fallback<'a>(&'a self,fallback:&'a Value)->&'a Value{if self.is_null(){fallback}else{self}} }
#[derive(Clone)]
struct Fetched {rows:Vec<Value>,ids:Vec<i64>,populations:Vec<Value>,truncated:bool,mode:&'static str}
fn population(rows:&[Value],blueprint:i64)->Value {
    let sellers:HashSet<String>=rows.iter().map(|row|text(&row["sellerAccountId"],160)).filter(|s|!s.is_empty()).collect();
    json!({"blueprintId":blueprint,"listingCount":rows.len(),"listedQuantity":rows.iter().filter_map(|row|row["quantity"].as_i64()).sum::<i64>(),"sellerCount":sellers.len(),"capped":rows.len()>=25})
}
pub fn rows_from_payload(payload:&Value,max:usize,cheapest:usize)->(Vec<Value>,Vec<i64>,Vec<Value>,bool) {
    let mut groups:Vec<(Option<i64>,Vec<Value>)>=Vec::new();let mut blue=Vec::new();
    if let Some(products)=payload.as_array(){
        for p in products{let row=normalize_product(p,None);let id=int(&row["blueprintId"]);if let Some(id)=id{blue.push(id);}
            if row["externalListingId"]==""{continue;}
            if let Some((_,rows))=groups.iter_mut().find(|(key,_)|*key==id && id.is_some()){rows.push(row);}else{groups.push((id,vec![row]));}
        }
    }else if let Some(map)=payload.as_object(){
        let mut entries:Vec<_>=map.iter().collect();entries.sort_by_key(|(key,_)|key.parse::<u64>().ok());
        for (key,products) in entries{let id=key.parse::<i64>().ok();if let Some(id)=id{blue.push(id);}
            if let Some(products)=products.as_array(){let mut rows=Vec::new();for p in products{let row=normalize_product(p,id);if let Some(id)=int(&row["blueprintId"]){blue.push(id);}if row["externalListingId"]!=""{rows.push(row);}}groups.push((id,rows));}
        }
    }
    let mut rows=Vec::new();let mut populations=Vec::new();let mut truncated=false;
    for (id,mut group) in groups{if let Some(id)=id{populations.push(population(&group,id));}
        if cheapest>0 && group.len()>cheapest{group.sort_by(|a,b|a["priceCents"].as_f64().or_else(||a["price"].as_f64().map(|v|v*100.0)).unwrap_or(f64::INFINITY).total_cmp(&b["priceCents"].as_f64().or_else(||b["price"].as_f64().map(|v|v*100.0)).unwrap_or(f64::INFINITY)).then_with(||text(&a["externalListingId"],160).cmp(&text(&b["externalListingId"],160))));group.truncate(cheapest);}
        for row in group{if rows.len()>=max{truncated=true;break;}rows.push(row);}if truncated{break;}
    }
    (rows,unique(blue),populations,truncated)
}
fn sql_error(error:sqlx::Error)->ApiError{
    let code=error.as_database_error().and_then(|e|e.code()).map(|v|v.into_owned());
    let mut result=ApiError::new(500,error.to_string());result.code=code;result
}
async fn fetch(state:&DomainState,token:&str,key:&str,id:i64,o:&Options)->ApiResult<Value>{
    let id=id.to_string();
    for attempt in 0..=5{
        match state.cardtrader.fetch_marketplace_products(token,&[(key,id.as_str()),("language",o.language.as_str())]).await {
            Ok(p)=>return Ok(p),
            Err(e)=>{
                let transient=e.status==429 || e.status>=500 || e.message.contains("401") || e.message.contains("403") || e.message.to_lowercase().contains("timeout");
                if !transient||attempt==5{return Err(e);}
                tokio::time::sleep(std::time::Duration::from_millis(5000*(attempt+1))).await;
            }
        }
    }
    Err(ApiError::upstream("CardTrader marketplace fetch failed."))
}
async fn blueprint_pool(state:&DomainState,max:usize)->ApiResult<Vec<i64>>{
    let pool=state.db.writer()?;let rows=sqlx::query(POOL_SQL).bind(max as i64).fetch_all(&pool).await.map_err(sql_error)?;
    Ok(unique(rows.iter().filter_map(|r|r.try_get::<i64,_>("blueprint_id").ok())))
}
async fn catalog(state:&DomainState)->ApiResult<Vec<(i64,Vec<i64>)>>{
    let pool=state.db.writer()?;let rows=sqlx::query(CATALOG_SQL).fetch_all(&pool).await.map_err(sql_error)?;
    Ok(rows.iter().filter_map(|r|r.try_get("expansion_id").ok().map(|id|(id,r.try_get("blueprint_ids").unwrap_or_default()))).collect())
}
async fn fetch_blueprints(state:&DomainState,token:&str,ids:&[i64],o:&Options,mode:&'static str)->ApiResult<Fetched>{
    use futures_util::{StreamExt, stream};
    let mut output=Fetched{rows:Vec::new(),ids:Vec::new(),populations:Vec::new(),truncated:false,mode};
    let turn=std::sync::Arc::new(tokio::sync::Mutex::new(false));
    for batch in ids.iter().take(o.max_blueprints).copied().collect::<Vec<_>>().chunks(o.blueprint_batch_size){
        if output.rows.len()>=o.max_products{break;}
        let turn=turn.clone();
        let mut pending=stream::iter(batch.iter().copied()).map(|id|{
            let turn=turn.clone(); async move{
                {let mut launched=turn.lock().await;if *launched && o.request_delay_ms>0{tokio::time::sleep(std::time::Duration::from_millis(o.request_delay_ms)).await;}*launched=true;}
                let payload=fetch(state,token,"blueprint_id",id,o).await?;
                let (rows,_,mut populations,_)=rows_from_payload(&payload,o.max_products,if o.complete_book{0}else{25});
                if populations.is_empty(){populations.push(population(&rows,id));}
                Ok::<_,ApiError>((id,rows,populations))
            }
        }).buffer_unordered(o.blueprint_concurrency);
        while let Some(result)=pending.next().await{let(id,rows,pops)=result?;let remaining=o.max_products.saturating_sub(output.rows.len());output.rows.extend(rows.into_iter().take(remaining));output.ids.push(id);output.populations.extend(pops);}
    }
    output.truncated=output.rows.len()>=o.max_products;Ok(output)
}
async fn fetch_expansion(state:&DomainState,token:&str,id:i64,catalog_ids:&[i64],o:&Options)->ApiResult<Fetched>{
    let payload=fetch(state,token,"expansion_id",id,o).await?;
    let(rows,ids,populations,truncated)=rows_from_payload(&payload,o.max_products,if o.complete_book{0}else{25});
    Ok(Fetched{rows,ids:unique(catalog_ids.iter().chain(ids.iter()).copied()).into_iter().take(o.max_blueprints).collect(),populations,truncated,mode:"expansion_id"})
}
fn reference_price()->String{
    let n=std::env::var("PKN_CHECKOUT_USDT_PRICE").ok().and_then(|v|v.parse::<f64>().ok()).filter(|n|n.is_finite()&&*n>0.0).unwrap_or(0.005);n.to_string()
}
async fn persist(state:&DomainState,f:&Fetched,o:&Options)->ApiResult<Value>{
    let rows:Vec<_>=f.rows.iter().take(o.max_products).cloned().collect();let ids=unique(f.ids.clone()).into_iter().take(o.max_blueprints).collect::<Vec<_>>();
    let mut result=json!({"sourceMode":f.mode,"blueprintCount":ids.len(),"fetchedProducts":f.rows.len(),"shapedRows":rows.len(),"truncated":f.truncated||f.rows.len()>rows.len(),"archivedCount":0,"deletedCount":0,"upsertedCount":0,"cacheRefreshedCount":0});
    if o.dry_run{result["sample"]=json!(rows.iter().take(5).map(|row|json!({"externalListingId":row["externalListingId"],"blueprintId":row["blueprintId"],"pokoinCardId":row["pokoinCardId"],"quantity":row["quantity"],"condition":row["condition"],"language":row["language"],"priceCents":row["priceCents"],"currency":row["currency"]})).collect::<Vec<_>>());return Ok(result);}
    let pool=state.db.writer()?;let mut tx=pool.begin().await.map_err(sql_error)?;
    for sql in ["SET LOCAL statement_timeout = 0","SET LOCAL lock_timeout = 0","SET LOCAL idle_in_transaction_session_timeout = 0"]{sqlx::query(sql).execute(&mut *tx).await.map_err(sql_error)?;}
    sqlx::query("SELECT pg_advisory_xact_lock($1::bigint)").bind(872014433i64).execute(&mut *tx).await.map_err(sql_error)?;
    let row=sqlx::query(REFRESH_SQL).bind("cardtrader").bind(json!(rows)).bind(json!(ids)).bind(&o.removed_day).bind(o.archive_missing && !f.truncated && o.complete_book).bind(reference_price()).bind(o.finalize).bind(o.record_asks).bind(if o.complete_book{"1"}else{""}).fetch_one(&mut *tx).await.map_err(sql_error)?;
    for (key,column) in [("archivedCount","archived_count"),("deletedCount","deleted_count"),("upsertedCount","upserted_count"),("cacheRefreshedCount","cache_refreshed_count")]{result[key]=json!(row.try_get::<i64,_>(column).unwrap_or(0));}
    tx.commit().await.map_err(sql_error)?;
    let populations=f.populations.iter().filter(|p|!p["blueprintId"].is_null()).map(|p|json!({"blueprint_id":p["blueprintId"],"listing_count":p["listingCount"],"listed_quantity":p["listedQuantity"],"seller_count":p["sellerCount"],"new_listings":0,"new_quantity":0,"capped":p["capped"]})).collect::<Vec<_>>();
    let population_count=if populations.is_empty(){0}else{
        sqlx::query(POPULATION_SQL).bind(crate::time_util::iso_from_ms(crate::time_util::now_ms()).chars().take(10).collect::<String>()).bind(json!(populations)).fetch_one(&pool).await.ok().and_then(|r|r.try_get::<i64,_>("upserted_count").ok()).unwrap_or(0)
    };result["populationUpsertedCount"]=json!(population_count);Ok(result)
}
async fn finalize(state:&DomainState,o:&Options)->ApiResult<Value>{
    let pool=state.db.writer()?;let mut tx=pool.begin().await.map_err(sql_error)?;
    for sql in ["SET LOCAL statement_timeout = 0","SET LOCAL lock_timeout = 0","SET LOCAL idle_in_transaction_session_timeout = 0"]{sqlx::query(sql).execute(&mut *tx).await.map_err(sql_error)?;}
    let row=sqlx::query(FINALIZE_SQL).bind(&o.removed_day).bind(reference_price()).bind("cardtrader").fetch_one(&mut *tx).await.map_err(sql_error)?;
    let result=json!({"cacheRefreshedCount":row.try_get::<i64,_>("cache_refreshed_count").unwrap_or(0),"analyticsCount":row.try_get::<i64,_>("analytics_count").unwrap_or(0),"priceSummaryCount":row.try_get::<i64,_>("price_summary_count").unwrap_or(0)});
    tx.commit().await.map_err(sql_error)?;Ok(result)
}
fn totals()->Value{json!({"expansionCount":0,"blueprintCount":0,"fetchedProducts":0,"shapedRows":0,"truncated":false,"archivedCount":0,"deletedCount":0,"upsertedCount":0,"cacheRefreshedCount":0})}
fn add(total:&mut Value,row:&Value,expansion:bool){
    for key in ["blueprintCount","fetchedProducts","shapedRows","archivedCount","deletedCount","upsertedCount","cacheRefreshedCount"]{total[key]=json!(total[key].as_u64().unwrap_or(0)+row[key].as_u64().unwrap_or(0));}
    if expansion{total["expansionCount"]=json!(total["expansionCount"].as_u64().unwrap_or(0)+1);}
    total["truncated"]=json!(total["truncated"]==true||row["truncated"]==true);
}
pub async fn run(state:&DomainState,o:&Options)->ApiResult<Value>{
    let token=crate::cardtrader::client::clean_token(&std::env::var("CARDTRADER_AUTH_TOKEN").ok().filter(|s|!s.is_empty()).or_else(||std::env::var("CARDTRADER_API_TOKEN").ok()).unwrap_or_default());
    if token.is_empty(){return Err(ApiError::new(503,"Global CardTrader API token is not configured. Set CARDTRADER_AUTH_TOKEN or CARDTRADER_API_TOKEN.").with_code("CARDTRADER_GLOBAL_API_TOKEN_MISSING"));}
    if o.by_blueprint||(!o.blueprint_ids.is_empty()&&o.expansion_ids.is_empty()){
        let explicit=!o.blueprint_ids.is_empty();let ids=if explicit{o.blueprint_ids.clone()}else{blueprint_pool(state,o.max_blueprints).await?};
        let mode=if explicit{"explicit_blueprint_ids"}else{"oracle_blueprint_pool"};
        if !o.dry_run&&o.refresh_batch_blueprints>0&&o.expansion_ids.len()!=1{
            let mut total=totals();for batch in ids.chunks(o.refresh_batch_blueprints.min(ids.len()).max(1)){
                if total["fetchedProducts"].as_u64().unwrap_or(0)>=o.max_products as u64{total["truncated"]=json!(true);break;}
                let mut option=o.clone();option.finalize=false;option.max_blueprints=batch.len();option.max_products=o.max_products-total["fetchedProducts"].as_u64().unwrap_or(0) as usize;
                let fetched=fetch_blueprints(state,&token,batch,&option,mode).await?;add(&mut total,&persist(state,&fetched,&option).await?,false);
            }total["sourceMode"]=json!(mode);if o.finalize{total["finalized"]=finalize(state,o).await?;}return Ok(total);
        }
        return persist(state,&fetch_blueprints(state,&token,&ids,o,mode).await?,o).await;
    }
    let catalog=catalog(state).await?;
    if o.expansion_ids.len()==1{
        let id=o.expansion_ids[0];let catalog_ids=if !o.catalog_ids.is_empty(){o.catalog_ids.clone()}else{catalog.iter().find(|(n,_)|*n==id).map(|(_,v)|v.clone()).unwrap_or_default()};
        return persist(state,&fetch_expansion(state,&token,id,&catalog_ids,o).await?,o).await;
    }
    let selected:Vec<_>=catalog.iter().filter(|(id,_)|o.expansion_ids.is_empty()||o.expansion_ids.contains(id)).filter(|(id,_)|o.min_expansion.filter(|n|*n>0).is_none_or(|n|*id>=n)).filter(|(id,_)|id.rem_euclid(o.shard_count)==o.shard_index.rem_euclid(o.shard_count)).take(o.max_expansions).cloned().collect();
    let mut total=totals();let mut first_error=None;
    for (index,(id,blue)) in selected.iter().enumerate(){
        if total["fetchedProducts"].as_u64().unwrap_or(0)>=o.max_products as u64{break;}
        if index>0&&o.request_delay_ms>0{tokio::time::sleep(std::time::Duration::from_millis(o.request_delay_ms)).await;}
        let mut option=o.clone();option.finalize=false;option.max_products=o.max_products-total["fetchedProducts"].as_u64().unwrap_or(0) as usize;
        let fetched=fetch_expansion(state,&token,*id,blue,&option).await;
        let result=match fetched{Ok(mut f)=>{f.mode="oracle_expansions";persist(state,&f,&option).await},Err(e)=>Err(e)};
        match result{Ok(row)=>add(&mut total,&row,true),Err(error)=>{first_error=Some(error);break;}}
    }
    if first_error.is_none()&&o.expansion_ids.is_empty()&&total["fetchedProducts"].as_u64().unwrap_or(0)<o.max_products as u64{
        let pool=state.db.writer()?;let rows=sqlx::query(UNGROUPED_SQL).bind(o.max_blueprints.min(5000) as i64).fetch_all(&pool).await.map_err(sql_error)?;
        let ids=rows.iter().filter_map(|r|r.try_get("blueprint_id").ok()).collect::<Vec<i64>>();
        if !ids.is_empty(){let mut option=o.clone();option.finalize=false;option.max_products=o.max_products-total["fetchedProducts"].as_u64().unwrap_or(0) as usize;
            let f=fetch_blueprints(state,&token,&ids,&option,"ungrouped_blueprints").await?;add(&mut total,&persist(state,&f,&option).await?,false);}
    }
    let finalized=if !o.dry_run&&o.finalize{finalize(state,o).await?}else{Value::Null};
    if let Some(e)=first_error{return Err(e);}
    total["sourceMode"]=json!("oracle_expansions");total["cheapestListingLimit"]=json!(25);total["finalized"]=finalized;Ok(total)
}
pub fn response_metadata(o:&Options,result:Value)->Value {
    let mut payload=json!({"ok":true,"provider":"cardtrader","source":"global_cardtrader_marketplace_products","apiPath":"/api/v2/marketplace/products","scheduleOwner":"oracle_peer4_host_cron","dryRun":o.dry_run,"archiveMissing":o.archive_missing,"removedDay":o.removed_day,"maxBlueprints":o.max_blueprints,"maxProducts":o.max_products,"blueprintBatchSize":o.blueprint_batch_size,"blueprintConcurrency":o.blueprint_concurrency,"expansionId":if o.expansion_ids.len()==1{json!(o.expansion_ids[0])}else{Value::Null},"requestedBlueprintCount":o.blueprint_ids.len()});
    if let (Some(target),Some(source))=(payload.as_object_mut(),result.as_object()){target.extend(source.clone());}payload
}
#[cfg(test)] mod tests{
 use super::*;
 #[test]fn options_match_request_null_defaults_and_aliases(){
    let uri="/api/x?blueprint_ids=2,1,2&blueprintId=9&dryRun=true&maxProducts=20000001&completeBook=1".parse().unwrap();
    let o=request_options(&uri,&json!({}));assert_eq!(o.blueprint_ids,vec![9,2,1]);assert!(o.dry_run&&o.complete_book);assert_eq!(o.max_products,20_000_000);assert_eq!(o.max_blueprints,1);assert_eq!(o.request_delay_ms,0);
    assert_eq!(request_options(&uri,&json!({"maxProducts":4})).max_products,4);
 }
 #[test]fn listing_shape_preserves_raw_language_and_caps_only_cheapest_book(){
    let p=json!({"12":[{"id":3,"quantity":4,"price":{"cents":90,"currency":"EUR"},"properties_hash":{"pokemon_language":"Japanese","pokemon_reverse":true},"user":{"id":7,"username":"alice"}}]});
    let (rows,ids,pops,truncated)=rows_from_payload(&p,100,25);
    assert_eq!(ids,vec![12]);assert_eq!(rows[0]["pokoinCardId"],"24");assert_eq!(rows[0]["language"],"ja");assert_eq!(rows[0]["properties"]["foil_state"],"reverse");assert_eq!(pops[0]["listedQuantity"],4);assert!(!truncated);
    let p=Value::Array((0..30).map(|id|json!({"id":id+1,"blueprint_id":8,"quantity":1,"price_cents":30-id})).collect());
    assert_eq!(rows_from_payload(&p,100,25).0.len(),25);assert_eq!(rows_from_payload(&p,100,0).0.len(),30);
 }
 #[test]fn secrets_compare_all_bytes(){assert!(equal_secret("abc","abc"));assert!(!equal_secret("abc","abd"));assert!(!equal_secret("",""));}
}

const POOL_SQL: &str = r#"
      select ct_id as blueprint_id
      from public.marketplace_search_candidates
      where ct_id is not null
      order by search_weight desc, imported_at desc nulls last, ct_id desc
      limit $1
    "#;

const CATALOG_SQL: &str = r#"
      select
        expansion_id,
        coalesce(array_agg(id order by id), '{}'::bigint[]) as blueprint_ids
      from public.pokoin_pokemon_blueprints
      where expansion_id is not null
      group by expansion_id
      order by expansion_id
    "#;

const UNGROUPED_SQL: &str = r#"
      select id as blueprint_id
      from public.pokoin_pokemon_blueprints
      where expansion_id is null
      order by id
      limit $1
    "#;

const REFRESH_SQL: &str = r#"
      with settings as (
        select set_config('app.pkn_usdt_price', $6::text, true),
               set_config('app.cardtrader_complete_book', $9::text, true)
      )
      select *
      from settings,
      lateral (
      select *
      from public.refresh_cardtrader_market_listing_snapshots(
        $1::text,
        $2::jsonb,
        $3::jsonb,
        $4::date,
        $5::boolean,
        now(),
        $7::boolean,
        $8::boolean
      )
      ) refreshed
    "#;

const POPULATION_SQL: &str = r#"
      select public.upsert_cardtrader_blueprint_population($1::date, $2::jsonb) as upserted_count
    "#;

const FINALIZE_SQL: &str = r#"
      with settings as (
        select set_config('app.pkn_usdt_price', $2::text, true)
      )
      select *
      from settings,
      lateral (
        select *
        from public.finalize_cardtrader_daily_market_refresh(
          $3::text,
          $1::date,
          now()
        )
      ) finalized
    "#;
