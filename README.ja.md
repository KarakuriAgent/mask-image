# Mask Image

[English](README.md)

人物やアニメキャラクターの領域をローカル環境で抽出し、インペイント用マスクや Regional-ControlNet 用の色分けマスクを書き出す Web アプリです。

## 機能

- ブラウザで画像を読み込み。
- ローカルバックエンドで人物/キャラクター候補を検出。
- SAM2 が設定されている場合、検出した枠をマスク化。
- 見落とされた人物を、画像上で四角く囲んで手動追加。
- 各人物を個別に選択。
- 各人物ごとに出力する/しないを切り替え。
- 各人物に Regional-ControlNet 用の `none`, `red`, `blue`, `yellow` を割り当て。
- 誤検出を削除。
- 重なり順を並び替え。
- 選択中の人物マスクをブラシで追加/消去。
- マスクを広げる/縮める。
- 小さいゴミ領域を削除。
- インペイント書き出し時に境界ぼかしを設定可能。
- 書き出し:
  - インペイント用PNG: 元画像のRGBを維持し、選択領域をアルファ値45で示す画像。
  - Regional-ControlNet 用マスク: 白背景に、選択領域を純粋な赤/青/黄で塗った画像。

## 起動

```bash
npm run serve
```

開く URL:

```text
http://127.0.0.1:8787
```

サーバーはデフォルトで `0.0.0.0` に bind します。同じマシンでは `http://127.0.0.1:8787` を開いてください。同じネットワーク上の別端末から使う場合は `http://<このマシンのLAN IP>:8787` を開きます。

このアプリは画像を外部 API にアップロードしません。ML を初めて実行する時、モデルファイルがローカルの Hugging Face キャッシュになければダウンロードされることがあります。

## 自動検出を有効にする

自動検出にはローカル ML 依存関係が必要です。CUDA が使える場合は CUDA セットアップを入れます。

```bash
npm run setup:ml:cuda
```

CUDA セットアップはデフォルトで PyTorch `cu128` を使います。NVIDIA ドライバが古い場合は次を試してください。

```bash
npm run setup:ml:cuda -- cu126
npm run setup:ml:cuda -- cu118
```

CPU のみで使う場合:

```bash
npm run setup:ml:cpu
```

その後、通常どおり起動します。

```bash
npm run serve
```

デフォルトの `auto` バックエンドは次を使います。

- Detector: `IDEA-Research/grounding-dino-tiny`
- Segmenter: `facebook/sam2-hiera-tiny`

モデルは上書きできます。

```bash
export MASK_IMAGE_GDINO_MODEL=IDEA-Research/grounding-dino-base
export MASK_IMAGE_SAM2_MODEL=facebook/sam2.1-hiera-tiny
npm run serve
```

`torch.cuda.is_available()` が true の場合、バックエンドは自動的に CUDA を使います。CPU を強制する場合:

```bash
export MASK_IMAGE_DEVICE=cpu
npm run serve
```

CPU でも動きますが、検出と SAM2 のマスク化は GPU よりかなり遅くなります。

## ビルドとテスト

```bash
npm run build
npm test
```

通常のビルドとテストには ML パッケージは不要です。ML パッケージがない場合、自動検出は無効になり、UI に不足している依存関係が表示されます。手動の四角形セグメンテーションは四角形マスクにフォールバックします。

## 手動チェックポイント設定

バックエンドには、SAM2 + GroundingDINO リポジトリアダプタもあります。これらのプロジェクトとモデルチェックポイントをローカルにインストールし、環境変数を指定して起動します。

```bash
export MASK_IMAGE_PIPELINE=sam_grounding
export MASK_IMAGE_DEVICE=cuda
export MASK_IMAGE_SAM2_CONFIG=/absolute/path/to/sam2_hiera_l.yaml
export MASK_IMAGE_SAM2_CHECKPOINT=/absolute/path/to/sam2_hiera_large.pt
export MASK_IMAGE_GDINO_CONFIG=/absolute/path/to/GroundingDINO_SwinT_OGC.py
export MASK_IMAGE_GDINO_CHECKPOINT=/absolute/path/to/groundingdino_swint_ogc.pth
npm run serve
```

検出プロンプトは UI から編集できます。デフォルトのプロンプトは次です。

```text
anime character . person . human figure . body
```

SAM2 は、検出された各枠をマスク化するために使われます。GroundingDINO が使えなくても SAM2 が設定されていれば、手動で囲んだ枠は SAM2 でマスク化できます。
