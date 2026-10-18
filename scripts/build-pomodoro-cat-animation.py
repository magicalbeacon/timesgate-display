"""Author the original six-frame pixel-cat loop; Pillow is authoring-only.

Usage:
    python scripts/build-pomodoro-cat-animation.py          # write + validate
    python scripts/build-pomodoro-cat-animation.py --check  # validate, no writes

Use Pillow 12.3.0 to reproduce the checked-in bytes exactly. The runtime uses only
its embedded Buffer. Existing static art/source files are read, never rewritten.
Preview digits are illustrative, not a reproduction of Divoom's native font.
The frame/size/duration budgets below are engineering constraints, NOT proof of
Times Gate firmware compatibility; an authorized device check is still needed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
from io import BytesIO
from pathlib import Path
import re
import runpy
import struct

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
STATIC = runpy.run_path(str(ROOT / 'scripts/build-pomodoro-cat.py'))
COLORS = STATIC['COLORS']
SIZE = (128, 128)
# Centisecond-aligned holds make the small movement legible without a frantic loop.
DURATIONS_MS = (780, 140, 160, 140, 120, 1000)
FRAME_LABELS = ('Rest', 'Paw lifted', 'Key tap', 'Paw lifted', 'Blink', 'Settle')
MAX_FRAMES = 8
MAX_GIF_BYTES = 32768
MAX_LOOP_MS = 5000
GIF_PATH = 'assets/pomodoro-cat-loop-v1.gif'
MODULE_PATH = 'src/pomodoro-cat-animation.ts'
PREVIEW_128 = 'assets/pomodoro-cat-loop-preview-128.gif'
PREVIEW_512 = 'assets/pomodoro-cat-loop-preview-512.gif'
CONTACT_SHEET = 'assets/pomodoro-cat-loop-contact-sheet.png'
STATIC_PATHS = (
    'scripts/build-pomodoro-cat.py', 'src/pomodoro-cat-background.ts',
    'assets/pomodoro-cat-v2.gif', 'assets/pomodoro-cat-focus-128.png',
    'assets/pomodoro-cat-focus-512.png', 'assets/pomodoro-cat-break-concept.gif',
    'assets/pomodoro-cat-break-concept-128.png',
    'assets/pomodoro-cat-break-concept-512.png',
)


def static_snapshot():
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in STATIC_PATHS}


def animation_frames():
    """Keep the original silhouette; animate one typing paw and a brief blink."""
    base = STATIC['scene']().resize((64, 64), Image.Resampling.NEAREST)
    frames = []
    for state in ('rest', 'lift', 'tap', 'lift', 'blink', 'rest'):
        im = base.copy()
        d = ImageDraw.Draw(im)
        if state in ('lift', 'tap'):
            # Restore the tiny area under the static paw (body/belly/desktop).
            d.rectangle((24, 38, 24, 39), fill=4)
            d.rectangle((25, 38, 29, 39), fill=7)
            d.rectangle((25, 40, 29, 40), fill=12)
            if state == 'lift':
                d.rectangle((24, 36, 30, 37), fill=7)
                d.rectangle((25, 38, 30, 38), fill=5)
            else:
                # Reach toward the near edge of the keyboard by four grid pixels.
                d.rectangle((24, 38, 33, 39), fill=7)
                d.rectangle((25, 40, 32, 40), fill=5)
        if state == 'blink':
            for x in (21, 35):
                d.rectangle((x, 25, x + 2, 28), fill=4)
                d.line((x, 27, x + 2, 27), fill=1)
        frames.append(im.resize(SIZE, Image.Resampling.NEAREST))
    return frames


def read_subblocks(data, pos):
    chunks = []
    while True:
        assert pos < len(data), 'Truncated GIF sub-block'
        size = data[pos]
        pos += 1
        if size == 0:
            return b''.join(chunks), pos
        assert pos + size <= len(data), 'Truncated GIF payload'
        chunks.append(data[pos:pos + size])
        pos += size


def parse_gif(data):
    """Inspect on-disk GIF structure rather than trusting encoder settings."""
    assert data[:6] in (b'GIF87a', b'GIF89a')
    width, height, packed, background, aspect = struct.unpack('<HHBBB', data[6:13])
    assert packed & 0x80, 'Global palette required'
    palette_size = 3 * 2 ** ((packed & 7) + 1)
    header_end = 13 + palette_size
    assert header_end <= len(data)
    result = dict(size=(width, height), palette=data[13:header_end],
                  header=data[:header_end], background=background, aspect=aspect,
                  frames=[], loop=None)
    pos = header_end
    gce = None
    while True:
        assert pos < len(data), 'Missing GIF trailer'
        marker = data[pos]
        pos += 1
        if marker == 0x3B:
            assert pos == len(data), 'Unexpected bytes after GIF trailer'
            return result
        if marker == 0x21:
            label = data[pos]
            pos += 1
            payload, pos = read_subblocks(data, pos)
            if label == 0xF9:
                assert len(payload) == 4, 'Bad graphic control extension'
                flags, delay, transparent_index = struct.unpack('<BHB', payload)
                gce = dict(flags=flags, duration=delay * 10,
                           transparency=bool(flags & 1), transparent_index=transparent_index,
                           disposal=(flags >> 2) & 7)
            elif label == 0xFF:
                assert payload[:11] == b'NETSCAPE2.0', 'Unexpected application extension'
                assert payload[11:12] == b'\x01' and len(payload) == 14
                result['loop'] = struct.unpack('<H', payload[12:])[0]
            else:
                raise AssertionError(f'Unexpected GIF extension: {label:#x}')
        elif marker == 0x2C:
            start = pos - 1
            left, top, w, h, flags = struct.unpack('<HHHHB', data[pos:pos + 9])
            pos += 9
            local_palette = bool(flags & 0x80)
            if local_palette:
                pos += 3 * 2 ** ((flags & 7) + 1)
            assert pos < len(data)
            pos += 1  # LZW minimum code size, followed by the compressed blocks.
            _, pos = read_subblocks(data, pos)
            result['frames'].append(dict(box=(left, top, w, h),
                local_palette=local_palette, control=gce, record=data[start:pos]))
            gce = None
        else:
            raise AssertionError(f'Unexpected GIF block marker: {marker:#x}')


def encode_full_frames(frames, durations):
    """Assemble standalone image records: no delta crops or local palettes.

    Pillow's multi-frame writer can crop to a changed rectangle even with
    optimize=False. Encoding each complete indexed image separately avoids that
    behavior. The final GIF has exactly one shared global color table, explicit
    opaque graphic controls, full-canvas records, and an infinite-loop extension.
    """
    assert len(frames) == len(durations)
    result = bytearray()
    palette = None
    for i, (frame, duration) in enumerate(zip(frames, durations)):
        assert frame.mode == 'P' and duration > 0 and duration % 10 == 0
        standalone = BytesIO()
        frame.save(standalone, format='GIF', optimize=False, interlace=False)
        parsed = parse_gif(standalone.getvalue())
        assert len(parsed['frames']) == 1
        record = parsed['frames'][0]
        assert not record['local_palette']
        assert record['box'] == (0, 0, *frame.size)
        if i == 0:
            palette = parsed['palette']
            result.extend(b'GIF89a' + parsed['header'][6:])
            result.extend(b'\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00')
        assert parsed['palette'] == palette
        # Disposal 1 (retain), no transparency flag, transparent index unused.
        result.extend(b'\x21\xf9\x04\x04')
        result.extend(struct.pack('<H', duration // 10))
        result.extend(b'\x00\x00')
        result.extend(record['record'])
    result.extend(b'\x3b')
    return bytes(result)


def overlay_time(frame):
    """Review-only 25:00; the production background contains no drawn text."""
    image = frame.copy()
    d = ImageDraw.Draw(image)
    digits = STATIC['DIGITS']
    text = '25:00'
    x = (128 - sum(len(digits[c][0]) + 2 for c in text) + 2) // 2
    for c in text:
        for y, row in enumerate(digits[c]):
            for dx, pixel in enumerate(row):
                if pixel == '1':
                    d.point((x + dx, 108 + y), fill=14)
        x += len(digits[c][0]) + 2
    return image


def contact_sheet(frames):
    scale = 2
    cell_width, cell_height = 280, 304
    sheet = Image.new('RGB', (3 * cell_width, 2 * cell_height + 44), COLORS[1])
    d = ImageDraw.Draw(sheet)
    d.text((12, 10), 'Original pixel-cat loop | 25:00 is illustrative | 2.34 s loop',
           fill=COLORS[14])
    for i, frame in enumerate(frames):
        x, y = (i % 3) * cell_width + 12, (i // 3) * cell_height + 40
        sheet.paste(frame.convert('RGB').resize((128 * scale, 128 * scale),
                    Image.Resampling.NEAREST), (x, y))
        d.text((x, y + 264), f'{i + 1}. {FRAME_LABELS[i]} | {DURATIONS_MS[i]} ms',
               fill=COLORS[14])
    out = BytesIO()
    sheet.save(out, format='PNG')
    return out.getvalue()


def build_outputs():
    frames = animation_frames()
    gif = encode_full_frames(frames, DURATIONS_MS)
    previews = [overlay_time(frame) for frame in frames]
    module = (
        '// Original animated cat artwork. Generated by scripts/build-pomodoro-cat-animation.py.\n'
        '// Six opaque full-canvas frames; one global palette; index 0 unused; loops forever.\n'
        '// 128 x 128; durations 780/140/160/140/120/1000 ms; total 2340 ms.\n'
        '// No drawn countdown: the footer is reserved for the native timer overlay.\n'
        '// Authoring budgets are engineering constraints, not firmware-compatibility proof.\n'
        "export const POMODORO_CAT_ANIMATION=Buffer.from('" +
        base64.b64encode(gif).decode('ascii') + "','base64');\n"
    ).encode('utf8')
    return {
        GIF_PATH: gif,
        MODULE_PATH: module,
        PREVIEW_128: encode_full_frames(previews, DURATIONS_MS),
        PREVIEW_512: encode_full_frames([
            frame.resize((512, 512), Image.Resampling.NEAREST) for frame in previews
        ], DURATIONS_MS),
        CONTACT_SHEET: contact_sheet(previews),
    }


def validate_gif(data, expected_frames, size, production=False):
    parsed = parse_gif(data)
    assert data[:6] == b'GIF89a'
    assert parsed['size'] == size
    assert parsed['loop'] == 0, 'Must loop forever'
    assert len(parsed['frames']) == len(DURATIONS_MS) == 6
    palette = bytes(v for c in COLORS for v in bytes.fromhex(c[1:]))
    palette += b'\x00' * (768 - len(palette))
    assert parsed['palette'] == palette, 'Palette reordered or changed'
    assert parsed['palette'][:3] == b'\xff\x00\xff', 'Reserved index 0 changed'
    if production:
        assert 4 <= len(parsed['frames']) <= MAX_FRAMES
        assert len(data) <= MAX_GIF_BYTES
        assert 1000 <= sum(DURATIONS_MS) <= MAX_LOOP_MS
    actual_durations = []
    reference = STATIC['scene']()
    with Image.open(BytesIO(data)) as decoded:
        assert decoded.n_frames == len(expected_frames)
        assert decoded.info.get('loop') == 0
        assert 'transparency' not in decoded.info
        for i, record in enumerate(parsed['frames']):
            assert record['box'] == (0, 0, *size), 'Delta/cropped frame found'
            assert not record['local_palette'], 'Local palette found'
            control = record['control']
            assert control is not None
            assert not control['transparency'] and control['disposal'] == 1
            assert control['flags'] == 4
            actual_durations.append(control['duration'])
            decoded.seek(i)
            decoded.load()
            assert decoded.size == size and 'transparency' not in decoded.info
            assert decoded.info['duration'] == DURATIONS_MS[i]
            assert decoded.convert('RGB').tobytes() == expected_frames[i].convert('RGB').tobytes()
            assert decoded.convert('RGBA').getchannel('A').getextrema() == (255, 255)
            # Decode each record alone to inspect actual palette indices, including
            # later frames that Pillow normally composites into RGB on seek.
            standalone = parsed['header'] + record['record'] + b'\x3b'
            with Image.open(BytesIO(standalone)) as indexed:
                indexed.load()
                assert indexed.mode == 'P'
                assert 0 not in indexed.tobytes(), f'Reserved index 0 used in frame {i}'
                if production:
                    footer = indexed.crop((0, 108, 128, 124)).tobytes()
                    assert footer == bytes([1]) * (128 * 16)
                    assert footer == reference.crop((0, 108, 128, 124)).tobytes()
                    # Only the two eye patches and small paw patch may move.
                    for y in range(128):
                        for x in range(128):
                            moving = (48 <= x < 68 and 72 <= y < 82) or (
                                50 <= y < 58 and (42 <= x < 48 or 70 <= x < 76))
                            if not moving:
                                assert indexed.getpixel((x, y)) == reference.getpixel((x, y))
    assert tuple(actual_durations) == DURATIONS_MS
    assert sum(actual_durations) == 2340


def validate_outputs(outputs):
    frames = animation_frames()
    assert len({f.tobytes() for f in frames}) == 4, 'Expected rest, lift, tap, blink poses'
    validate_gif(outputs[GIF_PATH], frames, SIZE, production=True)
    previews = [overlay_time(f) for f in frames]
    validate_gif(outputs[PREVIEW_128], previews, SIZE)
    validate_gif(outputs[PREVIEW_512], [
        f.resize((512, 512), Image.Resampling.NEAREST) for f in previews
    ], (512, 512))
    match = re.search(rb"POMODORO_CAT_ANIMATION=Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)",
                      outputs[MODULE_PATH])
    assert match and base64.b64decode(match[1], validate=True) == outputs[GIF_PATH]
    with Image.open(BytesIO(outputs[CONTACT_SHEET])) as sheet:
        sheet.load()
        assert sheet.size == (840, 652) and sheet.format == 'PNG'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate checked-in artifacts without writing')
    args = parser.parse_args()
    before = static_snapshot()
    outputs = build_outputs()
    assert outputs == build_outputs(), 'Authoring output is not deterministic'
    validate_outputs(outputs)
    if args.check:
        for path, expected in outputs.items():
            assert (ROOT / path).read_bytes() == expected, f'Stale generated artifact: {path}'
    else:
        for path, data in outputs.items():
            (ROOT / path).write_bytes(data)
        # Validate bytes actually read back from disk, including the embedded module.
        validate_outputs({path: (ROOT / path).read_bytes() for path in outputs})
    assert static_snapshot() == before, 'Existing static artwork was changed'
    print(f'PASS: 6 decoded full 128x128 frames, shared palette, index 0 unused, fully opaque; '
          f'footer clear; infinite 2340 ms loop; {len(outputs[GIF_PATH])} bytes; '
          'embedded bytes match; deterministic artifacts; static files unchanged.')


if __name__ == '__main__':
    main()
