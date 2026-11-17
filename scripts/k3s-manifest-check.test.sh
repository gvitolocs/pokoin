#!/usr/bin/env bash
# Tests for scripts/k3s-manifest-check.sh with manifest fixtures this file writes (never the cluster, never kubectl).
# Usage: bash scripts/k3s-manifest-check.test.sh
# Exit 0 all cases passed, 1 a case failed, 2 the script under test is missing.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
check=$root/scripts/k3s-manifest-check.sh
if [ ! -r "$check" ]; then
  echo "k3s-manifest-check.test: $check not readable; cannot run" >&2
  exit 2
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/k3s-manifest-check-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

fails=0

# The four resource values of the passing shape, quoted exactly as the exported manifest writes them.
GUAR="        resources:
          limits:
            cpu: '1'
            memory: 1536Mi
          requests:
            cpu: '1'
            memory: 1536Mi"

# mk <out-file> <api-container-tail> <extra-containers> <initContainers-block> <maxReplicas>
# The fixture carries the shapes the real manifest carries: a second Deployment whose values are deliberately wrong,
# an HPA that targets it, env/volumeMount list items whose keys are also called name, and an empty-ish pod spec.
mk() {
  local f=$1 res=$2 extra=$3 init=$4 maxr=$5
  cat >"$f" <<EOF
# fixture manifest for scripts/k3s-manifest-check.test.sh
apiVersion: v1
kind: Namespace
metadata:
  name: pokoin-overflow
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: pokoin-overflow
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: redis
        image: redis:8
        resources:
          limits:
            cpu: '2'
            memory: 768Mi
          requests:
            cpu: 500m
            memory: 128Mi
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: redis
  namespace: pokoin-overflow
spec:
  maxReplicas: 99
  minReplicas: 1
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: redis
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pokoin-api
  namespace: pokoin-overflow
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app: pokoin-api
    spec:
      automountServiceAccountToken: false
$init
      containers:
      - name: api
        image: gcr.io/distroless/cc-debian12:nonroot
        env:
        - name: POKOIN_EDGE_BIND
          value: 0.0.0.0:8080
        - name: POKOIN_RUST_BIND
          value: 127.0.0.1:18082
$res
$extra
        securityContext:
          readOnlyRootFilesystem: true
        volumeMounts:
        - mountPath: /tmp
          name: tmp
      serviceAccountName: pokoin-api
      volumes:
      - emptyDir:
          sizeLimit: 64Mi
        name: tmp
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pokoin-api
  namespace: pokoin-overflow
spec:
  maxReplicas: $maxr
  metrics:
  - resource:
      name: cpu
      target:
        averageUtilization: 60
        type: Utilization
    type: Resource
  minReplicas: 2
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pokoin-api
EOF
}

run() { # run <expected-exit> <label> [args...]: the check on a fixture; sets LAST_OUT
  local want=$1 label=$2 out rc
  shift 2
  set +e
  out=$(bash "$check" "$@" 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq "$want" ]; then
    echo "ok   $label (exit $rc)"
  else
    echo "FAIL $label: expected exit $want, got $rc"
    printf '%s\n' "$out" | sed 's/^/     | /'
    fails=$((fails + 1))
  fi
  LAST_OUT=$out
}

says() { # says <label> <substring the output must contain>
  case $LAST_OUT in
    *"$2"*) echo "ok   $1" ;;
    *)
      echo "FAIL $1: no '$2' in the output"
      printf '%s\n' "$LAST_OUT" | sed 's/^/     | /'
      fails=$((fails + 1))
      ;;
  esac
}

says_not() { # says_not <label> <substring the output must not contain>
  case $LAST_OUT in
    *"$2"*)
      echo "FAIL $1: '$2' is in the output"
      printf '%s\n' "$LAST_OUT" | sed 's/^/     | /'
      fails=$((fails + 1))
      ;;
    *) echo "ok   $1" ;;
  esac
}

# 1. the real shape: requests == limits for cpu and memory, 1536Mi, HPA maxReplicas 4.
#    Also proves the redis Deployment above (Burstable) and its HPA (maxReplicas 99) are ignored.
mk "$tmp/good" "$GUAR" "" "" 4
run 0 "the real shape passes" "$tmp/good"
says "the container line names the class" "Guaranteed"
says "the container line carries the four values" "requests.cpu=1 requests.memory=1536Mi limits.cpu=1 limits.memory=1536Mi"
says "the other Deployment's HPA is ignored" "HPA redis -> Deployment/redis maxReplicas=99: not this Deployment, ignored"
says "only this Deployment's container counts" "PASS (1 container(s) Guaranteed"

# 2. requests below limits (the shipped 2026-11-17 shape): 1, and the line says Burstable.
mk "$tmp/burstable" "        resources:
          limits:
            cpu: '2'
            memory: 768Mi
          requests:
            cpu: 500m
            memory: 128Mi" "" "" 4
