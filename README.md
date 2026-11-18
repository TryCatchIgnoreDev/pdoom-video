# I'm Upping My P(doom) — LLM Arithmetic Coding Visualization

A real-time WebGL / Three.js music-video visualization comparing **LLM arithmetic coding (`Qwen3.5-9B-Base`)** against **traditional compression (`zlib -9`)** live over the synced lyrics of *"I'm Upping My P(doom)"*, inspired by **3Blue1Brown**'s latest video and built on top of [`mexicat/pdoom-video`](https://github.com/mexicat/pdoom-video).

Every frame is a deterministic function of song time `t`, so interactive browser preview and offline 1080p60 / 4K60 renders are pixel-identical.

- **Watch (1080p60):** https://youtu.be/lfLOvUfdljQ
- **Watch Shorts (1080×1920, 60fps):** https://youtube.com/shorts/450JT-PPimk
- **Original `mexicat/pdoom-video` 4K release:** https://www.youtube.com/watch?v=5EoO5413dBY

---

## Compression Benchmark (`"I'm Upping My P(doom)"` Lyrics)

Exact lossless compression trace computed across all **374 BPE tokens** (`1,326 bytes` / `1,322 chars` of aligned UTF-8 lyrics) using **Qwen3.5-9B-Base** (`Q4_K_S.gguf`, `vocabSize = 248,320`, `28`-bit Softmax CDF + `62`-bit arithmetic coder) versus `zlib.compress(..., level=9)`:

| Stream / Method | Compressed Size | Payload Bits | Bits / Byte | Compression Ratio |
|---|---:|---:|---:|---:|
| **Raw UTF-8 Lyrics** | `1,326 B` | `10,608 b` | `8.00 bpb` | `1.00×` |
| **`zlib -9` (Traditional)** | `772 B` | `6,176 b` | `4.66 bpb` | `1.72×` |
| **`Qwen3.5-9B-Base` Arithmetic Coding** | **`294 B`** (`22 B` header + `272 B` payload) | **`2,176 b`** (`2,168.87` entropy bits) | **`1.77 bpb`** | **`4.51×`** |

Lossless round-trip verified in `data/lyrics.llmc` (`exactMatch: true`, SHA-256 `ed9bc5895d484e55891d6bb9cbb41f3255d79a15f72678176bfddaf2627006c9`).

---

## Key Additions Over Upstream

- **Scene-Native Arithmetic Coding HUD (`app/src/engine/compression.ts`, `engine.ts`, `post.ts`):**
  - Composited into the HDR pipeline before tone-mapping, film grain, and vignette, automatically inverting into ink-on-paper colors on light plates.
  - Hand-tuned corner schedule (`CORNER_SCHEDULE`) anchored to clean margins with smooth transitions at scene and lyric boundaries.
  - Real-time cumulative byte & ratio readout, per-token probability interval ladder, 1000-digit decimal zoom axis (`data/compression.json`), and live `LLM ARITHMETIC` vs `ZLIB -9 (TRADITIONAL)` bitstreams.
  - Live toggle with **`c`** or the **Encoder** button (`app/index.html`, `app/src/main.ts`).
- **Qwen3.5-9B Arithmetic Coding & Trace Pipeline (`analysis/compress_lyrics.py`):**
  - Runs deterministic Softmax CDF + 62-bit arithmetic coding over `data/lyrics.json` via `llama-cpp` / `llm-compressor` and verifies byte-for-byte `zlib -9` and round-trip reconstruction.
- **Node.js Offline Renderer (`app/scripts/render_node.mjs`):**
  - Node v24 + `playwright-core` headless Chrome + RFC-6455 WebSocket raw `rgb24` frame pipeline into `ffmpeg` (`libx264`, default `--crf 19`, `--preset slow`, explicit `bt709` color tagging, `320k` AAC audio), avoiding Bun Playwright Windows pipe hangs while supporting `stills`, `sheet`, `perf`, and `video`.

---

## Repository Layout

