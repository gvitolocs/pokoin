#!/bin/bash
# Probe public /healthz from nezopt (not the Pi). Mail Giuseppe on down/up.
# Pi cannot send this mail if the box itself is dead.
set -u
STATE_DIR="${POKOIN_UPTIME_STATE:-/var/lib/pokoin-uptime}"
TO="${POKOIN_UPTIME_MAIL_TO:-vitologiuseppe17@gmail.com}"
FROM="${POKOIN_UPTIME_MAIL_FROM:-Pokoin uptime <no-reply@pokoin.com>}"
HEALTH_URL="${POKOIN_UPTIME_HEALTH_URL:-https://api.pokoin.com/healthz}"
REMIND_SEC="${POKOIN_UPTIME_REMIND_SEC:-1800}"
CONFIRM="${POKOIN_UPTIME_CONFIRM:-2}"
LOG="${POKOIN_UPTIME_LOG:-/var/log/pokoin-uptime-mail.log}"
UA='pokoin-uptime-mail/1'

for envf in /etc/pokoin/uptime-mail.env "${HOME}/.config/pokoin/uptime-mail.env"; do
  if [ -f "$envf" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$envf"
    set +a
  fi
done

mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="${HOME}/.local/state/pokoin-uptime"
mkdir -p "$STATE_DIR" 2>/dev/null || true
mkdir -p "$(dirname "$LOG")" 2>/dev/null || LOG="${STATE_DIR}/uptime.log"

STATUS_FILE="$STATE_DIR/status"
LAST_MAIL_FILE="$STATE_DIR/last_mail"
SINCE_FILE="$STATE_DIR/since"
DOWN_STREAK_FILE="$STATE_DIR/down_streak"
UP_STREAK_FILE="$STATE_DIR/up_streak"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { printf '%s %s\n' "$(ts)" "$*" | tee -a "$LOG" >/dev/null; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 12 -A "$UA" "$HEALTH_URL" 2>/dev/null || true)"
if [ -z "$code" ]; then
  code=000
fi
body="$(head -c 2000 "$tmp" 2>/dev/null || true)"

ok=0
if [ "$code" = "200" ] && grep -q '"ok":true' "$tmp" 2>/dev/null; then
  ok=1
elif [ "$code" = "200" ] && ! grep -q '"ok":false' "$tmp" 2>/dev/null; then
  ok=1
fi

now_epoch="$(date +%s)"
confirmed="$(cat "$STATUS_FILE" 2>/dev/null || echo unknown)"
since="$(cat "$SINCE_FILE" 2>/dev/null || true)"
last_mail="$(cat "$LAST_MAIL_FILE" 2>/dev/null || true)"
last_mail="${last_mail:-0}"
down_streak="$(cat "$DOWN_STREAK_FILE" 2>/dev/null || echo 0)"
up_streak="$(cat "$UP_STREAK_FILE" 2>/dev/null || echo 0)"
case "$down_streak" in *[!0-9]*) down_streak=0 ;; esac
case "$up_streak" in *[!0-9]*) up_streak=0 ;; esac

