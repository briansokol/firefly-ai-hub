# RGB Device Index Map

After installing OpenRGB, run `openrgb --list-devices` and fill in the device indices below.
Then update the device numbers in each `presets/*.sh` file to match.

```
$ openrgb --list-devices
```

## Expected devices

| Index | Expected device | Preset script comment |
|-------|-----------------|-----------------------|
| ?     | Gigabyte B550M (IT8297) — controls ARGB fan header | `# Gigabyte IT8297 (ARGB fans)` |
| ?     | ASUS ROG STRIX RTX 3090 | `# ASUS ROG STRIX RTX 3090` |
| ?     | Corsair Vengeance RGB Pro (slot 1) | `# Corsair Vengeance RGB Pro slot 1` |
| ?     | Corsair Vengeance RGB Pro (slot 2) | `# Corsair Vengeance RGB Pro slot 2` |

## Notes

- The Corsair RAM appears via SMBus — requires `i2c-dev` and `i2c-piix4` modules loaded
- If a device doesn't appear, check: `ls /dev/i2c-*` (should show i2c buses)
- Available modes per device: `openrgb --device N --list-modes`
- The `gaming` preset uses `rainbow` mode — if a device doesn't support it, run
  `openrgb --device N --list-modes` to see what's available and update `presets/gaming.sh`
