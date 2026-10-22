/*
 * CLIP STUDIO PAINT (.clip) リーダー
 * .clip を ag-psd 互換の Psd オブジェクトに変換する（ピクセルは PSD の RLE 形式で保持）。
 * ファイル構造は clip_to_psd (MIT, https://github.com/dobrokot/clip_to_psd) の解析を参考にしています。
 *
 *   CSFCHUNK ヘッダ → CHNK チャンク列
 *     CHNKSQLi : レイヤー情報などの SQLite データベース
 *     CHNKExta : 外部データ。ピクセルは 256x256 タイルごとに zlib 圧縮
 */
(() => {
  'use strict';

  const TILE = 256;
  const TILE_PX = TILE * TILE;

  // CSP の合成モード番号 → ag-psd のブレンドモード名
  const BLEND = {
    0: 'normal', 1: 'darken', 2: 'multiply', 3: 'color burn', 4: 'linear burn', 5: 'subtract', 6: 'darker color',
    7: 'lighten', 8: 'screen', 9: 'color dodge', 10: 'color dodge', 11: 'linear dodge', 12: 'linear dodge',
    13: 'lighter color', 14: 'overlay', 15: 'soft light', 16: 'hard light', 17: 'vivid light', 18: 'linear light',
    19: 'pin light', 20: 'hard mix', 21: 'difference', 22: 'exclusion', 23: 'hue', 24: 'saturation', 25: 'color',
    26: 'luminosity', 30: 'pass through', 36: 'divide',
  };
  const GLOW = { 10: '覆い焼き(発光)', 12: '加算(発光)' };

  const utf16 = s => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) >> 8; b[i * 2 + 1] = s.charCodeAt(i) & 255; } return b; };
  const BEGIN = utf16('BlockDataBeginChunk');
  const END_LEN = 4 + utf16('BlockDataEndChunk').length;
  const STATUS = utf16('BlockStatus');
  const CHECKSUM = utf16('BlockCheckSum');

  const u32 = (d, o) => ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
  const u64 = (d, o) => u32(d, o) * 4294967296 + u32(d, o + 4);
  function eqAt(d, o, pat) {
    if (o + pat.length > d.length) return false;
    for (let i = 0; i < pat.length; i++) if (d[o + i] !== pat[i]) return false;
    return true;
  }
  const ascii = (d, o, n) => String.fromCharCode(...d.subarray(o, o + n));

  /* ---------- チャンク ---------- */
  function readChunks(bytes) {
    if (ascii(bytes, 0, 8) !== 'CSFCHUNK') throw new Error('CLIP STUDIO のファイルではありません');
    let off = 24;
    let sqlite = null;
    const exta = new Map(); // 外部ID → データ（タイル列）
    while (off + 16 <= bytes.length) {
      if (ascii(bytes, off, 4) !== 'CHNK') throw new Error('チャンク構造が壊れています (' + off + ')');
      const name = ascii(bytes, off + 4, 4);
      const size = u64(bytes, off + 8);
      const body = bytes.subarray(off + 16, off + 16 + size);
      if (name === 'SQLi') sqlite = body;
      else if (name === 'Exta') {
        const idLen = u64(body, 0);
        const id = ascii(body, 8, idLen);
        exta.set(id, body.subarray(8 + idLen + 8));
      }
      off += 16 + size;
    }
    if (!sqlite) throw new Error('レイヤー情報（SQLite）が見つかりません');
    return { sqlite, exta };
  }

  // タイル列を [ブロック番号] → 圧縮データ（無ければ null）に分解
  function parseBlocks(d) {
    const blocks = [];
    let i = 0;
    while (i < d.length) {
      let size;
      if (u32(d, i) === 11 && eqAt(d, i + 4, STATUS)) {
        size = u32(d, i + 30) * 4 + 12 + STATUS.length + 4;
      } else if (u32(d, i) === 13 && eqAt(d, i + 4, CHECKSUM)) {
        size = 4 + CHECKSUM.length + 12 + blocks.length * 4;
      } else if (eqAt(d, i + 8, BEGIN)) {
        size = u32(d, i);
        const block = d.subarray(i + 8 + BEGIN.length, i + size - END_LEN);
        const has = u32(block, 16);
        blocks.push(has ? block.subarray(28) : null);
      } else {
        throw new Error('タイルデータを解析できません');
      }
      if (!size) throw new Error('タイルデータのサイズが不正です');
      i += size;
    }
    return blocks;
  }

  // Offscreen.Attribute（ビットマップのサイズ・タイル数・チャンネル構成）
  function parseAttribute(a) {
    let o = 0;
    const int = () => { const v = u32(a, o); o += 4; return v; };
    const str = () => { const n = int(); o += n * 2; };
    int(); int(); const extra = int(); int();
    str(); // "Parameter"
    const width = int(), height = int(), gridW = int(), gridH = int();
    const params = []; for (let k = 0; k < 16; k++) params.push(int());
    str(); // "InitColor"
    int(); const defaultFill = int();
    return { width, height, gridW, gridH, channels: [params[1], params[2]], bitPacked: params[8] === 32, defaultFill, extra };
  }

  /* ---------- PackBits (PSD RLE) ---------- */
  function packBitsRow(src, n, out, pos) {
    let i = 0;
    while (i < n) {
      // 同じ値の連続
      let run = 1;
      while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
      if (run >= 2) {
        out[pos++] = 257 - run; out[pos++] = src[i];
        i += run;
        continue;
      }
      // 連続しない区間
      const start = i;
      i++;
      while (i < n && i - start < 128) {
        if (i + 1 < n && src[i] === src[i + 1]) break;
        i++;
      }
      const len = i - start;
      out[pos++] = len - 1;
      for (let k = 0; k < len; k++) out[pos++] = src[start + k];
    }
    return pos;
  }

  // planes: チャンネルごとに (x, y) → 値 を返す関数で行を埋め、RLE データ（行長テーブル + 本体）を作る
  function encodeChannel(w, h, fillRow) {
    const row = new Uint8Array(w);
    const tmp = new Uint8Array(w * 2 + 8);
    const counts = new Uint8Array(h * 2);
    const parts = [];
    let total = 0;
    for (let y = 0; y < h; y++) {
      fillRow(y, row);
      const len = packBitsRow(row, w, tmp, 0);
      counts[y * 2] = len >> 8; counts[y * 2 + 1] = len & 255;
      parts.push(tmp.slice(0, len));
      total += len;
    }
    const data = new Uint8Array(counts.length + total);
    data.set(counts, 0);
    let p = counts.length;
    for (const part of parts) { data.set(part, p); p += part.length; }
    return data;
  }

  /* ---------- ビットマップ取り出し ---------- */
  function loadTiles(ctx, offscreenId) {
    const off = ctx.offscreen.get(offscreenId);
    if (!off) return null;
    const key = typeof off.BlockData === 'string' ? off.BlockData : ascii(off.BlockData, 0, off.BlockData.length);
    const raw = ctx.exta.get(key);
    if (!raw) return null;
    const attr = parseAttribute(off.Attribute);
    const blocks = parseBlocks(raw);
    return { attr, blocks };
  }

  function mipmapToOffscreen(ctx, mipmapId) {
    if (!mipmapId) return null;
    const mm = ctx.mipmap.get(mipmapId);
    const info = mm && ctx.mipmapInfo.get(mm.BaseMipmapInfo);
    return info ? info.Offscreen : null;
  }

  // 表現色モノクロ/グレーの描画色（メイン = 値0、サブ = 値255）
  function drawColors(row) {
    const c = n => ['Red', 'Green', 'Blue'].map(k => row[n + k] == null ? null : Math.round(row[n + k] / 4294967295 * 255));
    const main = c('DrawColorMain'), sub = c('DrawColorSub');
    return { main: main.includes(null) ? [0, 0, 0] : main, sub: sub.includes(null) ? [255, 255, 255] : sub };
  }

  // カラー（A + BGRx の5プレーン）/ グレー・モノクロ（A + 値の2プレーン）→ RLE 4チャンネル & タイトな範囲
  function decodeColorLayer(ctx, t, ox, oy, warn, colors) {
    const { attr, blocks } = t;
    const gray = attr.channels[0] === 1 && attr.channels[1] === 1;
    if (attr.channels[0] !== 1 || (attr.channels[1] !== 4 && !gray) || attr.bitPacked) {
      warn('mono', 'このレイヤーの表現色（ピクセル形式）には対応していないため、空のレイヤーとして書き出します');
      return null;
    }
    if (gray) warn('mono', '表現色がモノクロ/グレーのレイヤーです。PSDではカラー画像に変換して書き出します');
    const planes = gray ? 2 : 5;
    const tiles = new Map();
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let gy = 0; gy < attr.gridH; gy++) {
      for (let gx = 0; gx < attr.gridW; gx++) {
        const b = blocks[gy * attr.gridW + gx];
        if (!b) continue;
        let px;
        try { px = fflate.unzlibSync(b); } catch (e) { continue; }
        if (px.length < TILE_PX * planes) continue;
        // アルファ範囲を調べる
        let tx0 = TILE, ty0 = TILE, tx1 = -1, ty1 = -1;
        for (let y = 0; y < TILE; y++) {
          const r = y * TILE;
          for (let x = 0; x < TILE; x++) {
            if (px[r + x]) { if (x < tx0) tx0 = x; if (x > tx1) tx1 = x; if (y < ty0) ty0 = y; ty1 = y; }
          }
        }
        if (tx1 < 0) continue;
        tiles.set(gy * attr.gridW + gx, px);
        x0 = Math.min(x0, gx * TILE + tx0); x1 = Math.max(x1, gx * TILE + tx1);
        y0 = Math.min(y0, gy * TILE + ty0); y1 = Math.max(y1, gy * TILE + ty1);
      }
    }
    x1 = Math.min(x1, attr.width - 1); y1 = Math.min(y1, attr.height - 1);
    if (!tiles.size || x1 < x0 || y1 < y0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // PSD チャンネル id → タイル内オフセット（BGRx は k + 0..3、グレーは k から1バイトずつ）
    const plane = gray
      ? { [-1]: [0, 1], 0: [TILE_PX, 1], 1: [TILE_PX, 1], 2: [TILE_PX, 1] }
      : { [-1]: [0, 1], 0: [TILE_PX + 2, 4], 1: [TILE_PX + 1, 4], 2: [TILE_PX, 4] };
    const channels = [-1, 0, 1, 2].map(id => {
      const [base, step] = plane[id];
      // グレー値 → 描画色（メイン〜サブの補間）
      const lut = gray && id >= 0 ? Uint8Array.from({ length: 256 }, (_, v) => Math.round(colors.main[id] + (colors.sub[id] - colors.main[id]) * v / 255)) : null;
      const data = encodeChannel(w, h, (y, row) => {
        const sy = y0 + y, gy = Math.floor(sy / TILE), ty = sy - gy * TILE;
        let x = 0;
        while (x < w) {
          const sx = x0 + x, gx = Math.floor(sx / TILE), tx = sx - gx * TILE;
          const n = Math.min(TILE - tx, w - x);
          const px = tiles.get(gy * attr.gridW + gx);
          if (!px) row.fill(0, x, x + n);
          else {
            let s = base + (ty * TILE + tx) * step;
            if (lut) for (let k = 0; k < n; k++, s += step) row[x + k] = lut[px[s]];
            else for (let k = 0; k < n; k++, s += step) row[x + k] = px[s];
          }
          x += n;
        }
      });
      return { id, compression: 1, data };
    });
    return { channels, left: ox + x0, top: oy + y0, right: ox + x0 + w, bottom: oy + y0 + h };
  }

  // マスク（1プレーン）→ RLE 1チャンネル。範囲は存在するタイルの外接矩形
  function decodeMask(t, ox, oy) {
    const { attr, blocks } = t;
    const def = attr.defaultFill ? 255 : 0;
    if (attr.channels[0] + attr.channels[1] !== 1) return null;
    let gx0 = Infinity, gy0 = Infinity, gx1 = -1, gy1 = -1;
    const tiles = new Map();
    for (let gy = 0; gy < attr.gridH; gy++) {
      for (let gx = 0; gx < attr.gridW; gx++) {
        const b = blocks[gy * attr.gridW + gx];
        if (!b) continue;
        let px;
        try { px = fflate.unzlibSync(b); } catch (e) { continue; }
        if (px.length < TILE_PX) continue;
        tiles.set(gy * attr.gridW + gx, px);
        gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx); gy0 = Math.min(gy0, gy); gy1 = Math.max(gy1, gy);
      }
    }
    if (!tiles.size) return { defaultColor: def, left: 0, top: 0, right: 0, bottom: 0, channel: null };
    const x0 = gx0 * TILE, y0 = gy0 * TILE;
    const w = Math.min((gx1 + 1) * TILE, attr.width) - x0;
    const h = Math.min((gy1 + 1) * TILE, attr.height) - y0;
    const data = encodeChannel(w, h, (y, row) => {
      const sy = y0 + y, gy = Math.floor(sy / TILE), ty = sy - gy * TILE;
      for (let x = 0; x < w; x += TILE) {
        const gx = Math.floor((x0 + x) / TILE);
        const n = Math.min(TILE, w - x);
        const px = tiles.get(gy * attr.gridW + gx);
        if (!px) row.fill(def, x, x + n);
        else row.set(px.subarray(ty * TILE, ty * TILE + n), x);
      }
    });
    return { defaultColor: def, left: ox + x0, top: oy + y0, right: ox + x0 + w, bottom: oy + y0 + h, channel: { id: -2, compression: 1, data } };
  }

  // 単色レイヤー（用紙など）をキャンバス全体の RLE で作る
  function solidChannels(W, H, rgb) {
    const vals = { [-1]: 255, 0: rgb[0], 1: rgb[1], 2: rgb[2] };
    return [-1, 0, 1, 2].map(id => ({ id, compression: 1, data: encodeChannel(W, H, (y, row) => row.fill(vals[id])) }));
  }

  /* ---------- SQLite ---------- */
  let sqlPromise = null;
  function getSql() {
    if (!sqlPromise) {
      const bin = Uint8Array.from(atob(window.SQL_WASM_BASE64), c => c.charCodeAt(0));
      sqlPromise = initSqlJs({ wasmBinary: bin });
    }
    return sqlPromise;
  }
  function rows(db, sql) {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  }

  // 画面更新のために処理を譲る。setTimeout は裏タブで1秒に間引かれるので MessageChannel を使う
  function yieldToBrowser() {
    return new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    });
  }

  /* ---------- メイン ---------- */
  async function read(buffer, onProgress = () => {}) {
    const bytes = new Uint8Array(buffer);
    const { sqlite, exta } = readChunks(bytes);
    const SQL = await getSql();
    const db = new SQL.Database(sqlite);
    let canvas, layerRows, ctx;
    try {
      const tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
      canvas = rows(db, 'SELECT CanvasWidth, CanvasHeight, CanvasResolution, CanvasRootFolder FROM Canvas')[0];
      layerRows = rows(db, 'SELECT * FROM Layer');
      ctx = {
        exta,
        offscreen: new Map(rows(db, 'SELECT MainId, BlockData, Attribute FROM Offscreen').map(r => [r.MainId, r])),
        mipmap: new Map(rows(db, 'SELECT MainId, BaseMipmapInfo FROM Mipmap').map(r => [r.MainId, r])),
        mipmapInfo: new Map(rows(db, 'SELECT MainId, Offscreen FROM MipmapInfo').map(r => [r.MainId, r])),
        vectorLayers: new Set(tables.has('VectorObjectList') ? rows(db, 'SELECT LayerId FROM VectorObjectList').map(r => r.LayerId) : []),
      };
    } finally {
      db.close();
    }

    const W = Math.round(canvas.CanvasWidth), H = Math.round(canvas.CanvasHeight);
    const byId = new Map(layerRows.map(r => [r.MainId, r]));
    const notes = new Map(); // layer → [{ key, msg }]
    const total = layerRows.length;
    let done = 0;
    let lastYield = performance.now();

    const has = (r, col) => r[col] != null && r[col] !== 0 && r[col] !== '';

    async function build(row) {
      const name = row.LayerName || '';
      const layer = {
        name,
        hidden: !(row.LayerVisibility & 1),
        opacity: Math.max(0, Math.min(1, (row.LayerOpacity ?? 256) / 256)),
        clipping: !!row.LayerClip,
        blendMode: BLEND[row.LayerComposite] || 'normal',
        transparencyProtected: !!(row.LayerLock & 16),
      };
      const list = [];
      const warn = (key, msg) => list.push({ key, msg });

      if (GLOW[row.LayerComposite]) {
        warn('glow', `合成モード「${GLOW[row.LayerComposite]}」はPSDに無いため「${row.LayerComposite === 12 ? '覆い焼き(リニア)-加算' : '覆い焼きカラー'}」に置き換わります。見た目が変わることがあります`);
        layer.transparencyShapesLayer = false;
      }
      if (!BLEND[row.LayerComposite] && row.LayerComposite != null) warn('blend', `PSDに対応する合成モードがありません（番号 ${row.LayerComposite}）。「通常」で書き出します`);
      if (has(row, 'DraftLayer') || has(row, 'OutputAttribute')) warn('draft', '下描きレイヤーです。CSPのPSD書き出しでは出力されない/非表示になる設定です');
      if (has(row, 'Manager3DOd')) warn('3d', '3Dレイヤーです。PSDでは現在の見た目の画像として書き出し、3D情報は失われます');
      const isMaterial = has(row, 'ResizableImageInfo');

      if (row.LayerFolder) {
        layer.opened = !(row.LayerFolder & 16);
        layer.children = [];
        for (let id = row.LayerFirstChildIndex; id; id = (byId.get(id) || {}).LayerNextIndex) {
          const child = byId.get(id);
          if (!child) break;
          layer.children.push(await build(child));
        }
      } else {
        const isText = has(row, 'TextLayerString') || has(row, 'TextLayerAttributes');
        const isFilter = has(row, 'FilterLayerInfo') || has(row, 'FilterLayerV132');
        const isGradient = has(row, 'GradationFillInfo');
        // 用紙レイヤー（モノクロ表現色の素材も DrawColorEnable を持つので種別で見分ける）
        const isPaper = has(row, 'SpecialRenderType') || (has(row, 'DrawColorEnable') && (row.LayerType & ~3) !== 0);
        if (isText) warn('text', 'テキストレイヤーです。PSDでは画像（ラスタライズ済み）として書き出します');
        if (ctx.vectorLayers.has(row.MainId)) warn('vector', 'ベクターレイヤーです。PSDでは画像（ラスタライズ済み）になり、ベクター情報は失われます');
        if (isFilter) warn('filter', '色調補正レイヤーです。PSDには効果を引き継げないため、空のレイヤーとして書き出します');
        if (isGradient) warn('fill', 'グラデーション/ベタ塗りレイヤーです。PSDでは画像として書き出します（ピクセルが無い場合は空になります）');

        let px = null;
        if (isPaper) {
          warn('paper', '用紙レイヤーです。キャンバス全体の単色画像として書き出します（Live2D用には削除推奨）');
          const rgb = ['Red', 'Green', 'Blue'].map(c => Math.round((row['DrawColorMain' + c] || 0) / 4294967295 * 255));
          px = { channels: solidChannels(W, H, rgb), left: 0, top: 0, right: W, bottom: H };
        } else if (!isFilter) {
          const offId = mipmapToOffscreen(ctx, row.LayerRenderMipmap);
          const t = offId && loadTiles(ctx, offId);
          if (t) {
            const ox = (row.LayerOffsetX || 0) + (row.LayerRenderOffscrOffsetX || 0);
            const oy = (row.LayerOffsetY || 0) + (row.LayerRenderOffscrOffsetY || 0);
            px = decodeColorLayer(ctx, t, ox, oy, warn, drawColors(row));
          }
        }
        if (isMaterial) warn('material', px
          ? '画像素材レイヤーです。PSDでは通常の画像になり、拡大・縮小などの変形情報は失われます'
          : '画像素材レイヤーです。変形前の素材として保存されているため画像を取り出せず、空のレイヤーになります。CSPで「ラスタライズ」してから読み込んでください');
        const channels = px ? px.channels : [-1, 0, 1, 2].map(id => ({ id, compression: 0, data: undefined }));
        Object.assign(layer, px ? { left: px.left, top: px.top, right: px.right, bottom: px.bottom } : { left: 0, top: 0, right: 0, bottom: 0 });
        layer.rawData = { colorMode: 3, bitsPerChannel: 8, channels, large: false };
      }

      // レイヤーマスク（フォルダにも付く）
      const maskOff = mipmapToOffscreen(ctx, row.LayerLayerMaskMipmap);
      const mt = maskOff && loadTiles(ctx, maskOff);
      if (mt) {
        const ox = (row.LayerMaskOffsetX || 0) + (row.LayerOffsetX || 0) + (row.LayerMaskOffscrOffsetX || 0);
        const oy = (row.LayerMaskOffsetY || 0) + (row.LayerOffsetY || 0) + (row.LayerMaskOffscrOffsetY || 0);
        const m = decodeMask(mt, ox, oy);
        if (m) {
          layer.mask = {
            top: m.top, left: m.left, bottom: m.bottom, right: m.right,
            defaultColor: m.defaultColor,
            disabled: !(row.LayerVisibility & 2),
            positionRelativeToLayer: !(row.LayerSelect & 256),
          };
          // フォルダ等は空のカラーチャンネル + マスク
          if (!layer.rawData) layer.rawData = { colorMode: 3, bitsPerChannel: 8, channels: [-1, 0, 1, 2].map(id => ({ id, compression: 0, data: undefined })), large: false };
          if (m.channel) layer.rawData.channels.push(m.channel);
        }
      }

      if (list.length) notes.set(layer, list);
      done++;
      onProgress(done, total);
      if (performance.now() - lastYield > 50) { await yieldToBrowser(); lastYield = performance.now(); }
      return layer;
    }

    const root = byId.get(canvas.CanvasRootFolder);
    if (!root) throw new Error('ルートフォルダが見つかりません');
    const top = await build(root);
    const psd = { width: W, height: H, colorMode: 3, bitsPerChannel: 8, children: top.children || [] };
    if (canvas.CanvasResolution) psd.imageResources = { resolutionInfo: { horizontalResolution: canvas.CanvasResolution, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: canvas.CanvasResolution, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } };
    return { psd, notes };
  }

  window.ClipReader = { read };
})();