- `audio/pdoom.mp3` — Song audio (Claude-Pop Suno version; see [Credits](#credits)).
- `lyrics/lyrics.src.js` — Line-level source lyrics with timestamps.
- `data/lyrics.json`, `data/lyrics.approx.json` — Word/syllable-level lyric timings.
- `data/compression.json`, `data/lyrics.llmc` — Verified `Qwen3.5-9B-Base` arithmetic coding + `zlib -9` comparison trace and compressed binary.
- `data/audio.json` — Tempo (`132.007 BPM`), beats, downbeats, sections, onsets, and loudness envelopes.
- `analysis/` — Python tools for forced alignment (`align.py`, `analyze.py`) and LLM arithmetic compression trace generation (`compress_lyrics.py`).
- `app/` — TypeScript + Three.js + Vite renderer (`src/engine/`, `src/scenes/`, `src/timeline.ts`, `scripts/render.ts`, `scripts/render_node.mjs`).
- `docs/` — [`docs/TREATMENT.md`](docs/TREATMENT.md) and [`docs/ENGINE.md`](docs/ENGINE.md).
- `out/` — Exported renders (gitignored).

---

## Requirements

- [Node.js](https://nodejs.org/) (v22+/v24+) or [Bun](https://bun.sh)
- Google Chrome / Chromium (driven headless via `playwright-core`)
- `ffmpeg` (`libx264` + `aac`) on `PATH`
- Optional for regenerating `data/compression.json`: Python environment with `llm-compressor` / `llama-cpp-python` and `Qwen3.5-9B-Base.Q4_K_S.gguf`

---

## Interactive Preview

```sh
cd app
npm install   # or: bun install
npm run preview:lan
```

Open `http://localhost:5173` (or the LAN URL printed by Vite). Append `?t=110` to jump directly to the transformer bridge, or `?export=1` for clean viewport mode.

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Seek ±1 s (±5 s with `Shift`) |
| `,` / `.` | Step one frame (at 60 fps) |
| `[` / `]` | Previous / next scene |
| `l` | Loop the current scene |
| `h` | Hide / show UI bar |
| `c` | Show / hide the arithmetic coding overlay |

---

## Rendering Offline Video

### Cross-platform Node.js Renderer (Recommended on Windows)

```sh
cd app
node scripts/render_node.mjs video --samples auto --shutter 0.2 --crf 19 --preset slow --out ../out/pdoom-1080p60.mp4
```

To also produce a vertical 9:16 **YouTube Shorts** version (`1080×1920`, rotated 90° clockwise):

```sh
ffmpeg -y -i out/pdoom-1080p60.mp4 -vf "transpose=1,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -x264-params aq-mode=3 -c:a copy -movflags +faststart out/pdoom-shorts-1080x1920-60fps.mp4
```

Other modes supported by `render_node.mjs`: `stills --t 20.1,73.8,111.7`, `sheet --from 0 --to 10 --n 12`, and `perf --from 0 --to 5`.

### Upstream Bun Renderer (`4K` / `macOS`)

```sh
cd app
bun scripts/render.ts video --scale 2 --samples auto --shutter 0.2 --x264 aq-mode=3:rc-lookahead=30 --out ../out/pdoom-4k.mp4
```

---

## Regenerating Compression Trace (`data/compression.json`)

```sh
python analysis/compress_lyrics.py
```

By default this loads `Qwen3.5-9B-Base.Q4_K_S.gguf` from `~/.lmstudio/models/...`, compresses the lyric timeline extracted from `data/lyrics.json`, checks lossless SHA-256 reconstruction, computes the byte-aligned `zlib -9` trace, and writes `data/lyrics.llmc` and `data/compression.json`.

---

## Credits

- **Original Render Engine & Music Video:** [`mexicat/pdoom-video`](https://github.com/mexicat/pdoom-video) by **Giacomo Magnanini** ([Watch original 4K](https://www.youtube.com/watch?v=5EoO5413dBY)).
- **Inspiration:** Inspired by [3Blue1Brown](https://www.youtube.com/@3blue1brown)'s latest video on compression & information theory / LLMs.
- **Song ("I'm Upping My P(doom)"):** Lyrics by [osmarks](https://docs.osmarks.net/hypha/p%28doom%29_song_objectively_correct_interpretation), built on an opening verse and chorus by [MusicPerson](https://www.udio.com/creators/MusicPerson) with suggestions from the EleutherAI Discord and Claude. Original generated with Udio (November 2024, [YouTube](https://www.youtube.com/watch?v=uEB5E67vcPA)). This project uses the `"Claude-Pop"` Suno version posted by [deckard (@slimer48484)](https://x.com/slimer48484/status/2097752569212756134) (September 2026).
- **Fonts:** Archivo, IBM Plex Mono, and Cormorant Garamond (SIL Open Font License); single-stroke EMS and Hershey fonts via `hersheytext` (OFL / public domain).

---

## License

The source code (both upstream [`mexicat/pdoom-video`](https://github.com/mexicat/pdoom-video) and the additions in this fork) is released under the [MIT License](LICENSE). Fonts in `app/public/fonts/` retain their respective licenses, and the song/lyrics (`audio/`, `lyrics/`, `data/lyrics.json`) remain the property of their respective authors (see [Credits](#credits)).
