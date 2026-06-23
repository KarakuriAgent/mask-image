from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    width: int
    height: int


def normalize_box(raw: dict, width: int, height: int) -> Box:
    x = float(raw.get("x", 0))
    y = float(raw.get("y", 0))
    w = float(raw.get("width", 0))
    h = float(raw.get("height", 0))
    x1 = max(0, min(width, int(min(x, x + w))))
    y1 = max(0, min(height, int(min(y, y + h))))
    x2 = max(0, min(width, int(max(x, x + w) + 0.999999)))
    y2 = max(0, min(height, int(max(y, y + h) + 0.999999)))
    return Box(x=x1, y=y1, width=max(0, x2 - x1), height=max(0, y2 - y1))


def data_url_to_bytes(data_url: str) -> bytes:
    if not data_url.startswith("data:"):
        raise ValueError("Expected a data URL")
    try:
        _, encoded = data_url.split(",", 1)
    except ValueError as exc:
        raise ValueError("Malformed data URL") from exc
    return base64.b64decode(encoded, validate=True)


def encode_rle(mask: Sequence[int]) -> dict:
    counts: list[int] = []
    value = 0
    run = 0
    for item in mask:
        bit = 1 if item else 0
        if bit == value:
            run += 1
        else:
            counts.append(run)
            value = bit
            run = 1
    counts.append(run)
    return {"counts": counts}


def decode_rle(rle: dict, width: int, height: int) -> list[int]:
    out = [0] * (width * height)
    value = 0
    offset = 0
    for count in rle.get("counts", []):
        end = min(len(out), offset + int(count))
        if value == 1:
            out[offset:end] = [1] * (end - offset)
        offset = end
        value = 1 - value
    return out


def rect_mask(width: int, height: int, box: Box) -> list[int]:
    out = [0] * (width * height)
    for yy in range(box.y, box.y + box.height):
        row = yy * width
        for xx in range(box.x, box.x + box.width):
            out[row + xx] = 1
    return out


def bbox_from_mask(mask: Sequence[int], width: int, height: int) -> Box:
    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    for yy in range(height):
        row = yy * width
        for xx in range(width):
            if not mask[row + xx]:
                continue
            min_x = min(min_x, xx)
            min_y = min(min_y, yy)
            max_x = max(max_x, xx)
            max_y = max(max_y, yy)
    if max_x < min_x or max_y < min_y:
        return Box(0, 0, 0, 0)
    return Box(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1)


def mask_from_bool_iter(values: Iterable[bool]) -> list[int]:
    return [1 if value else 0 for value in values]


def box_to_dict(box: Box) -> dict:
    return {"x": box.x, "y": box.y, "width": box.width, "height": box.height}
