#!/bin/bash
# Harden Pi 4 USB3 root (Samsung 990 PRO behind Realtek RTL9210).
# Keeps the OS on the external NVMe. Does not move root to the SD card.
#
# Cause we are fixing: VL805 + RTL9210 stalls under CDN load. Ping stays up,
# sshd/API/disk freeze (D-state). UAS is already ignored; U1/U2 LPM still
# fails at enumerate. See dmesg "Enable of device-initiated U1/U2 failed".
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root on pi-home" >&2
  exit 1
fi

CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if [ ! -f "$CMDLINE" ]; then
  echo "no cmdline.txt" >&2
  exit 1
fi

VID=0bda
PID=9210

ensure_token() {
  local file="$1"
  local token="$2"
  local line
  line="$(tr -d '\n' <"$file")"
  case " $line " in
    *" $token "*) ;;
    *)
      printf '%s %s\n' "$line" "$token" >"$file"
      ;;
  esac
}

ensure_token "$CMDLINE" "usb-storage.quirks=${VID}:${PID}:u"
ensure_token "$CMDLINE" "usbcore.quirks=${VID}:${PID}:k"
ensure_token "$CMDLINE" "usbcore.autosuspend=-1"
sync "$CMDLINE" /boot/firmware 2>/dev/null || sync

cat >/etc/modprobe.d/rtl9210-ignore-uas.conf <<'EOF'
# RTL9210 USB-NVMe: UAS on Pi 4 VL805 dies under write. usb-storage instead.
options usb-storage quirks=0bda:9210:u
EOF

cat >/etc/udev/rules.d/99-rtl9210-no-autosuspend.rules <<'EOF'
# Root disk is this device. Autosuspend / USB3 LPM drops the bus.
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="9210", TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="9210", TEST=="power/autosuspend", ATTR{power/autosuspend}="-1"
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="9210", TEST=="power/usb3_hardware_lpm_u1", ATTR{power/usb3_hardware_lpm_u1}="disabled"
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="9210", TEST=="power/usb3_hardware_lpm_u2", ATTR{power/usb3_hardware_lpm_u2}="disabled"
EOF

# Live apply (next reboot still required for EEPROM / kernel / cmdline).
if [ -d /sys/bus/usb/devices ]; then
  for d in /sys/bus/usb/devices/*; do
    [ -f "$d/idVendor" ] || continue
    [ "$(cat "$d/idVendor")" = "$VID" ] || continue
    [ "$(cat "$d/idProduct")" = "$PID" ] || continue
    { echo on >"$d/power/control"; } 2>/dev/null || true
    { echo -1 >"$d/power/autosuspend"; } 2>/dev/null || true
    { echo disabled >"$d/power/usb3_hardware_lpm_u1"; } 2>/dev/null || true
    { echo disabled >"$d/power/usb3_hardware_lpm_u2"; } 2>/dev/null || true
  done
fi

echo "usb-storage (not UAS) + no LPM/autosuspend for ${VID}:${PID}"
echo "cmdline: $(tr -d '\n' <"$CMDLINE")"
echo "OS stays on $(findmnt -n -o SOURCE /). Reboot after rpi-eeprom + kernel packages."
