#!/usr/bin/env bash
# Keeps the pokoin-api pods out of the kernel's first-kill queue (finding PKN-10, docs/NEZOPT_OVERFLOW.md
# "Memory and the kill order"). A Burstable pod (requests below limits) runs with oom_score_adj 998 on nezopt and
# was OOM-killed 21 times in 4 days; a Guaranteed pod (requests == limits for cpu AND memory) runs with -997.
# This reads the manifest text only — no kubectl, no cluster (scripts/nezopt-k3s.sh apply is what applies it) —
# and no YAML tool is assumed, so the parse is awk over the indentation of the exported file.
#
# Usage: scripts/k3s-manifest-check.sh [manifest-path]
#        default <repo>/infra/k3s/pokoin-overflow.yaml
# In the Deployment named pokoin-api it requires, for every container and init container:
#   1. resources.requests.cpu == resources.limits.cpu and resources.requests.memory == resources.limits.memory,
#      all four present and non-empty, compared after stripping quotes;
#   2. a memory limit of at least MIN_MEMORY_LIMIT_MI (only Mi and Gi units are accepted);
#   3. for every HorizontalPodAutoscaler that scales that Deployment: maxReplicas x the pod limits inside
#      HPA_MEMORY_BUDGET_MI and HPA_CPU_BUDGET_MILLI.
# The QoS class it prints is the class implied by the file as written; the API server's defaulting of requests
# from limits is not applied, which is the point: an explicit request is what a reviewer can see.
#
# Exit 0 every rule holds, 1 a rule failed (each one named on its own FAIL line), 2 usage error, unreadable
# file, or awk missing. A failure is never reported as a pass.
set -euo pipefail

# The memory a pokoin-api container must be allowed, and the share of the nezopt node (12 allocatable CPUs,
# 63831852Ki memory) this API may reserve at full autoscale: maxReplicas x the pod limits must fit inside both
# budgets. Raising either number is a capacity decision with the other workloads on this node, not a typo fix.
MIN_MEMORY_LIMIT_MI=1536
HPA_MEMORY_BUDGET_MI=8192
HPA_CPU_BUDGET_MILLI=6000
TARGET_DEPLOYMENT=pokoin-api

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)

