import {
  bboxFromMask,
  decodeRle,
  encodeRle,
  hitTestInstances,
  mergeDuplicateInstances,
  morphMask,
  paintCircle,
  rectMask,
  removeSmallComponents,
  renderInpaintPixels,
  renderRegionalPixels,
} from "./core.js";

const dom = {
  fileInput: document.querySelector("#file-input"),
  detectButton: document.querySelector("#detect-button"),
  detectLabel: document.querySelector("#detect-button .detect-label"),
  exportButton: document.querySelector("#export-button"),
  exportRegionalButton: document.querySelector("#export-regional-button"),
  status: document.querySelector("#status"),
  prompts: document.querySelector("#prompts"),
  threshold: document.querySelector("#threshold"),
  thresholdValue: document.querySelector("#threshold-value"),
  brushSize: document.querySelector("#brush-size"),
  brushValue: document.querySelector("#brush-value"),
  feather: document.querySelector("#feather"),
  featherValue: document.querySelector("#feather-value"),
  cleanMin: document.querySelector("#clean-min"),
  cleanMask: document.querySelector("#clean-mask"),
  growMask: document.querySelector("#grow-mask"),
  shrinkMask: document.querySelector("#shrink-mask"),
  clearMask: document.querySelector("#clear-mask"),
  undoAction: document.querySelector("#undo-action"),
  redoAction: document.querySelector("#redo-action"),
  canvas: document.querySelector("#main-canvas"),
  instanceList: document.querySelector("#instance-list"),
  toolButtons: Array.from(document.querySelectorAll(".tool-button")),
};

const ctx = dom.canvas.getContext("2d", { alpha: false });
const state = {
  image: null,
  imageDataUrl: "",
  width: 0,
  height: 0,
  instances: [],
  selectedId: null,
  outputMode: "regional",
  tool: "select",
  view: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
  pointerDown: false,
  boxStart: null,
  boxCurrent: null,
  undoStack: [],
  redoStack: [],
};

const regionalColorLabels = {
  none: "色なし",
  red: "赤",
  blue: "青",
  yellow: "黄",
};

const defaultRegionalColors = ["red", "blue", "yellow"];
const maxHistoryEntries = 40;
const defaultMaskGrowthMin = 10;
const defaultMaskGrowthMax = 28;

function setStatus(message) {
  dom.status.textContent = message;
}

function setDetecting(isDetecting) {
  dom.detectButton.disabled = isDetecting;
  dom.detectButton.classList.toggle("is-loading", isDetecting);
  dom.detectButton.setAttribute("aria-busy", isDetecting ? "true" : "false");
  dom.detectLabel.textContent = isDetecting ? "検出中" : "人物を検出";
}

function selectedInstance() {
  return state.instances.find((instance) => instance.id === state.selectedId) || null;
}

function updateHistoryButtons() {
  dom.undoAction.disabled = state.undoStack.length === 0;
  dom.redoAction.disabled = state.redoStack.length === 0;
}

function clearHistory() {
  state.undoStack = [];
  state.redoStack = [];
  updateHistoryButtons();
}

function cloneInstance(instance) {
  return {
    ...instance,
    bbox: { ...instance.bbox },
    mask: instance.mask.slice(),
  };
}

function snapshotAppState() {
  return {
    instances: state.instances.map(cloneInstance),
    selectedId: state.selectedId,
  };
}

function restoreAppState(snapshot) {
  state.instances = snapshot.instances.map(cloneInstance);
  state.selectedId = snapshot.selectedId;
  if (state.selectedId && !state.instances.some((instance) => instance.id === state.selectedId)) {
    state.selectedId = state.instances[0]?.id || null;
  }
  renderList();
  redraw();
}

function pushAppHistory() {
  state.undoStack.push(snapshotAppState());
  if (state.undoStack.length > maxHistoryEntries) state.undoStack.shift();
  state.redoStack = [];
  updateHistoryButtons();
}

