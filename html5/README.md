# PowerSlave Exhumed — HTML5 port

A browser (WebGL2 + WebAudio) port of PowerSlave Exhumed. It runs the game's own
content straight from your copy of the game: maps, textures, sprites, sounds,
music, definitions and the AngelScript game scripts. No game data is included
in this folder.

## Running it

ES modules need to be served over HTTP; opening `index.html` from disk won't work.

**Option A: serve the game folder** (the page finds `PowerslaveEX.kpf` and `music/` itself):

```sh
cd "/path/to/GOG Games/PowerSlave Exhumed"
python3 -m http.server 8000
# open http://localhost:8000/html5/
```

**Option B: host the `html5/` folder anywhere** (any static web server). On first
launch the page asks you to pick your PowerSlave Exhumed install folder (or just
`PowerslaveEX.kpf`). The data is cached in the browser's IndexedDB for later visits.

Requires a browser with WebGL2 (current Chrome, Edge, Firefox or Safari 15+).

### Cutscenes in Chrome, Edge and Brave

The game's movies are Ogg Theora (`movies/*.ogv`), which Chromium-based browsers no
longer play. Convert them once to WebM (VP9 video, Opus audio) with
[ffmpeg](https://ffmpeg.org/); the port uses the `.webm` copies when they exist and
falls back to the `.ogv` files in browsers that still support Theora (Firefox):

```sh
sh html5/tools/convert-movies.sh            # VP9 + Opus, a few minutes
sh html5/tools/convert-movies.sh --av1      # or AV1 + Opus (smaller, slower to encode)
```

The script writes `movies/<name>.webm` next to each `.ogv` and leaves the originals alone.
On Windows, the same conversion for one file is:

```bat
ffmpeg -i movies\intro-en.ogv -map 0:v:0 -map 0:a:0? -c:v libvpx-vp9 -crf 31 -b:v 0 -row-mt 1 -c:a libopus -b:a 112k movies\intro-en.webm
```

If you use the folder picker (Option B), pick the folder again after converting.

## Controls

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / strafe | W A S D | Left stick |
| Look | Mouse (click the game to capture it) | Right stick |
| Attack | Left click / Ctrl | Triggers |
| Jump / swim up | Space | A / Cross |
| Use (doors, switches) | E / F / Right click | X / Square |
| Weapons | 1–8, mouse wheel, [ ] | Bumpers |
| Automap / zoom | Tab, + / − | Back |
| Inventory | Shift / I | Y / Triangle |
| Menu | Esc | Start |

Progress, checkpoints and settings are saved in the browser's `localStorage`.

## Developer URL parameters

- `?map=N` loads map N directly (0 = Tomb of Ramses ... 24 = Tomb end).
- `&debug=1` shows position, sector and errors.
- `&warp=x,y,z&yaw=deg` places the player.
- `&allweapons=1` gives all weapons.
- `&test=forward:120,use:5,attack:60` scripts input for automated tests.
- `&data=<url>` sets where to fetch `PowerslaveEX.kpf` from.
- `&novis=1` draws every sector instead of using portal visibility (for comparing).
- `?movie=intro` plays a cutscene (`intro`, `goodend`, `badend`, `NightDive`, `Kex`, `throwback`).
- `?overworld=N&unlock=0,1,3` opens the overworld with map N selected and the listed maps unlocked.

## How it works

| File | Purpose |
|---|---|
| `src/kpf.js` | Reads the `.kpf` (zip) archive |
| `src/mapfile.js` | `PSM\x01` map loader (layout reverse engineered from the shipped maps and the GPL loader) |
| `src/world.js`, `src/cmodel.js` | Sectors, events, sector movement, collision and traces |
| `src/actor.js`, `src/ai.js`, `src/projectile.js`, `src/pickups.js`, `src/player.js`, `src/movers.js` | Game objects |
| `src/actions.js` | Built-in sprite-frame actions (`A_HitScan`, `A_FireProjectile`, ...) |
| `src/script/` | AngelScript→JavaScript compiler plus the `kexSlave*` script API. The game's own `scripts/*.txt` (monster logic, weapon behaviour, level events, the Ramses sequences) run unmodified |
| `src/render.js`, `src/draw.js` | WebGL2 renderer, including the Saturn-style sky dome shader ported from `progs/SlaveSkyDome.shader` |
| `src/portals.js` | Portal visibility: only sectors reachable from the camera through on-screen openings are drawn, as in the original engine (the maps rely on it: rooms overlap and their tops aren't modelled) |
| `src/hud.js`, `src/menus.js` | Status bar, title, overworld, pause and inventory screens |

The engine follows the GPL PowerslaveEX source by Samuel Villarreal, which the
KEX remaster grew out of. Behaviour specific to Exhumed was recovered with REA
(reverse-engineer-anything) and Ghidra from `anubis_Shipping_Galaxy_x64.exe`:

- the AngelScript API registration strings (method names and types),
- the map-actor spawn path, including the per-difficulty monster filter in `params1`,
- the laser-beam and checkpoint classes,
- radial blast damage and breakable-wall destruction (`FUN_1401a16b0`, `FUN_1401b8800`),
- the overworld screen (`kexSlaveOverworldLocal`): the HD `gfx/overworld.dds` map (or the original one, under Options),
  the camera easing and travel zoom, the Eye of Ra cursor, the ankh arrows (pulsing for unlocked neighbours,
  grey for locked ones) and the transmitter beep,
- the camel travel prompt, which picks the destination from the way the camel faces,
- the credits roll (game state 8), whose text is read from your own exe at runtime,
- monster AI (`kexSlaveAI`): 16-direction stepping, eased turning, the 300-think lost-sight timeout,
  per-difficulty range-attack cooldowns, `moveDelayMin/Max`, `chaseWander`, retaliation when hurt and the
  Pharaoh pain-chance/speed changes; melee reach is `(radius + target radius) × 1.2 + meleeExtraDist`,
- player movement (`kexSlavePuppet`): 1.5675 acceleration with a 17.5 top speed, the jump and Sandals
  values, fall damage, Shawl/Feather falling, and swimming (Dolphin speed, surface bobbing).

## Known differences from the PC remaster

- No subtractive/CRT shading modes, bloom or ambient occlusion. The world uses the
  baked vertex lighting with modulate shading plus simple dynamic lights.
- Cutscenes need the WebM conversion above in Chromium browsers; without it they're
  skipped there. The intro and logo movies aren't played at startup yet.
- No weapon wheel, rumble patterns or achievements.

## License

The engine code is a derivative of the GPL-2.0 PowerslaveEX source and is
distributed under the GNU GPL v2 or later. PowerSlave Exhumed game data belongs
to its owners and must come from your own copy of the game.