run 1 "requests below limits" "$tmp/burstable"
says "the line says Burstable" "containers[api] requests.cpu=500m requests.memory=128Mi limits.cpu=2 limits.memory=768Mi -> Burstable"
says "both mismatches named" "requests.cpu=500m but limits.cpu=2"

# 3. no requests block at all.
mk "$tmp/norequests" "        resources:
          limits:
            cpu: '1'
            memory: 1536Mi" "" "" 4
run 1 "missing requests block" "$tmp/norequests"
says "the missing keys are named" "absent or empty: requests.cpu requests.memory"

# 4. memory request equal, cpu request not.
mk "$tmp/cpuonly" "        resources:
          limits:
            cpu: '2'
            memory: 1536Mi
          requests:
            cpu: 500m
            memory: 1536Mi" "" "" 4
run 1 "cpu unequal, memory equal" "$tmp/cpuonly"
says "the cpu mismatch is named" "requests.cpu=500m but limits.cpu=2"
says_not "a matched memory pair is not complained about" "requests.memory=1536Mi but"

# 5. memory limit 768Mi with an equal request: Guaranteed class, but too small.
mk "$tmp/small" "        resources:
          limits:
            cpu: '1'
            memory: 768Mi
          requests:
            cpu: '1'
            memory: 768Mi" "" "" 4
run 1 "memory limit 768Mi" "$tmp/small"
says "the floor is named" "is under the required 1536Mi"

# 6. maxReplicas 8: 8 x 1536Mi and 8 x 1 CPU over the node budget.
mk "$tmp/maxr8" "$GUAR" "" "" 8
run 1 "maxReplicas 8" "$tmp/maxr8"
says "the memory budget is named" "x 1536Mi = 12288Mi over the 8192Mi"
says "the cpu budget is named" "x 1000m = 8000m over the 6000m"

# 7. a second container of the same pod without resources (also how a sidecar breaks Guaranteed).
mk "$tmp/sidecar" "$GUAR" "      - name: cloudflared
        image: cloudflare/cloudflared:2024.6.1
        args:
        - tunnel
        - --no-autoupdate" "" 4
run 1 "a second container without resources" "$tmp/sidecar"
says "it names the container" "containers[cloudflared] absent or empty: requests.cpu"
says "the line says Burstable" "Burstable"

# 8. an init container without equal requests.
mk "$tmp/init" "$GUAR" "" "      initContainers:
      - name: wait-for-pg
        image: postgres:15
        resources:
          limits:
            cpu: '1'
            memory: 1536Mi
          requests:
            cpu: 100m
            memory: 64Mi" 4
run 1 "an unequal init container" "$tmp/init"
says "it names the init container" "initContainers[wait-for-pg] requests.cpu=100m but limits.cpu=1"
# 8b. with the init container fixed, the same pod passes.
mk "$tmp/initok" "$GUAR" "" "      initContainers:
      - name: wait-for-pg
        image: postgres:15
        resources:
          limits:
            cpu: '1'
            memory: 1536Mi
          requests:
            cpu: '1'
            memory: 1536Mi" 4
run 0 "an equal init container too" "$tmp/initok"

# 9. units: 2Gi is 2048Mi (>= the floor, and 4 x 2048Mi is exactly the budget); 1536M is not a unit this checks.
mk "$tmp/gi" "        resources:
          limits:
            cpu: '1'
            memory: 2Gi
          requests:
            cpu: '1'
            memory: 2Gi" "" "" 4
run 0 "2Gi is accepted" "$tmp/gi"
mk "$tmp/badunit" "        resources:
          limits:
            cpu: '1'
            memory: 1536M
          requests:
            cpu: '1'
            memory: 1536M" "" "" 4
run 1 "a non-Mi/Gi memory unit" "$tmp/badunit"
says "the unit is named" "only Mi and Gi units are accepted"

# 10. a manifest without the Deployment: nothing was checked, so it must not pass.
printf 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: pokoin-overflow\n' >"$tmp/nodate"
run 1 "no pokoin-api Deployment" "$tmp/nodate"
says "it says so" "no Deployment named pokoin-api"

# 11. usage errors and an unreadable path are 2, never 1 and never 0.
run 2 "two paths are a usage error" "$tmp/good" "$tmp/good"
run 2 "a missing file" "$tmp/does-not-exist.yaml"

# 12. the manifest this repository actually ships.
run 0 "the real infra/k3s/pokoin-overflow.yaml" "$root/infra/k3s/pokoin-overflow.yaml"

if [ "$fails" -ne 0 ]; then
  echo "k3s-manifest-check.test: $fails failure(s)"
  exit 1
fi
echo "k3s-manifest-check.test: all cases passed"