function restoreHistory(fromStack, toStack, emptyMessage) {
  const snapshot = fromStack.pop();
  if (!snapshot) {
    setStatus(emptyMessage);
    updateHistoryButtons();
    return;
  }
  toStack.push(snapshotAppState());
  restoreAppState(snapshot);
  updateHistoryButtons();
}

function hasMaskPixels(instance) {
  return instance.mask?.some((value) => value === 1);
}

function hasInpaintTargets() {
  return state.instances.some((instance) => instance.visible && hasMaskPixels(instance));
}

function hasRegionalTargets() {
  return state.instances.some((instance) => instance.visible && instance.regionalColor !== "none" && hasMaskPixels(instance));
}

function makeId(prefix = "inst") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultRegionalColor(index) {
  return defaultRegionalColors[index % defaultRegionalColors.length];
}

function defaultMaskGrowthRadius() {
  const imageSize = Math.max(state.width, state.height);
  if (!imageSize) return defaultMaskGrowthMin;
  return Math.max(defaultMaskGrowthMin, Math.min(defaultMaskGrowthMax, Math.round(imageSize / 120)));
}

function defaultExpandedMask(mask) {
  return morphMask(mask, state.width, state.height, defaultMaskGrowthRadius(), "dilate");
}

function applyDefaultMaskExpansion(instance) {
  instance.mask = defaultExpandedMask(instance.mask);
  instance.bbox = bboxFromMask(instance.mask, state.width, state.height);
  return instance;
}

function inpaintRenderInstances() {
  return state.instances.map((instance) => ({ ...instance, inpaintEnabled: true }));
}

function canvasPoint(event) {
  const rect = dom.canvas.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;
  const x = (cssX - state.view.x) / state.view.scale;
  const y = (cssY - state.view.y) / state.view.scale;
  return {
    x: Math.max(0, Math.min(state.width - 1, x)),
    y: Math.max(0, Math.min(state.height - 1, y)),
  };
}

function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (dom.canvas.width !== width || dom.canvas.height !== height) {
    dom.canvas.width = width;
    dom.canvas.height = height;
  }
  redraw();
}

function updateView() {
  if (!state.image) {
    state.view = { x: 0, y: 0, width: dom.canvas.width, height: dom.canvas.height, scale: 1 };
    return;
  }
  const margin = 28;
  const availableW = Math.max(1, dom.canvas.width - margin * 2);
  const availableH = Math.max(1, dom.canvas.height - margin * 2);
  const scale = Math.min(availableW / state.width, availableH / state.height);
  const width = state.width * scale;
  const height = state.height * scale;
  state.view = {
    x: (dom.canvas.width - width) / 2,
    y: (dom.canvas.height - height) / 2,
    width,
    height,
    scale,
  };
}

function overlayForInstance(instance) {
  const overlay = document.createElement("canvas");
  overlay.width = state.width;
  overlay.height = state.height;
  const overlayCtx = overlay.getContext("2d");
  const image = overlayCtx.createImageData(state.width, state.height);
  let color = [37, 99, 235];
  if (state.outputMode === "regional") {
    color = [102, 112, 133];
    if (instance.regionalColor === "red") color = [255, 0, 0];
    if (instance.regionalColor === "blue") color = [0, 0, 255];
    if (instance.regionalColor === "yellow") color = [210, 168, 0];
  }
  for (let i = 0; i < instance.mask.length; i += 1) {
    if (!instance.mask[i]) continue;
    const p = i * 4;
    image.data[p] = color[0];
    image.data[p + 1] = color[1];
    image.data[p + 2] = color[2];
    image.data[p + 3] = instance.id === state.selectedId ? 120 : 72;
  }
  overlayCtx.putImageData(image, 0, 0);
  return overlay;
}

function drawBox(box, stroke, lineWidth = 2) {
  const { x, y, width, height, scale } = state.view;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(x + box.x * scale, y + box.y * scale, box.width * scale, box.height * scale);
}

