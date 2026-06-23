export const REGIONAL_COLORS = Object.freeze({
  none: null,
  red: [255, 0, 0, 255],
  blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255],
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeBox(box, width, height) {
  const x1 = clamp(Math.floor(Math.min(box.x, box.x + box.width)), 0, width);
  const y1 = clamp(Math.floor(Math.min(box.y, box.y + box.height)), 0, height);
  const x2 = clamp(Math.ceil(Math.max(box.x, box.x + box.width)), 0, width);
  const y2 = clamp(Math.ceil(Math.max(box.y, box.y + box.height)), 0, height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
}

export function rectMask(width, height, box) {
  const out = new Uint8Array(width * height);
  const rect = normalizeBox(box, width, height);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const row = y * width;
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      out[row + x] = 1;
    }
  }
  return out;
}

export function encodeRle(mask) {
  const counts = [];
  let value = 0;
  let run = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const bit = mask[i] ? 1 : 0;
    if (bit === value) {
      run += 1;
    } else {
      counts.push(run);
      value = bit;
      run = 1;
    }
  }
  counts.push(run);
  return { counts };
}

export function decodeRle(rle, width, height) {
  const out = new Uint8Array(width * height);
  let value = 0;
  let offset = 0;
  for (const count of rle.counts || []) {
    const end = Math.min(out.length, offset + count);
    if (value === 1) {
      out.fill(1, offset, end);
    }
    offset = end;
    value = value === 0 ? 1 : 0;
  }
  return out;
}

export function bboxFromMask(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[row + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function mergeMasks(width, height, instances, predicate) {
  const out = new Uint8Array(width * height);
  for (const instance of instances) {
    if (!predicate(instance)) continue;
    const mask = instance.mask;
    for (let i = 0; i < out.length; i += 1) {
      if (mask[i]) out[i] = 1;
    }
  }
  return out;
}

export function paintCircle(mask, width, height, cx, cy, radius, value) {
  const r = Math.max(1, Math.floor(radius));
  const x1 = clamp(Math.floor(cx - r), 0, width - 1);
  const y1 = clamp(Math.floor(cy - r), 0, height - 1);
  const x2 = clamp(Math.ceil(cx + r), 0, width - 1);
  const y2 = clamp(Math.ceil(cy + r), 0, height - 1);
  const rr = r * r;
  for (let y = y1; y <= y2; y += 1) {
    const dy = y - cy;
    const row = y * width;
    for (let x = x1; x <= x2; x += 1) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= rr) {
        mask[row + x] = value ? 1 : 0;
      }
    }
  }
}

export function morphMask(mask, width, height, radius, mode) {
  const r = Math.max(1, Math.floor(radius));
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = mode === "erode";
      for (let yy = Math.max(0, y - r); yy <= Math.min(height - 1, y + r); yy += 1) {
        const row = yy * width;
        for (let xx = Math.max(0, x - r); xx <= Math.min(width - 1, x + r); xx += 1) {
          const filled = mask[row + xx] === 1;
          if (mode === "dilate" && filled) {
            hit = true;
            yy = height;
            break;
          }
          if (mode === "erode" && !filled) {
            hit = false;
            yy = height;
            break;
          }
        }
      }
      out[y * width + x] = hit ? 1 : 0;
    }
  }
  return out;
}

export function removeSmallComponents(mask, width, height, minPixels) {
  const minSize = Math.max(1, Math.floor(minPixels));
  const out = mask.slice();
  const seen = new Uint8Array(mask.length);
  const queue = [];
  const component = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    queue.length = 0;
    component.length = 0;
    queue.push(start);
    seen[start] = 1;
    for (let q = 0; q < queue.length; q += 1) {
      const idx = queue[q];
      component.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const next of neighbors) {
        if (next < 0 || seen[next] || !mask[next]) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    if (component.length < minSize) {
      for (const idx of component) out[idx] = 0;
    }
  }
  return out;
}

export function renderInpaintPixels(width, height, instances, basePixels) {
  const pixels = basePixels ? new Uint8ClampedArray(basePixels) : new Uint8ClampedArray(width * height * 4);
  if (!basePixels) pixels.fill(255);
  const merged = mergeMasks(width, height, instances, (instance) => instance.visible && instance.inpaintEnabled);
  for (let i = 0; i < merged.length; i += 1) {
    if (!merged[i]) continue;
    const p = i * 4;
    pixels[p] = 0;
    pixels[p + 1] = 0;
    pixels[p + 2] = 0;
    pixels[p + 3] = 255;
  }
  return pixels;
}

export function renderRegionalPixels(width, height, instances) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(255);
  for (const instance of instances) {
    const color = REGIONAL_COLORS[instance.regionalColor];
    if (!instance.visible || !color) continue;
    const mask = instance.mask;
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i]) continue;
      const p = i * 4;
      pixels[p] = color[0];
      pixels[p + 1] = color[1];
      pixels[p + 2] = color[2];
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

export function hitTestInstances(instances, x, y, width) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  for (let i = instances.length - 1; i >= 0; i -= 1) {
    const instance = instances[i];
    if (!instance.visible) continue;
    if (instance.mask[iy * width + ix]) return instance.id;
  }
  return null;
}