if [ $# -gt 1 ]; then
  echo "usage: ${0##*/} [manifest-path]" >&2
  exit 2
fi
manifest=${1:-$root/infra/k3s/pokoin-overflow.yaml}
if [ ! -f "$manifest" ] || [ ! -r "$manifest" ]; then
  echo "k3s-manifest-check: cannot read $manifest" >&2
  exit 2
fi
if ! command -v awk >/dev/null 2>&1; then
  echo "k3s-manifest-check: awk not found; this is a failure, never a pass" >&2
  exit 2
fi

awk_prog=$(cat <<'AWK'
function indent(s) { match(s, /^[ \t]*/); return RLENGTH }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function field(s,  i) { i = index(s, ":"); return i ? substr(s, 1, i - 1) : s }
function value(s,  i, v, q) {
  i = index(s, ":"); if (!i) return ""
  v = trim(substr(s, i + 1))
  sub(/[ \t]+#.*$/, "", v)
  if (length(v) > 1) {
    q = substr(v, 1, 1)
    if ((q == "\047" || q == "\"") && substr(v, length(v), 1) == q) v = substr(v, 2, length(v) - 2)
  }
  return trim(v)
}
function newc() { flushc(); inc = 1 }
function flushc() {
  if (inc) printf "C|%s|%s|%s|%s|%s|%s\n", listtype, cname, rc, rm, lc, lm
  inc = 0; inres = 0; csub = ""; cname = ""; rc = ""; rm = ""; lc = ""; lm = ""
}
function flushdoc() {
  flushc()
  inlist = 0; listind = -1
  if (doc == "Deployment" && docname == target) printf "D|%s\n", docname
  if (doc == "HorizontalPodAutoscaler" && hmax != "") printf "H|%s|%s|%s|%s\n", docname, hkind, hname, hmax
  doc = ""; docname = ""; inmeta = 0; hmax = ""; hkind = ""; hname = ""; inscale = 0
}
BEGIN { doc = ""; docname = ""; inc = 0; inlist = 0; listind = -1; listtype = ""; hmax = "" }
{
  line = $0
  sub(/\r$/, "", line)
  if (line ~ /^[ \t]*$/) next
  if (line ~ /^[ \t]*#/) next
  n = indent(line)
  body = substr(line, n + 1)
  if (body ~ /^---[ \t]*$/) { flushdoc(); next }

  if (n == 0) {
    k = field(body)
    if (k == "apiVersion") flushdoc()
    else if (k == "kind") doc = value(body)
    flushc(); inlist = 0; inscale = 0
    inmeta = (k == "metadata")
    next
  }
  if (inmeta) {
    if (n == 2 && field(body) == "name") docname = value(body)
    next
  }

  if (doc == "HorizontalPodAutoscaler") {
    k = field(body)
    if (n == 2 && k == "maxReplicas") { hmax = value(body); next }
    if (n == 2) { inscale = (k == "scaleTargetRef"); next }
    if (inscale && n == 4) {
      if (k == "kind") hkind = value(body)
      else if (k == "name") hname = value(body)
    }
    next
  }

  if (!(doc == "Deployment" && docname == target)) next

  if (inlist && n < listind) { inlist = 0; flushc() }
  if (!inlist && (body == "containers:" || body == "initContainers:")) {
    inlist = 1; listind = n; listtype = field(body)
    next
  }
  if (inlist) {
    if (n == listind && body ~ /^-[ \t]/) {
      newc()
      head = body; sub(/^-+/, "", head)
      contind = n + 1 + indent(head)
      body = trim(head); n = contind
    } else if (n <= listind) { inlist = 0; flushc(); next }
  }
  if (!inc) next

  k = field(body)
  if (n == contind) {
    if (k == "name") cname = value(body)
    inres = (k == "resources")
    if (inres) { resind = n; csub = "" }
  } else if (inres && n > resind) {
    if (k == "limits" || k == "requests") { csub = k; next }
    if (csub == "") next
    if (k == "cpu") { if (csub == "limits") lc = value(body); else rc = value(body) }
    else if (k == "memory") { if (csub == "limits") lm = value(body); else rm = value(body) }
  } else if (inres && n <= resind) inres = 0
}
END { flushdoc() }
AWK
)

if ! records=$(awk -v target="$TARGET_DEPLOYMENT" "$awk_prog" "$manifest"); then
  echo "k3s-manifest-check: awk failed on $manifest" >&2
  exit 2
fi

problems=0
containers=0
deployment_seen=0
pod_mem_mi=0
pod_cpu_milli=0
totals_ok=1
any_set=0
all_guar=1
hpa_records=()

disp() { if [ -n "$1" ]; then printf '%s' "$1"; else printf '(none)'; fi; }

class_of() { # <reqCpu> <reqMem> <limCpu> <limMem>: the QoS class those four values imply
  if [ -z "$1$2$3$4" ]; then
    printf 'BestEffort\n'
  elif [ -n "$3" ] && [ -n "$4" ] && [ "$1" = "$3" ] && [ "$2" = "$4" ]; then
    printf 'Guaranteed\n'
  else
    printf 'Burstable\n'
  fi
}

mem_mi() { # <value>: 1536Mi / 2Gi -> the size in Mi as an integer, any other unit or format -> nonzero
  awk -v v="$1" 'BEGIN {
    if (v ~ /^[0-9]+Mi$/) printf "%d\n", v + 0
    else if (v ~ /^[0-9]+Gi$/) printf "%d\n", (v + 0) * 1024
    else exit 1
  }'
}

cpu_milli() { # <value>: cores (1, '1', 0.5) or millicores (500m) -> integer millicores, anything else -> nonzero
  awk -v v="$1" 'BEGIN {
    if (v ~ /^[0-9]+(\.[0-9]+)?m$/) { sub(/m$/, "", v); printf "%d\n", int(v * 1 + 0.5) }
    else if (v ~ /^[0-9]+(\.[0-9]+)?$/) printf "%d\n", int(v * 1000 + 0.0005)
    else exit 1
  }'
}

echo "k3s-manifest-check: $manifest, Deployment $TARGET_DEPLOYMENT"

while IFS='|' read -r kind f1 f2 f3 f4 f5 f6; do
  case $kind in
    D)
      deployment_seen=1
      ;;
    H)
      hpa_records+=("$f1|$f2|$f3|$f4")
      ;;
    C)
      containers=$((containers + 1))
      label="${f1}[${f2}]"
      cls=$(class_of "$f3" "$f4" "$f5" "$f6")
      if [ -n "$f3$f4$f5$f6" ]; then any_set=1; fi
      if [ "$cls" != "Guaranteed" ]; then all_guar=0; fi
      printf '  %s requests.cpu=%s requests.memory=%s limits.cpu=%s limits.memory=%s -> %s\n' \
        "$label" "$(disp "$f3")" "$(disp "$f4")" "$(disp "$f5")" "$(disp "$f6")" "$cls"

      miss=""
      for pair in "requests.cpu:$f3" "requests.memory:$f4" "limits.cpu:$f5" "limits.memory:$f6"; do
        if [ -z "${pair#*:}" ]; then miss="$miss ${pair%%:*}"; fi
      done
      if [ -n "$miss" ]; then
        printf '  FAIL %s absent or empty:%s. Guaranteed needs all four, present and equal.\n' "$label" "$miss"
        problems=$((problems + 1))
      fi
      if [ -n "$f3" ] && [ -n "$f5" ] && [ "$f3" != "$f5" ]; then
        printf '  FAIL %s requests.cpu=%s but limits.cpu=%s: equal requests are what make the pod Guaranteed (oom_score_adj -997, not 998).\n' "$label" "$f3" "$f5"
        problems=$((problems + 1))
      fi
      if [ -n "$f4" ] && [ -n "$f6" ] && [ "$f4" != "$f6" ]; then
        printf '  FAIL %s requests.memory=%s but limits.memory=%s: equal requests are what make the pod Guaranteed (oom_score_adj -997, not 998).\n' "$label" "$f4" "$f6"
        problems=$((problems + 1))
      fi

      limit_mi=""
      if [ -n "$f6" ]; then
        if limit_mi=$(mem_mi "$f6"); then
          if [ "$limit_mi" -lt "$MIN_MEMORY_LIMIT_MI" ]; then
            printf '  FAIL %s limits.memory=%s is under the required %sMi.\n' "$label" "$f6" "$MIN_MEMORY_LIMIT_MI"
            problems=$((problems + 1))
          fi
        else
          printf '  FAIL %s limits.memory=%s: only Mi and Gi units are accepted here, so the size cannot be checked.\n' "$label" "$f6"
          problems=$((problems + 1))
        fi
      fi

      limit_milli=""
      if [ -n "$f5" ]; then
        if ! limit_milli=$(cpu_milli "$f5"); then
          printf '  FAIL %s limits.cpu=%s: not a core count (1, 0.5) or a millicore count (500m), so the budget cannot be checked.\n' "$label" "$f5"
          problems=$((problems + 1))
          limit_milli=""
        fi
      fi

      if [ -n "$limit_mi" ] && [ -n "$limit_milli" ]; then
        pod_mem_mi=$((pod_mem_mi + limit_mi))
        pod_cpu_milli=$((pod_cpu_milli + limit_milli))
      else
        totals_ok=0
      fi
      ;;
  esac
