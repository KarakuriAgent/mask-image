# Mask Image

Local-only web app for extracting human/anime-character regions and exporting masks for inpainting and Regional-ControlNet.

## Features

- Load an image in the browser.
- Detect person/character candidates through the local backend.
- Segment detected boxes with SAM2 when configured.
- Add missing people manually by drawing a rectangle.
- Select each instance independently.
- Toggle inpaint mask inclusion per instance.
- Assign each instance to Regional-ControlNet `none`, `red`, `blue`, or `yellow`.
- Delete false positives.
- Reorder instances to control overlap priority.
- Brush add/erase on the selected instance mask.
- Grow/shrink masks.
- Remove small mask islands.
- Optional feathered inpaint export.
- Export:
  - Inpaint image: original image with selected regions painted black.
  - Regional-ControlNet mask: white background, selected regions in pure red/blue/yellow.

## Run

```bash
npm run serve
```

Open:

```text
http://127.0.0.1:8787
```

The server binds to `0.0.0.0` by default. On the same machine, open `http://127.0.0.1:8787`. From another device on the same network, open `http://<this-machine-lan-ip>:8787`.

The app does not upload images to any external API. The first ML run may download model files into the local Hugging Face cache if they are not already cached.

## Enable Automatic Detection

Automatic detection needs local ML dependencies. If CUDA is available, install the CUDA setup:

```bash
npm run setup:ml:cuda
```

The CUDA setup defaults to PyTorch `cu128`. If your NVIDIA driver is older, try:

```bash
npm run setup:ml:cuda -- cu126
npm run setup:ml:cuda -- cu118
```

For CPU-only setup:

```bash
npm run setup:ml:cpu
```

Then start the app normally:

```bash
npm run serve
```

The default `auto` backend uses:

- Detector: `IDEA-Research/grounding-dino-tiny`
- Segmenter: `facebook/sam2-hiera-tiny`

You can override them:

```bash
export MASK_IMAGE_GDINO_MODEL=IDEA-Research/grounding-dino-base
export MASK_IMAGE_SAM2_MODEL=facebook/sam2.1-hiera-tiny
npm run serve
```

The backend uses CUDA automatically when `torch.cuda.is_available()` is true. You can force CPU with:

```bash
export MASK_IMAGE_DEVICE=cpu
npm run serve
```

## Build And Test

```bash
npm run build
npm test
```

The default build and tests do not require ML packages. Without ML packages, automatic detection is disabled and the UI shows the missing dependency list. Manual rectangle segmentation falls back to a rectangle mask.

## Manual Checkpoint Setup

The backend also has a direct SAM2 + GroundingDINO repository adapter. Install those projects and model checkpoints locally, then start with environment variables:

```bash
export MASK_IMAGE_PIPELINE=sam_grounding
export MASK_IMAGE_DEVICE=cuda
export MASK_IMAGE_SAM2_CONFIG=/absolute/path/to/sam2_hiera_l.yaml
export MASK_IMAGE_SAM2_CHECKPOINT=/absolute/path/to/sam2_hiera_large.pt
export MASK_IMAGE_GDINO_CONFIG=/absolute/path/to/GroundingDINO_SwinT_OGC.py
export MASK_IMAGE_GDINO_CHECKPOINT=/absolute/path/to/groundingdino_swint_ogc.pth
npm run serve
```

Detection prompts are editable in the UI. The default prompt is:

```text
anime character . person . human figure . body
```

SAM2 is used to refine every detected box into a mask. If GroundingDINO is unavailable but SAM2 is configured, manually drawn boxes can still be segmented by SAM2.
