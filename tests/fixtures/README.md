# Committed test fixtures

| File | What | Source / licence |
|---|---|---|
| `speech_librivox_gettysburg_10s.wav` | 10.2 s of clean speech, 48 kHz mono 16-bit | LibriVox recording of *The Gettysburg Address* (text by Abraham Lincoln), https://archive.org/details/gettysburg_address_librivox, file `gettysburg_address_lincoln_64kb.mp3`. LibriVox recordings are dedicated to the **public domain** (archive.org licence field: `creativecommons.org/licenses/publicdomain`). Cut with `ffmpeg -ss 13.7 -t 10.2 -ac 1 -ar 48000`. The source is a 64 kbps MP3, so the "clean" reference carries mild MP3 coding artefacts and a low (≈ -50 dB) room noise floor. |
| `noise_freesound_573577.wav` | 4.9 s of background noise, 48 kHz mono | Freesound sound 573577, **CC0**. |

Both are small (< 1 MB). The tests mix them at known SNRs (`tests/lib.mjs`).

`tests/local-fixtures/` (git-ignored) may additionally hold a CC BY-NC speech clip used only for
local experiments. It is never committed or used by CI.