done <<<"$records"

if [ "$containers" -gt 0 ]; then
  if [ "$any_set" -eq 0 ]; then pod_cls=BestEffort; oom_adj=1000
  elif [ "$all_guar" -eq 1 ]; then pod_cls=Guaranteed; oom_adj=-997
  else pod_cls=Burstable; oom_adj=998
  fi
  printf '  pod: %s container(s), class %s, oom_score_adj %s\n' "$containers" "$pod_cls" "$oom_adj"
fi

if [ "$deployment_seen" -ne 1 ]; then
  printf '  FAIL no Deployment named %s in %s: nothing was checked.\n' "$TARGET_DEPLOYMENT" "$manifest"
  problems=$((problems + 1))
elif [ "$containers" -eq 0 ]; then
  printf '  FAIL the Deployment %s has no containers block this file could parse: nothing was checked.\n' "$TARGET_DEPLOYMENT"
  problems=$((problems + 1))
fi

if [ "${#hpa_records[@]}" -eq 0 ]; then
  echo "  note: no HorizontalPodAutoscaler in this file, so the replica-budget rule did not run."
fi
for rec in "${hpa_records[@]}"; do
  IFS='|' read -r hname hkind htarget hmax <<<"$rec"
  if [ "$htarget" != "$TARGET_DEPLOYMENT" ] || [ "$hkind" != "Deployment" ]; then
    printf '  HPA %s -> %s/%s maxReplicas=%s: not this Deployment, ignored.\n' "$hname" "$hkind" "$htarget" "$hmax"
    continue
  fi
  if ! [[ $hmax =~ ^[0-9]+$ ]]; then
    printf '  FAIL HPA %s: maxReplicas=%s is not a number.\n' "$hname" "$hmax"
    problems=$((problems + 1))
    continue
  fi
  if [ "$totals_ok" -ne 1 ]; then
    printf '  HPA %s -> %s maxReplicas=%s: budget not computed, a container limit was unusable.\n' "$hname" "$htarget" "$hmax"
    continue
  fi
  want_mem=$((hmax * pod_mem_mi))
  want_cpu=$((hmax * pod_cpu_milli))
  printf '  HPA %s -> %s maxReplicas=%s: %s x pod = %sMi of %sMi, %sm of %sm.\n' \
    "$hname" "$htarget" "$hmax" "$hmax" "$want_mem" "$HPA_MEMORY_BUDGET_MI" "$want_cpu" "$HPA_CPU_BUDGET_MILLI"
  if [ "$want_mem" -gt "$HPA_MEMORY_BUDGET_MI" ]; then
    printf '  FAIL HPA %s: maxReplicas=%s x %sMi = %sMi over the %sMi this API may reserve on the node.\n' \
      "$hname" "$hmax" "$pod_mem_mi" "$want_mem" "$HPA_MEMORY_BUDGET_MI"
    problems=$((problems + 1))
  fi
  if [ "$want_cpu" -gt "$HPA_CPU_BUDGET_MILLI" ]; then
    printf '  FAIL HPA %s: maxReplicas=%s x %sm = %sm over the %sm this API may reserve on the node.\n' \
      "$hname" "$hmax" "$pod_cpu_milli" "$want_cpu" "$HPA_CPU_BUDGET_MILLI"
    problems=$((problems + 1))
  fi
done

if [ "$problems" -ne 0 ]; then
  echo "k3s-manifest-check: FAILED ($problems problem(s))"
  exit 1
fi
echo "k3s-manifest-check: PASS ($containers container(s) Guaranteed, pod limits ${pod_cpu_milli}m/${pod_mem_mi}Mi)"
