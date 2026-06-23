import test from "node:test";
import assert from "node:assert/strict";
import {
  bboxFromMask,
  decodeRle,
  encodeRle,
  hitTestInstances,
  morphMask,
  rectMask,
  removeSmallComponents,
  renderInpaintPixels,
  renderRegionalPixels,
} from "../public/core.js";

test("RLE round-trips a sparse mask", () => {
  const mask = new Uint8Array([0, 0, 1, 1, 1, 0, 1, 0]);
  const rle = encodeRle(mask);
  assert.deepEqual(Array.from(decodeRle(rle, 4, 2)), Array.from(mask));
});

test("rectangle mask and bbox use image coordinates", () => {
  const mask = rectMask(5, 4, { x: 1, y: 1, width: 3, height: 2 });
  assert.equal(mask.reduce((sum, value) => sum + value, 0), 6);
  assert.deepEqual(bboxFromMask(mask, 5, 4), { x: 1, y: 1, width: 3, height: 2 });
});

test("regional rendering uses white background and pure colors", () => {
  const red = rectMask(3, 1, { x: 0, y: 0, width: 2, height: 1 });
  const blue = rectMask(3, 1, { x: 1, y: 0, width: 2, height: 1 });
  const pixels = renderRegionalPixels(3, 1, [
    { mask: red, visible: true, regionalColor: "red" },
    { mask: blue, visible: true, regionalColor: "blue" },
  ]);
  assert.deepEqual(Array.from(pixels.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(pixels.slice(4, 8)), [0, 0, 255, 255]);
  assert.deepEqual(Array.from(pixels.slice(8, 12)), [0, 0, 255, 255]);
});

test("inpaint rendering keeps base pixels and paints selected masks black", () => {
  const mask = rectMask(2, 1, { x: 1, y: 0, width: 1, height: 1 });
  const base = new Uint8ClampedArray([12, 34, 56, 255, 98, 76, 54, 255]);
  const pixels = renderInpaintPixels(2, 1, [{ mask, visible: true, inpaintEnabled: true }], base);
  assert.deepEqual(Array.from(pixels.slice(0, 4)), [12, 34, 56, 255]);
  assert.deepEqual(Array.from(pixels.slice(4, 8)), [0, 0, 0, 255]);
});

test("hidden instances are excluded from inpaint and regional exports", () => {
  const mask = rectMask(1, 1, { x: 0, y: 0, width: 1, height: 1 });
  const base = new Uint8ClampedArray([10, 20, 30, 255]);
  const inpaint = renderInpaintPixels(1, 1, [{ mask, visible: false, inpaintEnabled: true }], base);
  const regional = renderRegionalPixels(1, 1, [{ mask, visible: false, regionalColor: "red" }]);
  assert.deepEqual(Array.from(inpaint), [10, 20, 30, 255]);
  assert.deepEqual(Array.from(regional), [255, 255, 255, 255]);
});

test("morphology grows and shrinks masks", () => {
  const mask = rectMask(5, 5, { x: 2, y: 2, width: 1, height: 1 });
  const grown = morphMask(mask, 5, 5, 1, "dilate");
  assert.equal(grown.reduce((sum, value) => sum + value, 0), 9);
  const shrunk = morphMask(grown, 5, 5, 1, "erode");
  assert.equal(shrunk.reduce((sum, value) => sum + value, 0), 1);
});

test("small component cleanup removes islands below threshold", () => {
  const mask = new Uint8Array(16);
  mask[0] = 1;
  mask[5] = 1;
  mask[6] = 1;
  mask[9] = 1;
  mask[10] = 1;
  const cleaned = removeSmallComponents(mask, 4, 4, 2);
  assert.equal(cleaned[0], 0);
  assert.equal(cleaned[5], 1);
});

test("hit testing respects topmost visible instance", () => {
  const bottom = rectMask(4, 4, { x: 1, y: 1, width: 2, height: 2 });
  const top = rectMask(4, 4, { x: 2, y: 2, width: 1, height: 1 });
  const id = hitTestInstances(
    [
      { id: "bottom", mask: bottom, visible: true },
      { id: "top", mask: top, visible: true },
    ],
    2,
    2,
    4,
  );
  assert.equal(id, "top");
});
