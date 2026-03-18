#!/usr/bin/env bash
# Night preset — dim amber, easy on eyes
# See ../DEVICES.md for device index mapping
set -euo pipefail

openrgb --device 0 --mode static --color 7A3000  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode static --color 7A3000  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode static --color 7A3000  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode static --color 7A3000  # Corsair Vengeance RGB Pro slot 2