send_mail() {
  local subject="$1"
  local text="$2"
  python3 - "$TO" "$FROM" "$subject" "$text" <<'PY'
import json, os, smtplib, subprocess, sys, urllib.request
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

to, from_header, subject, body = sys.argv[1:5]
resend_key = (
    os.environ.get("POKOIN_UPTIME_RESEND_API_KEY")
    or os.environ.get("RESEND_API_KEY")
    or ""
).strip()

if resend_key:
    payload = json.dumps({
        "from": from_header,
        "to": [to],
        "subject": subject,
        "text": body,
    }).encode()
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {resend_key}",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) pokoin-uptime-mail/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            if 200 <= resp.status < 300:
                raise SystemExit(0)
    except Exception as err:
        last = err
        if hasattr(err, "read"):
            try:
                last = err.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
        raise SystemExit(f"resend failed: {last}")

msg = EmailMessage()
msg["To"] = to
msg["From"] = from_header
msg["Subject"] = subject
msg["Date"] = formatdate(localtime=True)
msg["Message-ID"] = make_msgid(domain="pokoin.com")
msg.set_content(body)

smtp_host = os.environ.get("POKOIN_UPTIME_SMTP_HOST", "").strip()
smtp_port = int(os.environ.get("POKOIN_UPTIME_SMTP_PORT") or "587")
smtp_user = os.environ.get("POKOIN_UPTIME_SMTP_USER", "").strip()
smtp_pass = os.environ.get("POKOIN_UPTIME_SMTP_PASS", "").strip()

def via_sendmail():
    for cmd in (["sendmail", "-t", "-oi"], ["mail", "-s", subject, to]):
        try:
            if cmd[0] == "mail":
                subprocess.run(cmd, input=body.encode(), check=True)
            else:
                subprocess.run(cmd, input=msg.as_bytes(), check=True)
            return True
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    return False

if smtp_host:
    with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as smtp:
        smtp.ehlo()
        try:
            smtp.starttls()
            smtp.ehlo()
        except smtplib.SMTPException:
            pass
        if smtp_user:
            smtp.login(smtp_user, smtp_pass)
        smtp.send_message(msg)
    raise SystemExit(0)

if via_sendmail():
    raise SystemExit(0)

last_err = None
for mx, port in (("gmail-smtp-in.l.google.com", 25), ("gmail-smtp-in.l.google.com", 587)):
    try:
        with smtplib.SMTP(mx, port, timeout=20) as smtp:
            smtp.ehlo()
            if port == 587:
                smtp.starttls()
                smtp.ehlo()
            smtp.send_message(msg)
        raise SystemExit(0)
    except Exception as err:
        last_err = err
raise SystemExit(f"mail failed: {last_err}")
PY
}

maybe_mail() {
  local kind="$1"
  local subject="$2"
  local text="$3"
  if [ "$kind" = "reminder" ]; then
    if [ "$((now_epoch - last_mail))" -lt "$REMIND_SEC" ]; then
      log "skip reminder (${REMIND_SEC}s)"
      return 0
    fi
  fi
  if send_mail "$subject" "$text"; then
    echo "$now_epoch" >"$LAST_MAIL_FILE"
    log "mailed ${kind} to ${TO}"
  else
    log "mail failed ${kind}"
    return 1
  fi
}

summary="$(printf 'time: %s\nurl: %s\nhttp: %s\nconfirmed: %s\nbody:\n%s\n' "$(ts)" "$HEALTH_URL" "$code" "$confirmed" "$body")"

if [ "$ok" = "1" ]; then
  echo 0 >"$DOWN_STREAK_FILE"
  up_streak=$((up_streak + 1))
  echo "$up_streak" >"$UP_STREAK_FILE"
  if [ "$confirmed" = "down" ] && [ "$up_streak" -ge "$CONFIRM" ]; then
    maybe_mail up "Pokoin is back" "$(printf 'Pokoin /healthz is 200 again.\n\n%s\n' "$summary")" || exit 1
    echo up >"$STATUS_FILE"
  elif [ "$confirmed" != "down" ]; then
    echo up >"$STATUS_FILE"
  else
    log "up pending ${up_streak}/${CONFIRM} http=${code}"
    exit 0
  fi
  log "up http=${code}"
  exit 0
fi

echo 0 >"$UP_STREAK_FILE"
down_streak=$((down_streak + 1))
echo "$down_streak" >"$DOWN_STREAK_FILE"
if [ "$confirmed" != "down" ] && [ "$down_streak" -ge "$CONFIRM" ]; then
  echo "$now_epoch" >"$SINCE_FILE"
  maybe_mail down "Pokoin is down" "$(printf 'Pokoin /healthz is not OK. Public pages should show “We are working on a solution.”\n\n%s\n' "$summary")" || exit 1
  echo down >"$STATUS_FILE"
elif [ "$confirmed" = "down" ]; then
  maybe_mail reminder "Pokoin is still down" "$(printf 'Pokoin /healthz is still not OK (since %s).\n\n%s\n' "${since:-unknown}" "$summary")" || exit 1
else
  log "down pending ${down_streak}/${CONFIRM} http=${code}"
  echo up >"$STATUS_FILE"
  exit 0
fi
log "down http=${code}"
exit 0
