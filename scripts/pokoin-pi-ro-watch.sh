#!/bin/sh
# Resident after boot: /bin/sh stays in RAM. Do not open the USB disk.
# When RTL9210/VL805 stalls, ext4 sets emergency_ro. Ping still works,
# systemd still pets RuntimeWatchdogSec, dockerd cannot spawn. Reboot.
while true; do
  if grep -q emergency_ro /proc/mounts 2>/dev/null; then
    echo b > /proc/sysrq-trigger
  fi
  sleep 20
done
