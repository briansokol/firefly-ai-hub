#!/usr/bin/env bash
# Gaming preset — rainbow wave
# See ../DEVICES.md for device index mapping
# Note: not all devices support 'rainbow' mode; falls back to static purple if unsupported
set -euo pipefail

openrgb --device 0 --mode rainbow  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode rainbow  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode rainbow  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode rainbow  # Corsair Vengeance RGB Pro slot 2
