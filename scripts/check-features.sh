#!/usr/bin/env bash
# Check docs/FEATURES.toml, the feature map of the user-visible flows and their proofs. docs/CI.md ("Feature map"), PK-C007.
#
# The map is a deliberately flat TOML: [[flow]] blocks, six keys per flow, one per line, string values in double
# quotes, arrays on one line. No TOML library is assumed; awk reads it.
#
# The check fails (exit 1, naming the flow and the reason) when a flow is missing a key or carries an unknown one, an
# id is duplicated or not kebab-case, an entry or proof path is not a tracked file, a proof::name is not a declared
# test in that file, a proved or partial flow has no proof, an unproved flow has one, or a proof file is not run by
# any CI job: Rust proofs live under pokoin-rust/ and are a tests/ file or carry a #[cfg(test)] module; every other
# proof must be matched by a group of scripts/js-test-groups.txt, read through that inventory's own
# `--files GROUP`, and a file listed in scripts/js-tests-not-in-gate.txt does not count as run.
#
# With --base <commit> the map may only grow: a flow present at the base cannot be removed, and the number of
# money flows with status "unproved" cannot rise. A base with no docs/FEATURES.toml fails neither rule.
#
# Usage: scripts/check-features.sh [--base <commit>]
# Exit: 0 clean, 1 a finding, 2 this check cannot run (usage, no checkout, unreadable base).
set -euo pipefail

map=docs/FEATURES.toml
keys=(id name money entry proof status)

usage() { echo "usage: $0 [--base <commit>]" >&2; exit "${1:-2}"; }
die() { echo "check-features: $*" >&2; exit 2; }

base=""
while [ $# -gt 0 ]; do
    case "$1" in
        --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
        -h | --help) usage 0 ;;
        *) echo "check-features: unknown argument: $1" >&2; usage ;;
    esac
done
if [ -n "$base" ]; then
    git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || die "--base '$base' is not a commit in this checkout"
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
[ -f "$root/$map" ] || die "$map is not in this checkout"

tmpfiles=()
# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup() {
    if [ "${#tmpfiles[@]}" -gt 0 ]; then rm -f "${tmpfiles[@]}"; fi
}
trap cleanup EXIT

findings=0
fail() { echo "check-features: $1" >&2; findings=$((findings + 1)); }

# parse <file> — turn one map into "flow|key|err|count" records separated by tabs. Comments and blank lines are
# skipped; anything else must be a [[flow]] line or a `key = value` line. A tab counts as IFS whitespace, so two
# adjacent tabs would merge into one field: every record carries all four fields, with '-' standing in for the ones
# a record type does not use.
parse() {
    awk '
        /^[[:space:]]*$/ { next }
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*\[\[flow\]\][[:space:]]*$/ { flows++; printf "flow\t%d\t-\t-\n", flows; next }
        {
            if (match($0, /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) == 0) {
                printf "err\t%d\t-\t%s\n", flows + 1, "not a [[flow]] line and not key = value: " $0
                next
            }
            if (flows == 0) { printf "err\t0\t-\t%s\n", "key before the first [[flow]]: " $0; next }
            key = $0
            sub(/^[[:space:]]*/, "", key)
            sub(/[[:space:]]*=.*$/, "", key)
            val = $0
            sub(/^[^=]*=[[:space:]]*/, "", val)
            sub(/[[:space:]]+$/, "", val)
            printf "key\t%d\t%s\t%s\n", flows, key, val
        }
        END { printf "count\t%d\t-\t-\n", flows }
    ' "$1"
}

