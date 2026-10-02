/// Claim one pending outbox row. Side effects run after this transaction commits.
pub const CLAIM_SQL: &str = r#"
update public.marketplace_outbox as outbox
set
  attempts = outbox.attempts + 1,
  available_at = now() + interval '30 seconds'
where outbox.id = (
  select id
  from public.marketplace_outbox
  where processed_at is null
    and available_at <= now()
    and attempts < 8
  order by id
  for update skip locked
  limit 1
)
returning id, event_type, aggregate_id, payload, attempts
"#;

pub const INSERT_SQL: &str = r#"
insert into public.marketplace_outbox (
  event_type, aggregate_id, payload, idempotency_key
) values ($1, $2, $3::jsonb, $4)
on conflict (idempotency_key) where processed_at is null and idempotency_key is not null
do nothing
returning id
"#;