function redraw() {
  updateView();
  ctx.fillStyle = "#e8ebf0";
  ctx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);
  if (!state.image) {
    ctx.fillStyle = "#667085";
    ctx.font = `${15 * (window.devicePixelRatio || 1)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("画像を開いてください", dom.canvas.width / 2, dom.canvas.height / 2);
    return;
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(state.view.x, state.view.y, state.view.width, state.view.height);
  ctx.drawImage(state.image, state.view.x, state.view.y, state.view.width, state.view.height);

  for (const instance of state.instances) {
    if (!instance.visible) continue;
    const overlay = overlayForInstance(instance);
    ctx.drawImage(overlay, state.view.x, state.view.y, state.view.width, state.view.height);
  }

  for (const instance of state.instances) {
    if (!instance.visible) continue;
    drawBox(instance.bbox, instance.id === state.selectedId ? "#2563eb" : "#101828", instance.id === state.selectedId ? 3 : 1.5);
  }

  if (state.boxStart && state.boxCurrent) {
    const x = Math.min(state.boxStart.x, state.boxCurrent.x);
    const y = Math.min(state.boxStart.y, state.boxCurrent.y);
    const width = Math.abs(state.boxCurrent.x - state.boxStart.x);
    const height = Math.abs(state.boxCurrent.y - state.boxStart.y);
    drawBox({ x, y, width, height }, "#b42318", 2);
  }
}

function instanceFromPayload(item, index, options = {}) {
  const rawMask = item.mask?.counts
    ? decodeRle(item.mask, state.width, state.height)
    : rectMask(state.width, state.height, item.bbox);
  const mask = options.expand === false ? rawMask : defaultExpandedMask(rawMask);
  const bbox = bboxFromMask(mask, state.width, state.height);
  return {
    id: item.id || makeId("det"),
    label: `人物 ${index + 1}`,
    score: typeof item.score === "number" ? item.score : null,
    bbox,
    mask,
    visible: true,
    inpaintEnabled: true,
    regionalColor: defaultRegionalColor(index),
  };
}

function addInstance(instance) {
  pushAppHistory();
  state.instances.push(instance);
  state.selectedId = instance.id;
  renderList();
  redraw();
}

function renderList() {
  if (!state.instances.length) {
    dom.instanceList.innerHTML = '<div class="empty-state">画像を開いて人物を検出してください。</div>';
    return;
  }
  dom.instanceList.innerHTML = state.instances
    .map((instance, index) => {
      const score = instance.score == null ? "" : `<span class="score">${Math.round(instance.score * 100)}%</span>`;
      return `
        <article class="instance-card ${instance.id === state.selectedId ? "selected" : ""} ${instance.visible ? "" : "muted"}" data-id="${instance.id}">
          <label class="instance-head">
            <input type="radio" name="selected-instance" ${instance.id === state.selectedId ? "checked" : ""} data-action="select" />
            <span class="instance-name">${escapeHtml(instance.label || `人物 ${index + 1}`)}</span>
            ${score}
          </label>
          <div class="instance-mode-control">
            <label class="instance-mode-row compact">
              <span>出力</span>
              <input type="checkbox" ${instance.visible ? "checked" : ""} data-action="visibility" aria-label="出力" />
            </label>
            <label class="instance-mode-row">
              <span>色</span>
              <select data-action="regional" aria-label="色">
                ${["none", "red", "blue", "yellow"].map((color) => `<option value="${color}" ${instance.regionalColor === color ? "selected" : ""}>${regionalColorLabels[color]}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="instance-primary-actions">
            <button type="button" title="削除" data-action="delete">削除</button>
          </div>
          <details class="instance-details">
            <summary>詳細</summary>
            <div class="instance-actions">
              <button type="button" title="上へ移動" data-action="up">上へ</button>
              <button type="button" title="下へ移動" data-action="down">下へ</button>
              <button type="button" title="現在のマスクから枠を更新" data-action="rebox">枠更新</button>
            </div>
          </details>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadImageFromFile(file) {
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", reject, { once: true });
    image.src = dataUrl;
  });
  state.image = image;
  state.imageDataUrl = dataUrl;
  state.width = image.naturalWidth;
  state.height = image.naturalHeight;
  state.instances = [];
  state.selectedId = null;
  clearHistory();
  renderList();
  setStatus(`画像を読み込みました: ${state.width}x${state.height}`);
  redraw();
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `通信に失敗しました (${response.status})`);
  }
  return data;
}

async function detect() {
  if (!state.image) {
    setStatus("先に画像を開いてください");
    return;
  }
  setStatus("検出しています...");
  setDetecting(true);
  try {
    const data = await postJson("/api/detect", {
      imageDataUrl: state.imageDataUrl,
      width: state.width,
      height: state.height,
      prompts: dom.prompts.value,
      threshold: Number(dom.threshold.value),
    });
    if (data.available === false) {
      setStatus("自動検出は利用できません。必要な環境を確認してください。");
      return;
    }
    const detected = (data.instances || []).map((item, index) => instanceFromPayload(item, index, { expand: false }));
    const next = mergeDuplicateInstances(detected, state.width, state.height);
    next.forEach((instance, index) => {
      applyDefaultMaskExpansion(instance);
      if (instance.id?.startsWith("det")) instance.label = `人物 ${index + 1}`;
      instance.regionalColor = defaultRegionalColor(index);
    });
    state.instances = next;
    state.selectedId = next[0]?.id || null;
    clearHistory();
    renderList();
    redraw();
    const mergedCount = detected.length - next.length;
    if (next.length && mergedCount > 0) {
      setStatus(`${detected.length}件検出し、重複をまとめて${next.length}領域にしました`);
    } else {
      setStatus(next.length ? `${next.length}件検出しました` : "検出できませんでした。手動で囲んで追加してください。");
    }
  } catch (error) {
    console.error(error);
    setStatus("検出に失敗しました。");
  } finally {
    setDetecting(false);
  }
}

async function segmentBox(box) {
  if (box.width < 4 || box.height < 4) {
    setStatus("囲んだ範囲が小さすぎます");
    return;
  }
  setStatus("囲んだ範囲をマスク化しています...");
  try {
    const data = await postJson("/api/segment-box", {
      imageDataUrl: state.imageDataUrl,
      width: state.width,
      height: state.height,
      box,
    });
    addInstance(instanceFromPayload(data.instance, state.instances.length));
    setStatus("マスクを追加しました");
  } catch (error) {
    console.error(error);
    const mask = rectMask(state.width, state.height, box);
    const expandedMask = defaultExpandedMask(mask);
    addInstance({
      id: makeId("box"),
      label: `人物 ${state.instances.length + 1}`,
      score: null,
      bbox: bboxFromMask(expandedMask, state.width, state.height),
      mask: expandedMask,
      visible: true,
      inpaintEnabled: true,
      regionalColor: defaultRegionalColor(state.instances.length),
    });
    setStatus("バックエンドが利用できないため、四角形マスクを追加しました。");
  }
}

function mutateSelectedMask(callback) {
  const instance = selectedInstance();
  if (!instance) {
    setStatus("先に領域を選択してください");
    return;
  }
  pushAppHistory();
  callback(instance);
  instance.bbox = bboxFromMask(instance.mask, state.width, state.height);
  renderList();
  redraw();
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus("PNGに変換できませんでした");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function makeOutputCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = state.width;
  canvas.height = state.height;
  return canvas;
}

function exportInpaintMask() {
  if (!state.image) {
    setStatus("先に画像を開いてください");
    return;
  }
  if (!hasInpaintTargets()) {
    setStatus("表示中の領域に、インペイント画像へ含めるものがありません。");
    return;
  }
  const feather = Number(dom.feather.value);
  const canvas = makeOutputCanvas();
  const instances = inpaintRenderInstances();
  const outputCtx = canvas.getContext("2d");
  outputCtx.drawImage(state.image, 0, 0, state.width, state.height);
  const basePixels = outputCtx.getImageData(0, 0, state.width, state.height).data;
  if (feather <= 0) {
    const pixels = renderInpaintPixels(state.width, state.height, instances, basePixels);
    outputCtx.putImageData(new ImageData(pixels, state.width, state.height), 0, 0);
  } else {
    const temp = makeOutputCanvas();
    const tempCtx = temp.getContext("2d");
    const exact = renderInpaintPixels(state.width, state.height, instances, basePixels);
    const alpha = tempCtx.createImageData(state.width, state.height);
    for (let i = 0; i < state.width * state.height; i += 1) {
      const p = i * 4;
      const isBlack = exact[p] === 0;
      alpha.data[p] = 0;
      alpha.data[p + 1] = 0;
      alpha.data[p + 2] = 0;
      alpha.data[p + 3] = isBlack ? 255 : 0;
    }
    tempCtx.putImageData(alpha, 0, 0);
    outputCtx.putImageData(new ImageData(basePixels, state.width, state.height), 0, 0);
    outputCtx.filter = `blur(${feather}px)`;
    outputCtx.drawImage(temp, 0, 0);
    outputCtx.filter = "none";
  }
  downloadCanvas(canvas, "inpaint-mask.png");
  setStatus("インペイント用画像を書き出しました");
}

function exportRegionalMask() {
  if (!state.image) {
    setStatus("先に画像を開いてください");
    return;
  }
  if (!hasRegionalTargets()) {
    setStatus("表示中の領域に、カラー領域画像へ出力するものがありません。");
    return;
  }
  const canvas = makeOutputCanvas();
  const outputCtx = canvas.getContext("2d");
  const pixels = renderRegionalPixels(state.width, state.height, state.instances);
  outputCtx.putImageData(new ImageData(pixels, state.width, state.height), 0, 0);
  downloadCanvas(canvas, "regional-controlnet-mask.png");
  setStatus("領域カラー画像を書き出しました");
}

function setTool(tool) {
  state.tool = tool;
  for (const button of dom.toolButtons) {
    button.classList.toggle("active", button.dataset.tool === tool);
  }
}

function onPointerDown(event) {
  if (!state.image) return;
  dom.canvas.setPointerCapture(event.pointerId);
  state.pointerDown = true;
  const point = canvasPoint(event);
  if (state.tool === "select") {
    state.selectedId = hitTestInstances(state.instances, point.x, point.y, state.width);
    renderList();
    redraw();
    return;
  }
  if (state.tool === "box") {
    state.boxStart = point;
    state.boxCurrent = point;
    redraw();
    return;
  }
  if (state.tool === "brush" || state.tool === "erase") {
    mutateSelectedMask((instance) => {
      paintCircle(instance.mask, state.width, state.height, point.x, point.y, Number(dom.brushSize.value), state.tool === "brush" ? 1 : 0);
    });
  }
}

function onPointerMove(event) {
  if (!state.pointerDown || !state.image) return;
  const point = canvasPoint(event);
  if (state.tool === "box") {
    state.boxCurrent = point;
    redraw();
    return;
  }
  if (state.tool === "brush" || state.tool === "erase") {
    const instance = selectedInstance();
    if (!instance) return;
    paintCircle(instance.mask, state.width, state.height, point.x, point.y, Number(dom.brushSize.value), state.tool === "brush" ? 1 : 0);
    instance.bbox = bboxFromMask(instance.mask, state.width, state.height);
    redraw();
  }
}

function onPointerUp(event) {
  if (!state.pointerDown) return;
  state.pointerDown = false;
  if (state.tool === "box" && state.boxStart && state.boxCurrent) {
    const box = {
      x: Math.min(state.boxStart.x, state.boxCurrent.x),
      y: Math.min(state.boxStart.y, state.boxCurrent.y),
      width: Math.abs(state.boxCurrent.x - state.boxStart.x),
      height: Math.abs(state.boxCurrent.y - state.boxStart.y),
    };
    state.boxStart = null;
    state.boxCurrent = null;
    redraw();
    segmentBox(box);
  }
  dom.canvas.releasePointerCapture(event.pointerId);
}

function moveInstance(id, delta) {
  const index = state.instances.findIndex((instance) => instance.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= state.instances.length) return;
  const [item] = state.instances.splice(index, 1);
  state.instances.splice(next, 0, item);
}

dom.fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadImageFromFile(file).catch((error) => {
    console.error(error);
    setStatus("画像の読み込みに失敗しました");
  });
});
dom.detectButton.addEventListener("click", detect);
dom.exportButton.addEventListener("click", exportInpaintMask);
dom.exportRegionalButton.addEventListener("click", exportRegionalMask);
dom.threshold.addEventListener("input", () => {
  dom.thresholdValue.value = Number(dom.threshold.value).toFixed(2);
});
dom.brushSize.addEventListener("input", () => {
  dom.brushValue.value = dom.brushSize.value;
});
dom.feather.addEventListener("input", () => {
  dom.featherValue.value = dom.feather.value;
});
for (const button of dom.toolButtons) {
  button.addEventListener("click", () => setTool(button.dataset.tool));
}
dom.cleanMask.addEventListener("click", () => {
  mutateSelectedMask((instance) => {
    instance.mask = removeSmallComponents(instance.mask, state.width, state.height, Number(dom.cleanMin.value));
  });
});
dom.undoAction.addEventListener("click", () => {
  restoreHistory(state.undoStack, state.redoStack, "戻す履歴がありません");
});
dom.redoAction.addEventListener("click", () => {
  restoreHistory(state.redoStack, state.undoStack, "進める履歴がありません");
});
dom.growMask.addEventListener("click", () => {
  mutateSelectedMask((instance) => {
    instance.mask = morphMask(instance.mask, state.width, state.height, 2, "dilate");
  });
});
dom.shrinkMask.addEventListener("click", () => {
  mutateSelectedMask((instance) => {
    instance.mask = morphMask(instance.mask, state.width, state.height, 2, "erode");
  });
});
dom.clearMask.addEventListener("click", () => {
  mutateSelectedMask((instance) => {
    instance.mask = new Uint8Array(state.width * state.height);
  });
});
dom.instanceList.addEventListener("change", (event) => {
  const card = event.target.closest(".instance-card");
  if (!card) return;
  const instance = state.instances.find((item) => item.id === card.dataset.id);
  if (!instance) return;
  const action = event.target.dataset.action;
  if (action === "select") state.selectedId = instance.id;
  if (action === "visibility" && instance.visible !== event.target.checked) {
    pushAppHistory();
    instance.visible = event.target.checked;
  }
  if (action === "regional" && instance.regionalColor !== event.target.value) {
    pushAppHistory();
    instance.regionalColor = event.target.value;
  }
  renderList();
  redraw();
});
dom.instanceList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const card = event.target.closest(".instance-card");
  if (!button || !card) return;
  const id = card.dataset.id;
  const instance = state.instances.find((item) => item.id === id);
  if (!instance) return;
  const action = button.dataset.action;
  if (action === "delete") {
    pushAppHistory();
    state.instances = state.instances.filter((item) => item.id !== id);
    if (state.selectedId === id) state.selectedId = state.instances[0]?.id || null;
  }
  if (action === "up" || action === "down") {
    const delta = action === "up" ? -1 : 1;
    const index = state.instances.findIndex((item) => item.id === id);
    const next = index + delta;
    if (index >= 0 && next >= 0 && next < state.instances.length) {
      pushAppHistory();
      moveInstance(id, delta);
    }
  }
  if (action === "rebox") {
    pushAppHistory();
    instance.bbox = bboxFromMask(instance.mask, state.width, state.height);
  }
  renderList();
  redraw();
});
dom.canvas.addEventListener("pointerdown", onPointerDown);
dom.canvas.addEventListener("pointermove", onPointerMove);
dom.canvas.addEventListener("pointerup", onPointerUp);
dom.canvas.addEventListener("pointercancel", onPointerUp);
window.addEventListener("resize", resizeCanvas);

fetch("/api/status")
  .then((response) => response.json())
  .then((data) => {
    if (data.available) {
      setStatus(data.loaded ? "検出バックエンドは使用できます" : "検出バックエンドは初回検出時に読み込まれます");
    } else {
      setStatus("自動検出は利用できません。必要な環境を確認してください。");
    }
  })
  .catch(() => setStatus("準備完了"));

resizeCanvas();
renderList();
updateHistoryButtons();

window.__maskImageDebug = {
  state,
  encodeRle,
};