# load_map <file> <label> — fill NFLOW and the parallel F_* arrays, reporting structure findings through fail().
declare -a F_ID F_NAME F_MONEY F_ENTRY F_PROOF F_STATUS F_NPROOF
NFLOW=0
load_map() {
    local file=$1 what=$2 kind idx key val known k m tag
    NFLOW=0
    F_ID=(); F_NAME=(); F_MONEY=(); F_ENTRY=(); F_PROOF=(); F_STATUS=()
    local -a got=()
    while IFS=$'\t' read -r kind idx key val; do
        case $kind in
            err)
                fail "$what: $val"
                ;;
            flow)
                while [ "${#F_ID[@]}" -lt "$idx" ]; do
                    F_ID+=(""); F_NAME+=(""); F_MONEY+=(""); F_ENTRY+=(""); F_PROOF+=(""); F_STATUS+=("")
                    got+=("")
                done
                ;;
            count)
                NFLOW=$idx
                ;;
            key)
                m=$((idx - 1))
                # Name the flow by its id once the id line has been read; until then its position is all there is.
                tag="flow $idx"
                if [ -n "${F_ID[m]-}" ]; then
                    tag="flow '${F_ID[m]//\"/}'"
                fi
                known=0
                for k in "${keys[@]}"; do
                    if [ "$k" = "$key" ]; then known=1; fi
                done
                if [ "$known" -eq 0 ]; then
                    fail "$what $tag: unknown key '$key' (the keys are: ${keys[*]})"
                    continue
                fi
                # got[m] lists the keys this flow already carries, each followed by a space, so membership is one test.
                if [[ " ${got[m]-} " == *" $key "* ]]; then
                    fail "$what $tag: key '$key' appears twice"
                fi
                got[m]+="$key "
                case $key in
                    id) F_ID[m]=$val ;;
                    name) F_NAME[m]=$val ;;
                    money) F_MONEY[m]=$val ;;
                    entry) F_ENTRY[m]=$val ;;
                    proof) F_PROOF[m]=$val ;;
                    status) F_STATUS[m]=$val ;;
                esac
                ;;
        esac
    done < <(parse "$file")
}

quoted_string() { # quoted_string <val> — echo the value without its double quotes; return 1 when it has none
    local v=$1
    if [ "${#v}" -ge 2 ] && [[ $v == '"'*'"' ]]; then
        printf '%s' "${v:1:${#v}-2}"
        return 0
    fi
    return 1
}

array_items() { # array_items <label> <val> — fill ITEMS with the quoted strings; report failures through fail()
    local label=$1 raw=$2 body rest item
    ITEMS=()
    if [[ ! $raw == '['*']' ]]; then
        fail "$label: '$raw' is not an array on one line"
        return 1
    fi
    body=${raw:1:${#raw}-2}
    rest=$body
    while [[ $rest == *'"'*'"'* ]]; do rest=${rest#*'"'*'"'}; done
    if [[ $rest == *[![:space:],]* ]]; then
        fail "$label: '$raw' has array items that are not strings in double quotes"
        return 1
    fi
    while IFS= read -r item; do
        if [ -n "$item" ]; then ITEMS+=("${item:1:${#item}-2}"); fi
    done < <(printf '%s\n' "$body" | grep -oE '"[^"]*"' || true)
    return 0
}

tracked_file() { # tracked_file <path> <label>
    local p=$1 label=$2
    if ! git -C "$root" ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
        fail "$label: '$p' is not a tracked file"
        return 1
    fi
    if [ ! -f "$root/$p" ]; then
        fail "$label: '$p' is tracked but not present in this checkout"
        return 1
    fi
    return 0
}

# The files a gate job runs: everything printed by scripts/js-test-inventory.sh --files GROUP, for every GROUP of
# scripts/js-test-groups.txt. Reused, never re-implemented, so the globs cannot drift.
js_groups_file=$(mktemp); tmpfiles+=("$js_groups_file")
collect_js_groups() {
    local groups=scripts/js-test-groups.txt line name
    : >"$js_groups_file"
    [ -f "$root/$groups" ] || die "$groups is not in this checkout, so no JavaScript proof can be shown to be run"
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ -z $line || $line == '#'* ]]; then continue; fi
        name=${line%%$'\t'*}
        if ! (cd "$root" && bash scripts/js-test-inventory.sh --files "$name") >>"$js_groups_file"; then
            die "scripts/js-test-inventory.sh --files '$name' failed"
        fi
    done <"$root/$groups"
    sort -u -o "$js_groups_file" "$js_groups_file"
}

notin_gate() { # notin_gate <path> — a file listed with a reason in scripts/js-tests-not-in-gate.txt does not count as run
    local p=$1 list=scripts/js-tests-not-in-gate.txt line path
    [ -f "$root/$list" ] || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ -z $line || $line == '#'* ]]; then continue; fi
        path=${line%%$'\t'*}
        if [ "$path" = "$p" ]; then return 0; fi
    done <"$root/$list"
    return 1
}

