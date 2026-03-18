#!/usr/bin/env bash
# Work preset — static cool blue-white
# See ../DEVICES.md for device index mapping
set -euo pipefail

openrgb --device 0 --mode static --color 4A90D9  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode static --color 4A90D9  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode static --color 4A90D9  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode static --color 4A90D9  # Corsair Vengeance RGB Pro slot 2
