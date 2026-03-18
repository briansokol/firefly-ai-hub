#!/usr/bin/env bash
# Off preset — all LEDs black
# See ../DEVICES.md for device index mapping
set -euo pipefail

openrgb --device 0 --mode static --color 000000  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode static --color 000000  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode static --color 000000  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode static --color 000000  # Corsair Vengeance RGB Pro slot 2
