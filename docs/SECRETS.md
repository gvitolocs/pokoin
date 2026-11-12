# Secrets (scan gate and allowlist)

Every credential of this project lives in **Infisical** and in the runtime
environment that reads it. Nothing secret is committed — not to a feature
branch, not "temporarily", not in a test. `.env*` files are gitignored and are
never a deployment mechanism here.

## Running the scan

```bash
gitleaks detect --no-git -s . --redact --no-banner; echo exit=$?   # 0 == clean
```

`--redact` keeps the matched value out of your terminal and out of CI logs.
`.githooks/pre-commit` runs `gitleaks protect --staged --redact --no-banner`
and fails the commit on a finding, when `gitleaks` is on `PATH` (the hook stays
silent on hosts without it, so nothing else breaks). Enable the hook with
`scripts/setup-git-hooks.sh`.

The scan is only a gate while it stays clean: a new real secret must be finding
number one, not number 190. Do not "fix" a red scan by widening the allowlist.

The gate is rules-based, not exhaustive: gitleaks 8.30.1 validates AWS access
key ids beyond the `AKIA`+16 shape, so a lone malformed id can pass unreported
while the paired `aws_secret_access_key` is caught by `generic-api-key`. Review
diffs that add environment variables anyway.

## What the allowlist covers

[../.gitleaks.toml](../.gitleaks.toml) extends the default rules
(`[extend] useDefault = true`) and allowlists only these. No rule is disabled.

| Allowlisted | Why it is not a secret |
| --- | --- |
| `market/public/data/site-map-images.json` | image file keys of a public data file the browser fetches |
| `pokoin-rust/apps/api/assets/*.dict` | card-name compression dictionary, a binary asset |
| `market/src/firebase-client.js` | Firebase **web** config, shipped to every browser and guarded by the Auth domain allowlist |
| `LANDING_BINDER_KEY`, `RECS_KEY`, `ARTIST_STORED_KEY` | names of browser storage slots, not their (session-hint) contents |
| `lookupKey:` package rows in `market/src/pkn-packages.js` | public Stripe price *lookup keys*; the Stripe API key is separate and never in the repo |
| `clean_token(...)` / `let wrapped` / `let bounded` in `cardtrader/client.rs` | fake JWTs inside `#[cfg(test)]`: header carries only `alg`, payload only `sub`, 12-char signature |
| `std::env::set_var("CARDTRADER_TOKEN_ENCRYPTION_KEY", …)` in `cardtrader/zero.rs` | dummy test value pushed by a `#[cfg(test)]` harness |
| `let key = "<32 hex>";` in `accounts` cardrails tests, `let utf8_key` in `commerce` `address.rs` | hex fixtures of the grant / key-parsing tests |
| `TEST_PRIVATE_KEY_PEM` in `accounts/tests/common/mod.rs` | throwaway RSA key generated for the hermetic test harness |
| `assert_eq!(hit.key, "<id>_<name>.jpg")` in `edge/src/cdn.rs`, `key="<id>_<name>.jpg"` in `scripts/cardtrader-scan-fetch.test.py`, `key: "discord_<id>"` in `poko_bets.rs` | CDN file names and a Discord holder id inside tests |

## Adding an entry

One entry per reason, with a `description` that states why the string is
public or test-only.

- Anchor on the **identifier**, never on the value. A regex of the value, or of
  a value prefix, is a secret scanner that no longer detects that secret.
- Prefer `regexTarget = "line"` over `paths`. gitleaks evaluates `paths` and
  `regexes` of one entry with **OR**, so an entry that lists a path allowlists
  every rule over that whole file — a real secret committed there is then
  invisible. Keep `paths` for data/asset files that cannot hold a credential.
- For a fixture inside `#[cfg(test)]` in a source file, anchor on the test
  helper or the constant name so the rest of the file stays scanned.
- Never allowlist a directory of source, a whole `src/` tree, or a rule.
- Re-run the full scan afterwards and check that removing the new entry brings
  back exactly the findings it is meant to cover.

## When the scan finds something

A finding on new or changed content is treated as a live secret.

1. Do not commit, and do not allowlist it.
2. Remove it from the file — including from history if it was already
   committed (`git commit --amend` on an unpushed commit; a pushed commit means
   the value is public).
3. If the value ever reached a remote, rotate it in Infisical and consider the
   old one burned; a redacted scan log does not un-publish it.
4. Tell the owner of the credential (and the person who wrote it) what was
   exposed, where, and that it has been rotated.
5. Move the value into Infisical and read it from the environment, then confirm
   `gitleaks detect --no-git -s . --redact --no-banner` exits 0.