is_rust_test_decl() { # is_rust_test_decl <absfile> <name> — fn <name> declared with #[test] or #[tokio::test]
    awk -v n="$2" '
        { lines[NR] = $0 }
        $0 ~ ("(^|[^A-Za-z0-9_])fn[ \t]*" n "[ \t]*\\(") {
            for (j = NR; j >= 1 && j >= NR - 4; j--) {
                if (lines[j] ~ /#\[[ \t]*(tokio::)?test/) { ok = 1; exit }
            }
        }
        END { exit ok ? 0 : 1 }
    ' "$1"
}

is_js_test_decl() { # is_js_test_decl <absfile> <name> — the forms the tree uses: test('<name>' / test("<name>" / it(
    grep -qF -e "test('$2'" -e "test(\"$2\"" -e "it('$2'" -e "it(\"$2\"" -- "$1"
}

proof_run_by_ci() { # proof_run_by_ci <path> <label>
    local p=$1 label=$2
    case $p in
        pokoin-rust/*)
            case $p in
                */tests/*) return 0 ;;
            esac
            if ! grep -qF '#[cfg(test)]' "$root/$p"; then
                fail "$label: proof '$p' is Rust code that is neither a file under a tests/ directory nor behind a #[cfg(test)] module: no CI job runs it"
                return 1
            fi
            return 0
            ;;
        *)
            if notin_gate "$p"; then
                fail "$label: proof '$p' is listed in scripts/js-tests-not-in-gate.txt, so no CI job runs it"
                return 1
            fi
            if ! grep -qxF -- "$p" "$js_groups_file"; then
                fail "$label: proof '$p' is matched by no group of scripts/js-test-groups.txt, so no CI job runs it"
                return 1
            fi
            return 0
            ;;
    esac
}

proof_valid() { # proof_valid <item> <label>
    local item=$1 label=$2 path name ext
    if [[ $item == *'::'* ]]; then
        path=${item%%::*}
        name=${item#*::}
        if [[ -z ${name//[[:space:]]/} ]]; then
            fail "$label: proof '$item' names no test after the '::'"
            return 1
        fi
        if [[ $name == *'::'* ]]; then
            fail "$label: proof '$item' has more than one '::'"
            return 1
        fi
    else
        path=$item
        name=""
    fi
    tracked_file "$path" "$label" || return 1
    proof_run_by_ci "$path" "$label" || return 1
    if [ -n "$name" ]; then
        ext=${path##*.}
        case $ext in
            rs)
                if [[ ! $name =~ ^[A-Za-z0-9_]+$ ]]; then
                    fail "$label: proof '$item' names a Rust test '$name', which is not an identifier"
                    return 1
                fi
                if ! is_rust_test_decl "$root/$path" "$name"; then
                    fail "$label: proof '$item': '$name' is not a test in $path (no 'fn $name' after a #[test] or #[tokio::test] line)"
                    return 1
                fi
                ;;
            js | mjs | cjs | jsx | ts | tsx)
                if ! is_js_test_decl "$root/$path" "$name"; then
                    fail "$label: proof '$item': '$name' is not a test in $path (no test('<name>')/test(\"<name>\")/it() declaration)"
                    return 1
                fi
                ;;
            *)
                fail "$label: proof '$item' names a test in a '.$ext' file $path, which this check cannot read as a test declaration"
                return 1
                ;;
        esac
    fi
    return 0
}

collect_js_groups
load_map "$root/$map" "$map"

if [ "$NFLOW" -eq 0 ]; then
    fail "$map lists no [[flow]] block"
fi

declare -A seen_ids=()
n=0
money_n=0
unproved_money=0
for ((i = 1; i <= NFLOW; i++)); do
    idx=$((i - 1))
    raw_id=${F_ID[$idx]}
    id=$(quoted_string "$raw_id" || true)
    if [ -n "$raw_id" ] && [ -z "$id" ]; then
        fail "flow '${raw_id//\"/}': id $raw_id is not a string in double quotes"
        id=${raw_id//\"/}
    fi
    flow=${id:-flow #$i}
    label="flow '$flow'"

    missing=0
    for key in "${keys[@]}"; do
        case $key in
            id) val=${F_ID[$idx]} ;;
            name) val=${F_NAME[$idx]} ;;
            money) val=${F_MONEY[$idx]} ;;
            entry) val=${F_ENTRY[$idx]} ;;
            proof) val=${F_PROOF[$idx]} ;;
            status) val=${F_STATUS[$idx]} ;;
        esac
        if [ -z "$val" ]; then
            fail "$label: missing key '$key'"
            missing=1
        fi
    done

    if [[ ! $id =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]]; then
        fail "$label: id '$id' is not kebab-case"
    fi
    if [ -n "${seen_ids[$id]:-}" ]; then
        fail "$label: the id is duplicated (also flow #${seen_ids[$id]})"
    fi
    seen_ids[$id]=$i

    money=${F_MONEY[$idx]}
    if [ "$money" != true ] && [ "$money" != false ]; then
        fail "$label: money = '$money' is not true or false"
        money=false
    elif [ "$money" = true ]; then
        money_n=$((money_n + 1))
    fi

    status=$(quoted_string "${F_STATUS[$idx]}" || true)
    case $status in
        proved | partial | unproved) ;;
        *)
            if ! quoted_string "${F_STATUS[$idx]}" >/dev/null 2>&1; then
                fail "$label: status '${F_STATUS[$idx]}' is not a string in double quotes"
            else
                fail "$label: status '$status' is not one of: proved, partial, unproved"
            fi
            status=""
            ;;
    esac

    array_items "$label: entry" "${F_ENTRY[$idx]}" || true
    eitem=0
    for p in ${ITEMS[@]+"${ITEMS[@]}"}; do
        tracked_file "$p" "$label: entry[$eitem]" || true
        eitem=$((eitem + 1))
    done

    array_items "$label: proof" "${F_PROOF[$idx]}" || true
    nproofs=${#ITEMS[@]}
    F_NPROOF[idx]=$nproofs
    pitem=0
    for p in ${ITEMS[@]+"${ITEMS[@]}"}; do
        proof_valid "$p" "$label: proof[$pitem]" || true
        pitem=$((pitem + 1))
    done

    if { [ "$status" = proved ] || [ "$status" = partial ]; } && [ "$nproofs" -eq 0 ]; then
        fail "$label: status '$status' with an empty proof; only an unproved flow may have no proof"
    fi
    if [ "$status" = unproved ] && [ "$nproofs" -ne 0 ]; then
        fail "$label: status 'unproved' with $nproofs proof(s); a flow with a proof is proved or partial, and an unproved flow needs proof = []"
    fi
    if [ "$missing" -eq 0 ] && [ "$status" = unproved ] && [ "$money" = true ]; then
        unproved_money=$((unproved_money + 1))
    fi
    n=$((n + 1))
done

# ---- with --base: the map may only grow ----------------------------------------------------------------------
if [ -n "$base" ]; then
    if git -C "$root" cat-file -e "$base:$map" 2>/dev/null; then
        basefile=$(mktemp); tmpfiles+=("$basefile")
        git -C "$root" show "$base:$map" >"$basefile"
        declare -A base_id=() base_money=() base_status=()
        bkind='' bidx='' bkey='' bval=''
        while IFS=$'\t' read -r bkind bidx bkey bval; do
            [ "$bkind" = key ] || continue
            case $bkey in
                id) base_id[$bidx]=$bval ;;
                money) base_money[$bidx]=$bval ;;
                status) base_status[$bidx]=$bval ;;
            esac
        done < <(parse "$basefile")
        base_unproved_money=0
        for bidx in "${!base_id[@]}"; do
            bid=${base_id[$bidx]//\"/}
            [ -n "$bid" ] || continue
            if [ "${base_money[$bidx]:-false}" = true ] && [ "${base_status[$bidx]:-}" = '"unproved"' ]; then
                base_unproved_money=$((base_unproved_money + 1))
            fi
            if [ -z "${seen_ids[$bid]:-}" ]; then
                fail "flow '$bid' is present at $base but missing now: the map only grows; a flow that is gone gets status and a reason, not a deletion"
            fi
        done
        if [ "$unproved_money" -gt "$base_unproved_money" ]; then
            fail "$unproved_money money flow(s) are unproved but only $base_unproved_money were at $base: money coverage may only grow; prove a flow or extend its proof, never widen the map by giving up on one"
        fi
    fi
fi

# ---- the table and the counts ----------------------------------------------------------------------------------
printf '%-28s %-5s %-8s %s\n' id money status proofs
for ((i = 1; i <= NFLOW; i++)); do
    idx=$((i - 1))
    np=${F_NPROOF[idx]}
    printf '%-28s %-5s %-8s %s\n' "${F_ID[$idx]//\"/}" "${F_MONEY[$idx]}" "${F_STATUS[$idx]//\"/}" "$np"
done
echo "flows: $NFLOW; money flows: $money_n; money flows unproved: $unproved_money"

if [ "$findings" -gt 0 ]; then
    echo "check-features: $findings finding(s)" >&2
    exit 1
fi
exit 0
