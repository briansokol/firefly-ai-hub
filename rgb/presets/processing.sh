#!/usr/bin/env bash
# Processing preset — bright sky blue
# See ../DEVICES.md for device index mapping
set -euo pipefail

openrgb --device 0 --mode static --color 00AAFF  # Gigabyte IT8297 (ARGB fans)
openrgb --device 1 --mode static --color 00AAFF  # ASUS ROG STRIX RTX 3090
openrgb --device 2 --mode static --color 00AAFF  # Corsair Vengeance RGB Pro slot 1
openrgb --device 3 --mode static --color 00AAFF  # Corsair Vengeance RGB Pro slot 2
