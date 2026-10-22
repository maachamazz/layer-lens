(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ================= 設定 ================= */
  const DEFAULT_SETTINGS = { words: ['用紙', 'paper', 'temp', 'tmp'], dupGroups: false, dupHidden: true, outRatio: 50 };
  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('ll-settings') || '{}') }; }
    catch (e) { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() {
    try { localStorage.setItem('ll-settings', JSON.stringify(state.settings)); } catch (e) { /* 保存できなくても動作は継続 */ }
  }

  /* ================= 状態 ================= */
  const state = {
    psd: null,
    fileName: '',
    fileSize: 0,
    nodes: [],          // 表示順（上から）のフラットリスト
    roots: [],          // ルートノード（上から）
    byId: new Map(),
    selected: null,     // 詳細を表示するレイヤー
    multi: new Set(),   // 複数選択（Ctrl/Shift+クリック）
    anchor: null,       // Shift 範囲選択の起点
    history: [],        // 名前変更の「元に戻す」用
    filter: null,       // チェックキー
    search: '',
    collapsed: new Set(),
    pending: new Map(), // id -> 'apply' | 'delete'（マスク処理）
    renames: new Map(), // id -> 元の名前（変更済みのもの）
    source: 'psd',      // 'psd' | 'clip'
    clipNotes: new Map(), // CLIP読み込み時: layer -> [{ key, msg }]
    thumbs: true,
    previewMode: 'all',
    composite: null,
    compositeIsFallback: false,
    settings: loadSettings(),
  };

  /* ================= チェック定義 ================= */
  const LEVELS = {
    err: { label: '要対応', cls: 'c-err' },
    warn: { label: '注意', cls: 'c-warn' },
    info: { label: '情報', cls: 'c-info' },
  };
  const CHECKS = [
    { key: 'compat', level: 'err', label: 'PSDで変わる要素（CLIP）', badge: 'CSP', cls: 'c-clip', clipOnly: true, tip: 'CLIP STUDIO独自の機能で、PSDに変換すると見た目や情報が変わる/失われるレイヤーです。' },
    { key: 'bounds', level: 'err', label: 'キャンバス外', badge: 'OUT', cls: 'c-out', tip: '描画範囲の大部分がキャンバスの外にあります。Cubismでは見切れる/位置がずれる原因になります。' },
    { key: 'mask', level: 'err', label: 'レイヤーマスク', badge: 'MASK', cls: 'c-mask', tip: 'Cubismへの読み込み時、レイヤーマスクは反映されません。マスクを適用（描画に焼き込み）するか削除してください。' },
    { key: 'clip', level: 'err', label: 'クリッピング', badge: 'CLIP', cls: 'c-clip', tip: 'PSDのクリッピングはCubismに引き継がれません。下のレイヤーと結合するか、Cubism側でクリッピングを再設定してください。' },
    { key: 'smart', level: 'err', label: 'スマートオブジェクト', badge: 'SO', cls: 'c-err', tip: 'スマートオブジェクトはラスタライズしてください。' },
    { key: 'text', level: 'err', label: 'テキストレイヤー', badge: 'TXT', cls: 'c-err', tip: 'テキストレイヤーはラスタライズしてください。' },
    { key: 'naming', level: 'warn', label: '命名規則違反', badge: 'NAME', cls: 'c-name', tip: 'デフォルト名・NGワード・前後の空白を含む名前です。Cubism上のパーツ名/アートメッシュ名になるので整理しておくと後が楽です。' },
    { key: 'dup', level: 'warn', label: '同名レイヤー', badge: 'DUP', cls: 'c-dup', tip: '同じ名前のレイヤーが複数あります。Cubism上で区別しづらく、IDの重複・取り違えの原因になります。' },
    { key: 'empty', level: 'warn', label: '空白レイヤー', badge: 'EMPTY', cls: 'c-empty', tip: '描画範囲が0pxのレイヤーです。不要なら削除してください。' },
    { key: 'blend', level: 'warn', label: '特殊なブレンドモード', badge: 'BLEND', cls: 'c-warn', tip: '通常・乗算・加算（覆い焼きリニア）以外のブレンドモードは、Cubismのバージョンによって再現されません。' },
    { key: 'fx', level: 'warn', label: 'レイヤー効果', badge: 'FX', cls: 'c-warn', tip: 'ドロップシャドウ等のレイヤー効果は読み込まれません。ラスタライズ（効果を統合）してください。' },
    { key: 'fill', level: 'warn', label: '「塗り」が100%未満', badge: 'FILL', cls: 'c-warn', tip: '「塗り」の不透明度はCubismに反映されません。「不透明度」で調整するか統合してください。' },
    { key: 'emptyGroup', level: 'info', label: '空のフォルダ', badge: 'EMPTY', cls: 'c-empty', tip: '中身のないフォルダです。' },
    { key: 'hidden', level: 'info', label: '非表示レイヤー', badge: null, cls: 'c-muted', tip: '非表示のレイヤー/フォルダです。差分として意図的なものか確認してください。' },
  ];
  const CHECK = Object.fromEntries(CHECKS.map(c => [c.key, c]));

  const BLEND_JA = {
    'pass through': '通過', normal: '通常', dissolve: 'ディザ合成', darken: '比較(暗)', multiply: '乗算',
    'color burn': '焼き込みカラー', 'linear burn': '焼き込み(リニア)', 'darker color': 'カラー比較(暗)',
    lighten: '比較(明)', screen: 'スクリーン', 'color dodge': '覆い焼きカラー', 'linear dodge': '覆い焼き(リニア)-加算',
    'lighter color': 'カラー比較(明)', overlay: 'オーバーレイ', 'soft light': 'ソフトライト', 'hard light': 'ハードライト',
    'vivid light': 'ビビッドライト', 'linear light': 'リニアライト', 'pin light': 'ピンライト', 'hard mix': 'ハードミックス',
    difference: '差の絶対値', exclusion: '除外', subtract: '減算', divide: '除算', hue: '色相', saturation: '彩度',
    color: 'カラー', luminosity: '輝度',
  };
  const SAFE_BLENDS = new Set(['normal', 'pass through', 'multiply', 'linear dodge']);
  const CANVAS_BLEND = {
    normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
    'color dodge': 'color-dodge', 'color burn': 'color-burn', 'hard light': 'hard-light', 'soft light': 'soft-light',
    difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
    luminosity: 'luminosity', 'linear dodge': 'lighter',
  };
  const DEFAULT_NAME_RE = /^(レイヤー|layer|グループ|group|名称未設定|untitled|シェイプ|shape|長方形|楕円|多角形|rectangle|ellipse|polygon|line|ライン|新規レイヤー|new layer)[\s_-]*\d*$/i;
  const COPY_RE = /(のコピー|\bcopy\b|副本|拷贝)/i;

  /* ================= アイコン ================= */
  const ICON = {
    caret: '<path d="m6 9 6 6 6-6"/>',
    eyeOn: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    clip: '<path d="M6 4v8a4 4 0 0 0 4 4h9"/><path d="m15 12 4 4-4 4"/>',
  };
  function svg(path, cls = '') {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    if (cls) el.setAttribute('class', cls);
    el.innerHTML = path;
    return el;
  }
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  }

  /* ================= UI 参照 ================= */
  const ui = {
    upload: $('#upload-view'), loading: $('#loading-view'), loadingText: $('#loading-text'), dash: $('#dash-view'),
    drop: $('#dropzone'), fileInput: $('#file-input'),
    tree: $('#tree'), checks: $('#checks'), detail: $('#detail'),
    preview: $('#preview'), overlay: $('#preview-overlay'), previewNote: $('#preview-note'),
    filterBar: $('#filter-bar'), filterLabel: $('#filter-label'), filterActions: $('#filter-actions'),
    exportBtn: $('#export-btn'), pendingCount: $('#pending-count'), search: $('#search'), toast: $('#toast'),
  };

  /* ================= テーマ ================= */
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ll-theme', next); } catch (e) { /* noop */ }
  });

  /* ================= トースト ================= */
  let toastTimer = 0;
  function toast(msg, type = 'ok') {
    ui.toast.textContent = msg;
    ui.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3200);
  }

  /* ================= 読み込み ================= */
  function showView(name) {
    ui.upload.classList.toggle('hidden', name !== 'upload');
    ui.loading.classList.toggle('hidden', name !== 'loading');
    ui.dash.classList.toggle('hidden', name !== 'dash');
  }

  const changeCount = () => state.pending.size + state.renames.size;

  function handleFile(file) {
    if (!file) return;
    if (!/\.(psd|clip)$/i.test(file.name)) { toast('.psd または .clip ファイルを選択してください', 'error'); return; }
    showView('loading');
    ui.loadingText.textContent = `「${file.name}」を読み込み中…`;
    file.arrayBuffer().then(buf => loadBuffer(buf, file.name, file.size)).catch(err => {
      console.error(err);
      showView(state.psd ? 'dash' : 'upload');
      toast('ファイルの読み込みに失敗しました', 'error');
    });
  }

  async function loadBuffer(buf, name, size) {
    showView('loading');
    const isClip = /\.clip$/i.test(name);
    ui.loadingText.textContent = `「${name}」を解析中…`;
    // 描画を挟んでからパース（スピナーを表示させるため）
    await new Promise(resolve => setTimeout(resolve, 30));
    let psd, notes = new Map();
    try {
      if (isClip) {
        const res = await ClipReader.read(buf, (done, total) => { ui.loadingText.textContent = `CLIPファイルを変換中… ${done} / ${total}`; });
        psd = res.psd;
        notes = res.notes;
      } else {
        psd = agPsd.readPsd(buf, { useRawData: true, skipThumbnail: true, throwForMissingFeatures: false, logMissingFeatures: false });
      }
    } catch (err) {
      console.error(err);
      showView(state.psd ? 'dash' : 'upload');
      toast('解析に失敗しました：' + (err && err.message ? err.message : err), 'error');
      return;
    }
    state.psd = psd;
    state.source = isClip ? 'clip' : 'psd';
    state.clipNotes = notes;
    state.fileName = name;
    state.fileSize = size || buf.byteLength;
    state.selected = null;
    state.multi.clear();
    state.anchor = null;
    state.history = [];
    state.filter = null;
    state.search = '';
    ui.search.value = '';
    state.collapsed.clear();
    state.pending.clear();
    state.renames.clear();
    thumbCache.clear();
    buildModel();
    showView('dash');
    renderAll();
    buildComposite();
    toast(`解析完了：${state.nodes.length} 項目`);
  }
  // テスト・自動化用
  window.LayerLens = { loadBuffer, state };

  // インストール版（PWA）でエクスプローラーから PSD/CLIP を開いたとき
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      const handle = params.files && params.files[0];
      if (handle) handleFile(await handle.getFile());
    });
  }
  // オフライン対応（http/https で公開しているときだけ。file:// では使えない）
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker', e));
  }

  ui.fileInput.addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = ''; });
  ui.drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.fileInput.click(); } });
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); ui.drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) ui.drop.classList.remove('drag'); }));
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    if (changeCount() && !confirm('未保存の変更があります。破棄して別のファイルを開きますか？')) return;
    handleFile(f);
  });
  window.addEventListener('beforeunload', e => { if (changeCount()) { e.preventDefault(); e.returnValue = ''; } });

  $('#reset-btn').addEventListener('click', () => {
    if (changeCount() && !confirm('未保存の変更があります。破棄しますか？')) return;
    state.psd = null;
    state.pending.clear();
    state.renames.clear();
    compositeGen++;
    showView('upload');
  });

  /* ================= モデル構築 & チェック ================= */
  let idSeq = 0;
  function layerType(l) {
    if (l.children) return 'group';
    if (l.adjustment || l.vectorFill) return 'adjust';
    if (l.text) return 'text';
    if (l.placedLayer) return 'smart';
    return 'pixel';
  }

  function buildModel() {
    idSeq = 0;
    state.nodes = [];
    state.byId.clear();
    const walk = (children, parent, depth) => {
      // ag-psd の children は下→上の順。クリッピングの基準を先に解決する
      const list = children.map(layer => ({
        id: ++idSeq, layer, parent, depth,
        name: layer.name || '',
        type: layerType(layer),
        isGroup: !!layer.children,
        issues: new Set(),
        clipBase: null, clipChildren: [],
        children: [],
      }));
      let base = null;
      for (const n of list) {
        if (n.layer.clipping && base) { n.clipBase = base; base.clipChildren.push(n); }
        else base = n;
      }
      const top = list.slice().reverse();
      for (const n of top) {
        state.byId.set(n.id, n);
        state.nodes.push(n);
        if (n.isGroup) n.children = walk(n.layer.children, n, depth + 1);
      }
      return top;
    };
    state.roots = walk(state.psd.children || [], null, 0);
    runChecks();
  }

  function hasEffects(l) {
    const fx = l.effects;
    if (!fx || fx.disabled) return false;
    return Object.entries(fx).some(([k, v]) => {
      if (k === 'scale' || k === 'disabled') return false;
      if (Array.isArray(v)) return v.some(e => e && e.enabled !== false);
      return v && typeof v === 'object' && v.enabled !== false;
    });
  }
  const hasMask = l => !!(l.mask || l.vectorMask);
  const layerW = l => Math.max(0, (l.right || 0) - (l.left || 0));
  const layerH = l => Math.max(0, (l.bottom || 0) - (l.top || 0));

  function namingProblem(name) {
    if (!name.trim()) return '名前が空です';
    if (name !== name.trim()) return '名前の前後に空白があります';
    if (DEFAULT_NAME_RE.test(name.trim())) return 'デフォルトのままの名前です';
    if (/^(レイヤー|layer)\s*\d+/i.test(name.trim())) return 'デフォルト名（レイヤー＋番号）が残っています';
    if (COPY_RE.test(name)) return '「コピー」を含む名前です';
    const lower = name.toLowerCase();
    const hit = state.settings.words.find(w => w && lower.includes(w.toLowerCase()));
    if (hit) return `NGワード「${hit}」を含みます`;
    return null;
  }

  function runChecks() {
    const { width: W, height: H } = state.psd;
    const s = state.settings;
    const dupMap = new Map();
    for (const n of state.nodes) {
      const l = n.layer;
      n.issues = new Set();
      n.notes = {};
      const nm = namingProblem(n.name);
      if (nm) { n.issues.add('naming'); n.notes.naming = nm; }
      if (l.hidden) n.issues.add('hidden');
      if (hasMask(l)) n.issues.add('mask');
      const cn = state.source === 'clip' && state.clipNotes.get(l);
      if (cn) { n.issues.add('compat'); n.notes.compat = cn.map(x => x.msg); }
      if (l.clipping && n.clipBase) n.issues.add('clip');
      if (hasEffects(l)) n.issues.add('fx');
      if (l.blendMode && !SAFE_BLENDS.has(l.blendMode)) n.issues.add('blend');
      if (l.fillOpacity != null && l.fillOpacity < 0.999) n.issues.add('fill');
      if (n.type === 'smart') n.issues.add('smart');
      if (n.type === 'text') n.issues.add('text');

      if (n.isGroup) {
        if (!l.children.length) n.issues.add('emptyGroup');
      } else if (n.type !== 'adjust') {
        const w = layerW(l), hgt = layerH(l);
        if (!w || !hgt) n.issues.add('empty');
        else {
          const iw = Math.min(W, l.right) - Math.max(0, l.left);
          const ih = Math.min(H, l.bottom) - Math.max(0, l.top);
          const inside = iw > 0 && ih > 0 ? iw * ih : 0;
          const outRatio = 1 - inside / (w * hgt);
          if (outRatio * 100 >= s.outRatio) { n.issues.add('bounds'); n.notes.bounds = `${Math.round(outRatio * 100)}% がキャンバス外`; }
        }
      }

      const key = n.name.trim();
      if (key && (s.dupGroups || !n.isGroup) && (s.dupHidden || !isEffectivelyHidden(n))) {
        if (!dupMap.has(key)) dupMap.set(key, []);
        dupMap.get(key).push(n);
      }
    }
    for (const [, arr] of dupMap) {
      if (arr.length < 2) continue;
      for (const n of arr) { n.issues.add('dup'); n.dupCount = arr.length; }
    }
  }
  function isEffectivelyHidden(n) {
    for (let p = n; p; p = p.parent) if (p.layer.hidden) return true;
    return false;
  }

  /* ================= 描画: 全体 ================= */
  function renderAll() {
    renderHeader();
    renderStats();
    renderChecks();
    renderTree();
    renderDiff();
    renderDetail();
    renderPending();
    renderNamer();
  }

  function renderHeader() {
    const psd = state.psd;
    $('#file-name').textContent = state.fileName;
    const tags = $('#file-tags');
    tags.innerHTML = '';
    const colorModes = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
    const mode = colorModes[psd.colorMode ?? 3] || '不明';
    const bits = psd.bitsPerChannel || 8;
    tags.append(
      h('span', { class: 'tag', text: `${psd.width} × ${psd.height} px` }),
      h('span', { class: 'tag', text: formatBytes(state.fileSize) }),
      h('span', { class: 'tag' + ((psd.colorMode ?? 3) !== 3 ? ' bad' : ''), text: mode, title: (psd.colorMode ?? 3) !== 3 ? 'Cubism用PSDはRGBカラーにしてください' : null }),
      h('span', { class: 'tag' + (bits !== 8 ? ' bad' : ''), text: `${bits}bit`, title: bits !== 8 ? 'Cubism用PSDは8bit/チャンネルにしてください' : null }),
    );
    if (Math.max(psd.width, psd.height) > 8192) tags.append(h('span', { class: 'tag', text: '大きめのキャンバス', title: '長辺8192pxを超えています。Cubismでの作業が重くなりやすいので、必要に応じて縮小を検討してください。' }));
  }

  function renderStats() {
    const layers = state.nodes.filter(n => !n.isGroup).length;
    const groups = state.nodes.length - layers;
    $('#st-layers').textContent = layers;
    $('#st-groups').textContent = groups;
    $('#st-total').textContent = state.nodes.length;
  }

  function countIssue(key) { return state.nodes.reduce((a, n) => a + (n.issues.has(key) ? 1 : 0), 0); }

  function renderChecks() {
    ui.checks.innerHTML = '';
    for (const lv of ['err', 'warn', 'info']) {
      ui.checks.append(h('div', { class: 'check-group' }, h('span', { class: 'chip ' + LEVELS[lv].cls, text: LEVELS[lv].label })));
      for (const c of CHECKS.filter(c => c.level === lv && (!c.clipOnly || state.source === 'clip'))) {
        const num = countIssue(c.key);
        const row = h('button', {
          class: `check-row ${c.cls}` + (num ? '' : ' zero') + (state.filter === c.key ? ' active' : ''),
          title: c.tip,
          onclick: () => setFilter(state.filter === c.key ? null : c.key),
        }, h('span', { class: 'dot' }), h('span', { class: 'label', text: c.label }), h('span', { class: 'num', text: num }));
        ui.checks.append(row);
      }
    }
    // スコア（要対応 = 重み3, 注意 = 1）
    const errN = CHECKS.filter(c => c.level === 'err').reduce((a, c) => a + countIssue(c.key), 0);
    const warnN = CHECKS.filter(c => c.level === 'warn').reduce((a, c) => a + countIssue(c.key), 0);
    const total = Math.max(1, state.nodes.length);
    const flagged = state.nodes.filter(n => [...n.issues].some(k => CHECK[k].level !== 'info')).length;
    const score = Math.round(100 * (1 - flagged / total));
    $('#score-num').textContent = score;
    const fg = $('#ring-fg');
    fg.style.strokeDasharray = `${score} 100`;
    fg.style.stroke = errN ? (score < 60 ? 'var(--err)' : 'var(--warn)') : (warnN ? 'var(--warn)' : 'var(--ok)');
    $('#score-title').textContent = errN ? `要対応 ${errN} 件` : warnN ? '大きな問題はありません' : 'Cubismへの準備OK';
    $('#score-sub').textContent = errN || warnN ? `注意 ${warnN} 件 ・ 問題のない項目 ${score}%` : 'すべてのチェックを通過しました';
  }

  /* ================= フィルタ ================= */
  function setFilter(key) {
    state.filter = key;
    if (key) switchTab('tree');
    renderChecks();
    renderTree();
    // 最初のヒットを選択
    if (key) {
      const first = state.nodes.find(n => n.issues.has(key));
      if (first) select(first.id, true);
    }
  }
  $('#filter-clear').addEventListener('click', () => { state.filter = null; state.search = ''; ui.search.value = ''; renderChecks(); renderTree(); });

  let searchTimer = 0;
  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = ui.search.value.trim().toLowerCase(); renderTree(); }, 120);
  });
  document.addEventListener('keydown', e => {
    if (ui.dash.classList.contains('hidden')) return;
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); ui.search.focus(); }
    else if (e.key === 'Escape' && (state.filter || state.search)) { $('#filter-clear').click(); }
    else if (e.key === 'F2' && !typing && state.selected) { e.preventDefault(); startTreeRename(state.byId.get(state.selected)); }
    else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRename(); }
    else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && state.nodes.length) {
      // 表示中のレイヤーをすべて選択
      e.preventDefault();
      $$('.row', ui.tree).forEach(r => state.multi.add(+r.dataset.id));
      $$('.row', ui.tree).forEach(r => r.classList.add('sel'));
      renderNamer();
    }
    else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.selected) {
      const rows = $$('.row', ui.tree);
      const i = rows.findIndex(r => +r.dataset.id === state.selected);
      const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); select(+next.dataset.id, true); }
    }
  });

  function renderFilterBar() {
    const active = state.filter || state.search;
    ui.filterBar.classList.toggle('hidden', !active);
    if (!active) return;
    const parts = [];
    if (state.filter) parts.push(`${CHECK[state.filter].label}：${countIssue(state.filter)}件`);
    if (state.search) parts.push(`検索「${state.search}」`);
    ui.filterLabel.textContent = parts.join(' ／ ');
    ui.filterActions.innerHTML = '';
    if (state.filter === 'mask') {
      const targets = state.nodes.filter(n => n.issues.has('mask'));
      const applicable = targets.filter(canApplyMask);
      ui.filterActions.append(
        h('button', { class: 'btn btn-sm', text: `すべて適用 (${applicable.length})`, disabled: !applicable.length, title: 'マスクを描画に焼き込みます（フォルダ・無効マスクは削除扱い）',
          onclick: () => { targets.forEach(n => state.pending.set(n.id, canApplyMask(n) ? 'apply' : 'delete')); afterPendingChange(); } }),
        h('button', { class: 'btn btn-sm btn-danger', text: `すべて削除 (${targets.length})`,
          onclick: () => { targets.forEach(n => state.pending.set(n.id, 'delete')); afterPendingChange(); } }),
        h('button', { class: 'btn btn-sm btn-ghost', text: '取り消し', disabled: !targets.some(n => state.pending.has(n.id)),
          onclick: () => { targets.forEach(n => state.pending.delete(n.id)); afterPendingChange(); } }),
      );
    }
    if (state.filter === 'dup') {
      ui.filterActions.append(h('span', { class: 'muted small', text: '同じ名前ごとにまとめて表示しています' }));
    }
  }

  /* ================= ツリー ================= */
  function matchesFilter(n) {
    if (state.filter && !n.issues.has(state.filter)) return false;
    if (state.search && !n.name.toLowerCase().includes(state.search)) return false;
    return true;
  }

  function renderTree() {
    renderFilterBar();
    ui.tree.classList.toggle('no-thumb', !state.thumbs);
    ui.tree.innerHTML = '';
    thumbObserver.disconnect();
    const frag = document.createDocumentFragment();

    if (state.filter === 'dup') {
      // 同名はグループ化して表示
      const groups = new Map();
      for (const n of state.nodes) if (n.issues.has('dup') && matchesFilter(n)) {
        const k = n.name.trim();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      for (const [name, arr] of groups) {
        frag.append(h('div', { class: 'check-group' }, h('span', { class: 'chip c-dup', text: `×${arr.length}` }), h('span', { text: name })));
        arr.forEach(n => frag.append(makeRow(n, false, true)));
      }
    } else if (state.filter || state.search) {
      // ヒットした項目 + 祖先（文脈表示）
      const show = new Set();
      for (const n of state.nodes) if (matchesFilter(n)) { show.add(n.id); for (let p = n.parent; p; p = p.parent) show.add(p.id); }
      for (const n of state.nodes) if (show.has(n.id)) frag.append(makeRow(n, !matchesFilter(n), false));
    } else {
      const walk = list => {
        for (const n of list) {
          frag.append(makeRow(n, false, false));
          if (n.isGroup && !state.collapsed.has(n.id)) walk(n.children);
        }
      };
      walk(state.roots);
    }
    if (!frag.childNodes.length) frag.append(h('div', { class: 'empty-state', text: state.nodes.length ? '該当するレイヤーはありません 🎉' : 'レイヤーがありません' }));
    ui.tree.append(frag);
    $('#toggle-all-btn').textContent = state.collapsed.size ? '全て開く' : '全て閉じる';
  }

  function makeRow(n, ctx, showPath) {
    const l = n.layer;
    const row = h('div', {
      class: ['row', n.isGroup && 'group', ctx && 'ctx', l.hidden && 'is-hidden', n.clipBase && 'clipped', n.clipChildren.length && 'clip-base',
        hasMask(l) && 'has-mask', (state.pending.has(n.id) || state.renames.has(n.id)) && 'pending', (state.multi.has(n.id) || state.selected === n.id) && 'sel'].filter(Boolean).join(' '),
      role: 'treeitem', 'data-id': n.id,
      style: `--d:${showPath ? 0 : n.depth}`,
    });
    if (n.isGroup && !showPath && !state.filter && !state.search) {
      const caret = svg(ICON.caret, 'caret' + (state.collapsed.has(n.id) ? ' closed' : ''));
      caret.addEventListener('click', e => { e.stopPropagation(); toggleGroup(n.id); });
      row.append(caret);
    } else row.append(h('span', { class: 'caret-sp' }));
    row.append(svg(l.hidden ? ICON.eyeOff : ICON.eyeOn, 'eye' + (l.hidden ? '' : ' on')));
    if (n.clipBase) row.append(svg(ICON.clip, 'clip-arrow'));
    if (n.isGroup) row.append(svg(ICON.folder, 'ticon'));
    else {
      const t = h('span', { class: 'thumb', 'data-thumb': n.id });
      row.append(t);
      if (state.thumbs) thumbObserver.observe(t);
    }
    if (l.mask && !n.isGroup) {
      const mt = h('span', { class: 'mask-thumb' + (l.mask.disabled ? ' disabled' : ''), 'data-mthumb': n.id, title: l.mask.disabled ? 'マスク（無効）' : 'レイヤーマスク' });
      row.append(mt);
      if (state.thumbs) thumbObserver.observe(mt);
    }
    const label = showPath ? pathOf(n) : (n.name || '(名称未設定)');
    const nameEl = h('span', { class: 'name', text: label, title: pathOf(n) + '\nダブルクリックで名前を変更' });
    nameEl.addEventListener('dblclick', e => { e.stopPropagation(); select(n.id); startRename(n, nameEl); });
    row.append(nameEl);
    if (!n.isGroup && n.type !== 'adjust') row.append(h('span', { class: 'dims', text: `${layerW(l)}×${layerH(l)}` }));

    const badges = h('span', { class: 'badges' });
    for (const c of CHECKS) {
      if (!n.issues.has(c.key) || !c.badge) continue;
      let text = c.badge;
      if (c.key === 'dup') text += ` ×${n.dupCount}`;
      if (c.key === 'mask') text = l.mask && l.mask.disabled ? 'MASK(無効)' : l.vectorMask && !l.mask ? 'VMASK' : 'MASK';
      if (c.key === 'blend') text = BLEND_JA[l.blendMode] || l.blendMode;
      badges.append(h('span', { class: 'badge ' + c.cls + (c.key === 'mask' ? ' btnlike' : ''), text, title: n.notes[c.key] || c.tip }));
    }
    if (n.clipChildren.length) badges.append(h('span', { class: 'badge c-clip', text: `◀ ${n.clipChildren.length}`, title: `${n.clipChildren.length} 枚のレイヤーがこのレイヤーにクリッピングされています` }));
    row.append(badges);

    row.addEventListener('click', e => select(n.id, false, e.shiftKey ? 'range' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'single'));
    row.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); }); // Shift+クリックで文字選択しない
    row.addEventListener('dblclick', () => { if (n.isGroup && !state.filter && !state.search) toggleGroup(n.id); });
    return row;
  }

  function toggleGroup(id) {
    if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
    renderTree();
  }
  function pathOf(n) {
    const parts = [];
    for (let p = n; p; p = p.parent) parts.unshift(p.name || '(名称未設定)');
    return parts.join(' / ');
  }

  $('#toggle-all-btn').addEventListener('click', () => {
    if (state.collapsed.size) state.collapsed.clear();
    else state.nodes.filter(n => n.isGroup).forEach(n => state.collapsed.add(n.id));
    renderTree();
  });
  $('#thumb-btn').addEventListener('click', e => {
    state.thumbs = !state.thumbs;
    e.currentTarget.setAttribute('aria-pressed', String(state.thumbs));
    renderTree();
  });

  /* ================= サムネイル（遅延生成） ================= */
  const thumbCache = new Map();
  const thumbQueue = [];
  let thumbBusy = false;
  const thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      thumbQueue.push(e.target);
    }
    pumpThumbs();
  }, { root: null, rootMargin: '200px' });

  function pumpThumbs() {
    if (thumbBusy || !thumbQueue.length) return;
    thumbBusy = true;
    const idle = window.requestIdleCallback || (cb => setTimeout(cb, 16));
    idle(() => {
      const start = performance.now();
      while (thumbQueue.length && performance.now() - start < 24) {
        const el = thumbQueue.shift();
        if (!el.isConnected) continue;
        const isMask = el.hasAttribute('data-mthumb');
        const n = state.byId.get(+(isMask ? el.dataset.mthumb : el.dataset.thumb));
        if (!n) continue;
        const c = getThumb(n, isMask);
        if (c) el.append(cloneCanvas(c));
      }
      thumbBusy = false;
      pumpThumbs();
    });
  }

  function getThumb(n, isMask) {
    const key = n.id + (isMask ? 'm' : '');
    if (thumbCache.has(key)) return thumbCache.get(key);
    let c = null;
    try {
      const data = isMask ? agPsd.getLayerMaskImageData(n.layer) : agPsd.getLayerImageData(n.layer);
      if (data) c = scaleToCanvas(imageDataToCanvas(data), 60);
    } catch (e) { console.warn('thumb', n.name, e); }
    thumbCache.set(key, c);
    return c;
  }

  function imageDataToCanvas(data) {
    const c = document.createElement('canvas');
    c.width = data.width; c.height = data.height;
    if (!data.width || !data.height) return c;
    let d = data.data;
    if (!(d instanceof Uint8ClampedArray)) {
      // 16/32bit → 8bit 表示用に変換
      const max = d instanceof Float32Array ? 1 : d instanceof Uint16Array ? 65535 : 255;
      const out = new Uint8ClampedArray(d.length);
      for (let i = 0; i < d.length; i++) out[i] = d[i] / max * 255;
      d = out;
    }
    c.getContext('2d').putImageData(new ImageData(d, data.width, data.height), 0, 0);
    return c;
  }
  function scaleToCanvas(src, max) {
    const s = Math.min(1, max / Math.max(src.width, src.height, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * s));
    c.height = Math.max(1, Math.round(src.height * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function cloneCanvas(src) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  /* ================= 差分情報 ================= */
  function diffLines() {
    const lines = [];
    const visit = (n, depth) => {
      if (depth > 2) return;
      const layers = n.children.filter(c => !c.isGroup).length;
      lines.push({ depth, name: n.name || '(名称未設定)', count: layers });
      n.children.filter(c => c.isGroup).forEach(c => visit(c, depth + 1));
    };
    state.roots.filter(n => n.isGroup).forEach(n => visit(n, 0));
    return lines;
  }
  function renderDiff() {
    const box = $('#diff-list');
    box.innerHTML = '';
    const lines = diffLines();
    if (!lines.length) { box.append(h('div', { class: 'empty-state', text: 'ルート直下にフォルダがないため、差分情報はありません。' })); return; }
    for (const ln of lines) {
      box.append(h('div', { class: 'diff-item', style: `padding-left:${10 + ln.depth * 20}px` },
        h('span', { text: ln.name }), ln.count ? h('b', { text: `${ln.count}種類` }) : h('span', { class: 'muted', text: '—' })));
    }
  }
  const diffText = () => diffLines().map(l => `${'　'.repeat(l.depth)}${l.name}${l.count ? `：${l.count}種類` : ''}`).join('\n');

  /* ================= 選択 & 詳細 ================= */
  // mode: 'single'（通常クリック）/ 'toggle'（Ctrl+クリック）/ 'range'（Shift+クリック）
  function select(id, scroll, mode = 'single') {
    if (mode === 'toggle') {
      if (state.multi.has(id)) state.multi.delete(id); else state.multi.add(id);
      state.anchor = id;
    } else if (mode === 'range' && state.anchor != null) {
      const ids = $$('.row', ui.tree).map(r => +r.dataset.id);
      const a = ids.indexOf(state.anchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        state.multi.clear();
        ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => state.multi.add(x));
      }
    } else {
      state.multi.clear();
      state.multi.add(id);
      state.anchor = id;
    }
    state.selected = id;
    $$('.row', ui.tree).forEach(r => r.classList.toggle('sel', state.multi.has(+r.dataset.id)));
    const row = ui.tree.querySelector(`.row[data-id="${id}"]`);
    if (row && scroll) row.scrollIntoView({ block: 'nearest' });
    renderDetail();
    renderNamer();
    drawPreview();
  }

  function renderDetail() {
    const box = ui.detail;
    box.innerHTML = '';
    const n = state.byId.get(state.selected);
    if (!n) { box.append(h('p', { class: 'muted empty-detail', text: 'レイヤーをクリックすると詳細を表示します。' })); return; }
    const l = n.layer;
    const typeJa = { group: 'フォルダ', pixel: '通常レイヤー', adjust: '調整/塗りつぶし', text: 'テキスト', smart: 'スマートオブジェクト' }[n.type];

    const renamedFrom = state.renames.get(n.id);
    box.append(
      h('div', { class: 'title-row' },
        h('h4', { class: 'detail-title', text: n.name || '(名称未設定)', title: 'ダブルクリック または F2 で名前を変更', ondblclick: () => startRename(n) }),
        h('button', { class: 'btn btn-sm', text: '名前を変更', onclick: () => startRename(n) })),
      h('div', { class: 'path', text: pathOf(n) }));
    if (renamedFrom != null) {
      box.append(h('div', { class: 'callout' }, `元の名前「${renamedFrom || '(名称未設定)'}」から変更しました。保存時に反映されます。 `,
        h('a', { href: '#', text: '元に戻す', onclick: e => { e.preventDefault(); renameNode(n, renamedFrom); } })));
    }

    const props = h('dl', { class: 'props' });
    const add = (k, v) => props.append(h('dt', { text: k }), h('dd', { text: v }));
    add('種類', typeJa);
    if (!n.isGroup) {
      add('サイズ', `${layerW(l)} × ${layerH(l)} px`);
      add('位置', `x ${l.left || 0}, y ${l.top || 0}`);
    } else add('中身', `${n.children.filter(c => !c.isGroup).length} レイヤー / ${n.children.filter(c => c.isGroup).length} フォルダ`);
    add('表示', l.hidden ? '非表示' : '表示');
    add('不透明度', `${Math.round((l.opacity ?? 1) * 100)}%` + (l.fillOpacity != null && l.fillOpacity < 0.999 ? ` ／ 塗り ${Math.round(l.fillOpacity * 100)}%` : ''));
    add('描画モード', BLEND_JA[l.blendMode] || l.blendMode || '通常');
    if (n.clipBase) add('クリップ先', n.clipBase.name || '(名称未設定)');
    if (n.clipChildren.length) add('クリップ元', `${n.clipChildren.length} 枚がクリッピング中`);
    box.append(props);

    const issues = [...n.issues].filter(k => k !== 'hidden');
    if (issues.length) {
      box.append(h('ul', { class: 'issue-list' }, issues.flatMap(k => k === 'compat'
        ? n.notes.compat.map(msg => h('li', {}, h('span', { class: 'chip ' + CHECK[k].cls, text: CHECK[k].badge }), h('span', { text: msg })))
        : [h('li', {}, h('span', { class: 'chip ' + CHECK[k].cls, text: CHECK[k].badge || CHECK[k].label }),
          h('span', { text: (n.notes[k] ? n.notes[k] + '。' : '') + (k === 'dup' ? `同名が ${n.dupCount} 件あります。` : '') + CHECK[k].tip }))])));
    }

    if (n.clipChildren.length) {
      box.append(h('div', { class: 'section-sub' }, h('span', { class: 'chip c-clip', text: 'CLIP' }), 'このレイヤーにクリップされているレイヤー'));
      box.append(h('ul', { class: 'clip-list' }, n.clipChildren.slice().reverse().map(c => h('li', {}, h('a', { href: '#', text: c.name || '(名称未設定)', onclick: e => { e.preventDefault(); revealAndSelect(c); } })))));
    }

    // 画像 & マスク
    if (!n.isGroup) {
      const pair = h('div', { class: 'img-pair' });
      const imgBox = h('div', { class: 'img-box checker' }, h('span', { class: 'cap', text: 'レイヤー' }));
      try {
        const d = agPsd.getLayerImageData(l);
        if (d) imgBox.prepend(scaleToCanvas(imageDataToCanvas(d), 320));
      } catch (e) { console.warn(e); }
      pair.append(imgBox);
      if (l.mask) {
        const mBox = h('div', { class: 'img-box mask-bg' }, h('span', { class: 'cap', text: l.mask.disabled ? 'マスク（無効）' : 'マスク' }));
        try {
          const md = agPsd.getLayerMaskImageData(l);
          if (md) mBox.prepend(scaleToCanvas(imageDataToCanvas(md), 320));
          else mBox.style.background = l.mask.defaultColor ? '#fff' : '#000';
        } catch (e) { console.warn(e); }
        pair.append(mBox);
      }
      box.append(h('div', { class: 'section-sub', text: '画像' }), pair);
    }

    if (hasMask(l)) {
      const pend = state.pending.get(n.id);
      box.append(h('div', { class: 'section-sub' }, h('span', { class: 'chip c-mask', text: 'MASK' }), 'マスクの処理'));
      const parts = [];
      if (l.mask) parts.push(`ピクセルマスク${l.mask.disabled ? '（無効）' : ''}`);
      if (l.vectorMask) parts.push('ベクトルマスク');
      box.append(h('p', { class: 'muted small', style: 'margin:0', text: parts.join(' + ') + (n.isGroup ? '（フォルダのマスクは削除のみ対応）' : '') }));
      box.append(h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm' + (pend === 'apply' ? ' btn-primary' : ''), text: 'マスクを適用', disabled: !canApplyMask(n),
          title: '見えている部分だけを残し、マスクを描画に焼き込みます', onclick: () => { state.pending.set(n.id, 'apply'); afterPendingChange(); } }),
        h('button', { class: 'btn btn-sm btn-danger' + (pend === 'delete' ? ' btn-primary' : ''), text: 'マスクを削除',
          title: 'マスクを捨てます（隠れていた部分が見えるようになります）', onclick: () => { state.pending.set(n.id, 'delete'); afterPendingChange(); } }),
        pend ? h('button', { class: 'btn btn-sm btn-ghost', text: '取り消し', onclick: () => { state.pending.delete(n.id); afterPendingChange(); } }) : null,
      ));
      if (pend) box.append(h('div', { class: 'callout', text: `保存時にマスクを${pend === 'apply' ? '適用' : '削除'}します。右上の「修正版PSDを保存」で書き出してください。` }));
      if (l.vectorMask && pend === 'apply') box.append(h('p', { class: 'muted small', text: '※ベクトルマスクは適用できないため削除されます。' }));
    }
  }

  function revealAndSelect(n) {
    if (state.filter || state.search) { state.filter = null; state.search = ''; ui.search.value = ''; renderChecks(); }
    for (let p = n.parent; p; p = p.parent) state.collapsed.delete(p.id);
    renderTree();
    select(n.id, true);
  }

  function canApplyMask(n) {
    const l = n.layer;
    return !n.isGroup && !!l.mask && !l.mask.disabled && n.type === 'pixel' && (state.psd.bitsPerChannel || 8) === 8;
  }

  function afterPendingChange() {
    renderPending();
    renderTree();
    renderDetail();
  }
  function renderPending() {
    const n = changeCount();
    const isClip = state.source === 'clip';
    ui.pendingCount.textContent = n;
    ui.pendingCount.classList.toggle('hidden', isClip && !n);
    $('#export-label').textContent = isClip ? 'PSDに変換して保存' : '修正版PSDを保存';
    ui.exportBtn.disabled = !(isClip || n);
  }

  /* ================= 名前の変更 ================= */
  // 名前変更はすべてここを通す（保存待ちの管理と「元に戻す」の記録）
  function setName(n, name) {
    const original = state.renames.has(n.id) ? state.renames.get(n.id) : n.name;
    n.name = name;
    n.layer.name = name;
    if (name === original) state.renames.delete(n.id);
    else state.renames.set(n.id, original);
  }
  function refreshAfterRename() {
    runChecks();
    renderChecks();
    renderPending();
    renderTree();
    renderDetail();
    renderNamer();
  }
  // changes: [{ n, name }]。実際に変わった件数を返す
  function applyNames(changes, label) {
    const done = [];
    for (const { n, name } of changes) {
      if (name === n.name || !name.trim()) continue;
      done.push({ id: n.id, before: n.name, after: name });
      setName(n, name);
    }
    if (done.length) {
      state.history.push({ label, changes: done });
      if (state.history.length > 100) state.history.shift();
    }
    refreshAfterRename();
    return done.length;
  }
  function renameNode(n, newName) {
    applyNames([{ n, name: newName }], '名前の変更');
  }
  function undoRename() {
    const last = state.history.pop();
    if (!last) { toast('元に戻せる操作はありません'); return; }
    for (const c of last.changes.slice().reverse()) {
      const n = state.byId.get(c.id);
      if (n) setName(n, c.before);
    }
    refreshAfterRename();
    toast(`元に戻しました：${last.label}（${last.changes.length}件）`);
  }

  // target（名前の表示要素）を入力欄に置き換えて編集する
  function startRename(n, target) {
    target = target || $('.detail-title', ui.detail);
    if (!n || !target) return;
    const inTree = target.classList.contains('name');
    const input = h('input', { class: inTree ? 'tree-rename' : 'rename-input', type: 'text', 'aria-label': 'レイヤー名', spellcheck: 'false' });
    input.value = n.name;
    let finished = false;
    const finish = commit => {
      if (finished) return;
      finished = true;
      if (commit && input.value !== n.name) renameNode(n, input.value);
      else if (inTree) input.replaceWith(target);
      else renderDetail();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    ['click', 'dblclick', 'mousedown'].forEach(ev => input.addEventListener(ev, e => e.stopPropagation()));
    input.addEventListener('blur', () => finish(true));
    target.replaceWith(input);
    input.focus();
    input.select();
  }
  function startTreeRename(n) {
    const row = ui.tree.querySelector(`.row[data-id="${n.id}"]`);
    const span = row && $('.name', row);
    if (span) { row.scrollIntoView({ block: 'nearest' }); startRename(n, span); }
    else startRename(n);
  }

  /* ================= 命名ツール（Photoshop プラグイン「レイヤー自動命名」の移植） ================= */
  const SEP = ' ';
  const STAMP_GROUPS = { R: ['R', 'L'], L: ['R', 'L'], 線画: ['線画', '塗り'], 塗り: ['線画', '塗り'] };
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 「未命名」とみなす名前（プラグインの判定 + CSP/Photoshop の既定名）
  function isUnnamed(name) {
    const s = (name || '').trim();
    return !s || /^レイヤー/.test(s) || /^Layer\b/i.test(s) || /^(フォルダー|フォルダ|グループ|group)\s*\d*$/i.test(s)
      || /のコピー/.test(s) || /\bcopy\b/i.test(s) || DEFAULT_NAME_RE.test(s);
  }

  // 選択中のノード（ツリーの表示順＝上から）
  function selectedNodes() {
    return state.nodes.filter(n => state.multi.has(n.id));
  }
  function descendants(list, out = []) {
    for (const n of list) { out.push(n); if (n.isGroup) descendants(n.children, out); }
    return out;
  }

  function nmAutoNumber() {
    const sel = selectedNodes();
    let groups = sel.filter(n => n.isGroup);
    // レイヤーだけ選んでいる場合は、その親フォルダーを対象にする
    if (!groups.length) groups = [...new Set(sel.map(n => n.parent).filter(Boolean))];
    if (!groups.length) { toast('フォルダーを選択してください（中のレイヤーを選んでもOK）', 'error'); return; }
    if ($('#nm-auto-deep').checked) groups = [...new Set(groups.flatMap(g => [g, ...descendants(g.children).filter(c => c.isGroup)]))];
    // 親から順に処理し、同じ操作で付いた新しいフォルダー名を子の連番にも使う
    groups.sort((a, b) => a.depth - b.depth);
    const next = new Map(); // node -> この操作で付ける名前
    const nameOf = n => next.has(n) ? next.get(n) : n.name;
    for (const g of groups) {
      const base = nameOf(g).trim();
      if (!base) continue;
      const numRe = new RegExp('^' + escapeRe(base) + escapeRe(SEP) + '(\\d+)$');
      let counter = 0;
      for (const c of g.children) { const m = nameOf(c).match(numRe); if (m) counter = Math.max(counter, +m[1]); }
      for (const c of g.children) if (isUnnamed(nameOf(c))) next.set(c, base + SEP + (++counter));
    }
    const k = applyNames([...next].map(([n, name]) => ({ n, name })), '連番命名');
    toast(k ? `${k} 個のレイヤーに連番を付けました` : '対象の未命名レイヤーが見つかりませんでした');
  }

  function nmStamp(word) {
    const sel = selectedNodes();
    if (!sel.length) { toast('レイヤーまたはフォルダーを選択してください', 'error'); return; }
    const group = STAMP_GROUPS[word] || [word];
    const suffixRe = new RegExp(escapeRe(SEP) + '(' + group.map(escapeRe).join('|') + ')$');
    const k = applyNames(sel.map(n => ({ n, name: n.name.replace(suffixRe, '') + SEP + word })), `スタンプ「${word}」`);
    toast(`${k} 個に「${word}」を付けました`);
  }

  function nmCollapseSpaces() {
    const sel = selectedNodes();
    const targets = sel.length ? sel : state.nodes;
    const k = applyNames(targets.map(n => ({ n, name: n.name.replace(/ {2,}/g, ' ').trim() })), 'スペース整理');
    toast(k ? `${k} 個の名前のスペースを整理しました${sel.length ? '' : '（全レイヤー対象）'}` : '整理が必要なスペースは見つかりませんでした');
  }

  // 同名レイヤーに連番を付けて区別する（選択なしなら同名レイヤーすべて）
  function nmDedupe() {
    const sel = selectedNodes();
    const pool = (sel.length ? sel : state.nodes.filter(n => n.issues.has('dup')));
    const used = new Set(state.nodes.map(n => n.name.trim()));
    const byName = new Map();
    for (const n of pool) {
      const key = n.name.trim();
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(n);
    }
    const changes = [];
    for (const [name, arr] of byName) {
      if (arr.length < 2) continue;
      let i = 0;
      for (const n of arr) {
        let cand;
        do cand = name + SEP + (++i); while (used.has(cand));
        used.add(cand);
        changes.push({ n, name: cand });
      }
    }
    const k = applyNames(changes, '同名に連番');
    toast(k ? `${k} 個の同名レイヤーに連番を付けました` : '連番を付ける同名レイヤーはありません');
  }

  function nmReplace() {
    const find = $('#nm-find').value;
    const rep = $('#nm-rep').value;
    if (!find) { toast('置換前の文字を入力してください', 'error'); return; }
    const sel = selectedNodes();
    if (!sel.length) { toast('レイヤーまたはフォルダーを選択してください', 'error'); return; }
    const targets = $('#nm-children').checked ? [...new Set(descendants(sel))] : sel;
    let skipped = 0;
    const changes = [];
    for (const n of targets) {
      if (!n.name.includes(find)) continue;
      const name = n.name.split(find).join(rep);
      if (!name.trim()) { skipped++; continue; } // 名前が空になるものは飛ばす
      changes.push({ n, name });
    }
    const k = applyNames(changes, '名前の置換');
    toast((k ? `${k} 個の名前を置換しました` : `「${find}」を含む名前は見つかりませんでした`) + (skipped ? `（空になる ${skipped} 個はスキップ）` : ''));
  }

  // 自分で追加したスタンプ
  let stampDeleteMode = false;
  function loadStamps() {
    try { const v = JSON.parse(localStorage.getItem('ll-stamps') || '[]'); return Array.isArray(v) ? v.filter(w => typeof w === 'string' && w) : []; }
    catch (e) { return []; }
  }
  function saveStamps(list) {
    try { localStorage.setItem('ll-stamps', JSON.stringify(list)); } catch (e) { toast('スタンプを保存できませんでした', 'error'); }
  }
  function nmAddStamp() {
    const input = $('#nm-new');
    const word = input.value.trim();
    if (!word) { toast('追加する単語を入力してください', 'error'); return; }
    const list = loadStamps();
    if (list.includes(word) || STAMP_GROUPS[word]) { toast(`「${word}」は既にあります`, 'error'); return; }
    list.push(word);
    saveStamps(list);
    input.value = '';
    renderNamer();
  }

  function renderNamer() {
    const sel = selectedNodes();
    $('#nm-count').textContent = sel.length ? `${sel.length} 件選択中` : '未選択';
    const box = $('#nm-custom');
    box.innerHTML = '';
    for (const w of loadStamps()) {
      box.append(h('button', {
        class: 'btn btn-sm' + (stampDeleteMode ? ' btn-danger' : ''), text: (stampDeleteMode ? '× ' : '＋ ') + w,
        onclick: () => {
          if (!stampDeleteMode) return nmStamp(w);
          saveStamps(loadStamps().filter(x => x !== w));
          if (!loadStamps().length) stampDeleteMode = false;
          renderNamer();
        },
      }));
    }
    $('#nm-del-mode').textContent = stampDeleteMode ? '完了' : '削除';
    $('#nm-undo').disabled = !state.history.length;
    $('#nm-undo').textContent = state.history.length ? `元に戻す：${state.history[state.history.length - 1].label}` : '元に戻す';
  }

  $('#nm-auto').addEventListener('click', nmAutoNumber);
  $$('[data-stamp]').forEach(b => b.addEventListener('click', () => nmStamp(b.dataset.stamp)));
  $('#nm-space').addEventListener('click', nmCollapseSpaces);
  $('#nm-dedupe').addEventListener('click', nmDedupe);
  $('#nm-replace').addEventListener('click', nmReplace);
  $('#nm-add').addEventListener('click', nmAddStamp);
  $('#nm-new').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); nmAddStamp(); } });
  $('#nm-del-mode').addEventListener('click', () => {
    if (!stampDeleteMode && !loadStamps().length) { toast('削除できるスタンプがありません', 'error'); return; }
    stampDeleteMode = !stampDeleteMode;
    renderNamer();
  });
  $('#nm-undo').addEventListener('click', undoRename);

  /* ================= プレビュー ================= */
  const PREVIEW_MAX = 1200;
  let compositeGen = 0;

  // 大きいPSD（6000px超など）でもメモリを使い切らないよう、プレビュー解像度で保持する
  async function buildComposite() {
    const gen = ++compositeGen;
    const psd = state.psd;
    state.composite = null;
    state.compositeIsFallback = false;
    state.zoomCanvas = null;
    try {
      const d = state.source === 'psd' && agPsd.getCompositeImageData(psd);
      if (d && d.width && !isUniform(d)) state.composite = scaleToCanvas(imageDataToCanvas(d), PREVIEW_MAX);
    } catch (e) { console.warn('composite', e); }
    if (!state.composite) {
      state.compositeIsFallback = true;
      ui.previewNote.textContent = 'プレビューを生成中…';
      try {
        const out = await renderComposite(psd, PREVIEW_MAX, () => gen !== compositeGen);
        if (gen !== compositeGen) return;
        state.composite = out;
      } catch (e) {
        if (gen !== compositeGen) return;
        console.warn('composite render', e);
      }
    }
    drawPreview();
  }

  // 「互換性を優先」オフで保存されたPSDは統合画像が単色（白/透明）になる
  function isUniform(img) {
    const d = img.data, step = 64;
    const first = [d[0], d[1], d[2], d[3]];
    for (let y = 0; y < img.height; y += Math.max(1, Math.floor(img.height / step))) {
      for (let x = 0; x < img.width; x += Math.max(1, Math.floor(img.width / step))) {
        const i = (y * img.width + x) * 4;
        if (d[i] !== first[0] || d[i + 1] !== first[1] || d[i + 2] !== first[2] || d[i + 3] !== first[3]) return false;
      }
    }
    return true;
  }

  // マスク適用後のレイヤーは rawData ではなく imageData を持つ
  function layerPixels(l) {
    if (l.imageData) return l.imageData;
    try { return agPsd.getLayerImageData(l); } catch (e) { return null; }
  }

  // 各レイヤーを重ねて統合画像を作る（ブレンド・不透明度・クリッピング・マスク対応、レイヤー効果は省略）
  // 長辺 maxSide に縮小して描く。Infinity なら原寸（書き出し用）
  async function renderComposite(psd, maxSide, cancelled = () => false) {
    const s = Math.min(1, maxSide / Math.max(psd.width, psd.height));
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
    let last = performance.now();
    const breathe = async () => {
      if (performance.now() - last < 30) return;
      await new Promise(r => setTimeout(r, 0));
      last = performance.now();
      if (cancelled()) throw new Error('cancelled');
    };

    // フォルダの描画範囲（子の外接矩形、キャンバス内に制限）
    const boundsMemo = new Map();
    const contentBounds = l => {
      if (boundsMemo.has(l)) return boundsMemo.get(l);
      let b = null;
      if (l.children) {
        for (const c of l.children) {
          const cb = contentBounds(c);
          if (cb) b = b ? { left: Math.min(b.left, cb.left), top: Math.min(b.top, cb.top), right: Math.max(b.right, cb.right), bottom: Math.max(b.bottom, cb.bottom) } : { ...cb };
        }
        if (b) b = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(psd.width, b.right), bottom: Math.min(psd.height, b.bottom) };
        if (b && (b.right <= b.left || b.bottom <= b.top)) b = null;
      } else if (layerW(l) && layerH(l)) b = { left: l.left, top: l.top, right: l.right, bottom: l.bottom };
      boundsMemo.set(l, b);
      return b;
    };

    const applyMask = (l, r) => {
      const m = l.mask;
      if (!m || m.disabled) return;
      let md = null;
      try { md = agPsd.getLayerMaskImageData(l); } catch (e) { /* マスク無しとして扱う */ }
      const mc = mk(r.c.width, r.c.height);
      const mctx = mc.getContext('2d');
      if (m.defaultColor) { mctx.fillStyle = '#000'; mctx.fillRect(0, 0, mc.width, mc.height); }
      if (md && md.width && md.height) {
        const mx = m.left * s - r.x, my = m.top * s - r.y, mw = md.width * s, mh = md.height * s;
        mctx.clearRect(mx, my, mw, mh);
        mctx.drawImage(grayToAlpha(md), mx, my, mw, mh);
      }
      const ctx = r.c.getContext('2d');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mc, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };

    const renderLayer = async l => {
      let r;
      if (l.children) {
        const b = contentBounds(l);
        if (!b) return null;
        const x = Math.floor(b.left * s), y = Math.floor(b.top * s);
        const c = mk(Math.ceil(b.right * s) - x, Math.ceil(b.bottom * s) - y);
        await drawList(c.getContext('2d'), x, y, l.children);
        r = { c, x, y };
      } else {
        const d = layerPixels(l);
        if (!d || !d.width || !d.height) return null;
        const src = imageDataToCanvas(d);
        if (s === 1) r = { c: src, x: l.left, y: l.top };
        else {
          const x = Math.floor(l.left * s), y = Math.floor(l.top * s);
          const c = mk(Math.ceil(l.right * s) - x, Math.ceil(l.bottom * s) - y);
          c.getContext('2d').drawImage(src, l.left * s - x, l.top * s - y, d.width * s, d.height * s);
          r = { c, x, y };
        }
      }
      applyMask(l, r);
      return r;
    };

    const drawList = async (ctx, ox, oy, children) => {
      let base = null; // 直近のクリッピング土台（null = 無し / 'hidden' = 非表示）
      for (const l of children) { // 下→上
        const clipped = l.clipping && base;
        if (clipped && base === 'hidden') continue;
        if (l.hidden) { if (!clipped) base = 'hidden'; continue; }
        let r = await renderLayer(l);
        if (!r) { if (!clipped) base = 'hidden'; continue; }
        if (clipped) {
          const t = mk(base.c.width, base.c.height);
          const tctx = t.getContext('2d');
          tctx.drawImage(r.c, r.x - base.x, r.y - base.y);
          tctx.globalCompositeOperation = 'destination-in';
          tctx.drawImage(base.c, 0, 0);
          r = { c: t, x: base.x, y: base.y };
        } else base = r;
        ctx.save();
        ctx.globalAlpha = (l.opacity ?? 1) * (l.children ? 1 : (l.fillOpacity ?? 1));
        ctx.globalCompositeOperation = CANVAS_BLEND[l.blendMode] || 'source-over';
        ctx.drawImage(r.c, r.x - ox, r.y - oy);
        ctx.restore();
        await breathe();
      }
    };

    const out = mk(Math.round(psd.width * s), Math.round(psd.height * s));
    await drawList(out.getContext('2d'), 0, 0, psd.children || []);
    return out;
  }

  // グレースケールのマスク画像 → 明るさをアルファにしたキャンバス
  function grayToAlpha(md) {
    const max = md.data instanceof Float32Array ? 1 : md.data instanceof Uint16Array ? 65535 : 255;
    const out = new Uint8ClampedArray(md.width * md.height * 4);
    for (let i = 0, j = 3; i < md.data.length; i += 4, j += 4) out[j] = md.data[i] / max * 255;
    const c = document.createElement('canvas');
    c.width = md.width; c.height = md.height;
    c.getContext('2d').putImageData(new ImageData(out, md.width, md.height), 0, 0);
    return c;
  }

  function drawPreview() {
    if (!state.psd) return;
    const { width: W, height: H } = state.psd;
    const cv = ui.preview, ov = ui.overlay;
    const s = Math.min(1, PREVIEW_MAX / Math.max(W, H));
    const cw = Math.round(W * s), ch = Math.round(H * s);
    for (const c of [cv, ov]) { c.width = cw; c.height = ch; }
    const ctx = cv.getContext('2d');
    const octx = ov.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    octx.clearRect(0, 0, cw, ch);
    const n = state.byId.get(state.selected);

    if (state.previewMode === 'solo' && n && !n.isGroup) {
      try {
        const d = agPsd.getLayerImageData(n.layer);
        if (d && d.width) ctx.drawImage(imageDataToCanvas(d), (n.layer.left || 0) * s, (n.layer.top || 0) * s, d.width * s, d.height * s);
      } catch (e) { console.warn(e); }
    } else if (state.composite) {
      ctx.drawImage(state.composite, 0, 0, cw, ch);
    }

    if (n) {
      const b = boundsOf(n);
      if (b) {
        const x = b.left * s, y = b.top * s, w = (b.right - b.left) * s, hh = (b.bottom - b.top) * s;
        if (state.previewMode === 'all') {
          octx.fillStyle = 'rgba(10, 8, 30, .45)';
          octx.fillRect(0, 0, cw, ch);
          octx.clearRect(x, y, w, hh);
        }
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7158ff';
        octx.strokeStyle = n.issues.has('bounds') ? '#ff3b5c' : accent;
        octx.lineWidth = 2;
        octx.setLineDash([6, 4]);
        octx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, hh - 2));
      }
    }
    // キャンバス枠
    octx.setLineDash([]);
    octx.strokeStyle = 'rgba(128,128,160,.6)';
    octx.lineWidth = 1;
    octx.strokeRect(0.5, 0.5, cw - 1, ch - 1);

    const notes = [];
    if (state.compositeIsFallback) notes.push(state.source === 'clip'
      ? '※CLIPファイルのため、各レイヤーから合成して表示しています（レイヤー効果は省略）。'
      : '※PSDの統合画像が空（単色）のため、各レイヤーから合成して表示しています（レイヤー効果は省略）。');
    if (n && n.isGroup) notes.push('フォルダ内のレイヤー範囲を枠で表示しています。');
    notes.push('クリックで拡大表示');
    ui.previewNote.textContent = notes.join(' ');
  }

  function boundsOf(n) {
    if (!n.isGroup) {
      const l = n.layer;
      return layerW(l) && layerH(l) ? { left: l.left, top: l.top, right: l.right, bottom: l.bottom } : null;
    }
    let b = null;
    const visit = c => {
      if (c.isGroup) return c.children.forEach(visit);
      const cb = boundsOf(c);
      if (!cb) return;
      b = b ? { left: Math.min(b.left, cb.left), top: Math.min(b.top, cb.top), right: Math.max(b.right, cb.right), bottom: Math.max(b.bottom, cb.bottom) } : cb;
    };
    n.children.forEach(visit);
    return b;
  }

  $$('.seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    state.previewMode = b.dataset.pv;
    drawPreview();
  }));

  /* ================= 拡大ビューア ================= */
  const viewer = {
    el: $('#viewer'), stage: $('#viewer-stage'), wrap: $('#viewer-wrap'), canvas: $('#viewer-canvas'), sel: $('#viewer-sel'),
    z: 1, tx: 0, ty: 0,
    scale: 1,          // 表示画像px / ドキュメントpx
    offX: 0, offY: 0,  // 表示画像の原点（ドキュメント座標）
    token: 0, bg: 0,
  };
  const ZOOM_COMPOSITE_MAX = 12000; // 統合画像をそのまま使う場合の長辺上限（通常は原寸）
  const ZOOM_RENDER_MAX = 4096;     // レイヤーから合成する場合の長辺上限

  async function getZoomComposite() {
    if (state.zoomCanvas) return state.zoomCanvas;
    const psd = state.psd;
    if (!state.compositeIsFallback) {
      // 原寸の統合画像は大きい（数百MB）ので保持せず、開くたびに作る（1秒程度）
      try { const d = agPsd.getCompositeImageData(psd); if (d) return scaleToCanvas(imageDataToCanvas(d), ZOOM_COMPOSITE_MAX); } catch (e) { console.warn(e); }
    }
    const c = await renderComposite(psd, ZOOM_RENDER_MAX);
    if (psd === state.psd) state.zoomCanvas = c;
    return c;
  }

  async function openViewer() {
    if (!state.psd) return;
    const token = ++viewer.token;
    viewer.el.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const n = state.byId.get(state.selected);
    const solo = state.previewMode === 'solo' && n && !n.isGroup;
    $('#viewer-title').textContent = solo ? (n.name || '(名称未設定)') : state.fileName;
    if (solo) {
      const d = layerPixels(n.layer);
      showViewerImage(d && d.width ? imageDataToCanvas(d) : null, 1, n.layer.left || 0, n.layer.top || 0, true);
      return;
    }
    // まずプレビュー画像ですぐ表示し、高解像度版ができたら差し替える
    showViewerImage(state.composite, state.composite ? state.composite.width / state.psd.width : 1, 0, 0, true);
    if (!state.zoomCanvas) $('#viewer-status').textContent = '高解像度で読み込み中…';
    try {
      const hi = await getZoomComposite();
      if (token === viewer.token && !viewer.el.classList.contains('hidden')) showViewerImage(hi, hi.width / state.psd.width, 0, 0, false);
    } catch (e) { console.warn(e); }
    if (token === viewer.token) $('#viewer-status').textContent = '';
  }

  function showViewerImage(src, scale, offX, offY, fit) {
    const cv = viewer.canvas;
    const prevScale = viewer.scale;
    cv.width = src ? src.width : 1;
    cv.height = src ? src.height : 1;
    if (src) cv.getContext('2d').drawImage(src, 0, 0);
    viewer.scale = scale; viewer.offX = offX; viewer.offY = offY;
    // 選択中レイヤーの範囲
    const n = state.byId.get(state.selected);
    const b = n && state.previewMode === 'all' && boundsOf(n);
    viewer.sel.classList.toggle('hidden', !b);
    if (b) Object.assign(viewer.sel.style, {
      left: (b.left - offX) * scale + 'px', top: (b.top - offY) * scale + 'px',
      width: (b.right - b.left) * scale + 'px', height: (b.bottom - b.top) * scale + 'px',
    });
    if (fit) fitViewer();
    else { viewer.z *= prevScale / scale; applyViewer(); } // 見た目の大きさを保ったまま解像度だけ差し替え
  }

  function fitViewer() {
    const r = viewer.stage.getBoundingClientRect();
    const cw = viewer.canvas.width, ch = viewer.canvas.height;
    viewer.z = Math.min(r.width / cw, r.height / ch) * 0.94;
    viewer.tx = (r.width - cw * viewer.z) / 2;
    viewer.ty = (r.height - ch * viewer.z) / 2;
    applyViewer();
  }
  function zoomViewerAt(z, cx, cy) {
    const r = viewer.stage.getBoundingClientRect();
    const fitZ = Math.min(r.width / viewer.canvas.width, r.height / viewer.canvas.height);
    z = Math.min(Math.max(z, fitZ * 0.25), 32 / viewer.scale);
    viewer.tx = cx - (cx - viewer.tx) * (z / viewer.z);
    viewer.ty = cy - (cy - viewer.ty) * (z / viewer.z);
    viewer.z = z;
    applyViewer();
  }
  function applyViewer() {
    viewer.wrap.style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.z})`;
    viewer.canvas.style.imageRendering = viewer.z >= 2 ? 'pixelated' : 'auto';
    viewer.sel.style.borderWidth = 2 / viewer.z + 'px';
    $('#viewer-zoom').textContent = Math.round(viewer.z * viewer.scale * 100) + '%';
  }
  function closeViewer() {
    viewer.token++;
    viewer.el.classList.add('hidden');
    document.body.style.overflow = '';
    viewer.canvas.width = viewer.canvas.height = 1;
  }
  const stageCenter = () => { const r = viewer.stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };

  $('.preview-wrap').addEventListener('click', openViewer);
  viewer.stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = viewer.stage.getBoundingClientRect();
    zoomViewerAt(viewer.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null;
  viewer.stage.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, tx: viewer.tx, ty: viewer.ty };
    viewer.stage.setPointerCapture(e.pointerId);
    viewer.stage.classList.add('grabbing');
  });
  viewer.stage.addEventListener('pointermove', e => {
    if (!drag) return;
    viewer.tx = drag.tx + e.clientX - drag.x;
    viewer.ty = drag.ty + e.clientY - drag.y;
    applyViewer();
  });
  const endDrag = () => { drag = null; viewer.stage.classList.remove('grabbing'); };
  viewer.stage.addEventListener('pointerup', endDrag);
  viewer.stage.addEventListener('pointercancel', endDrag);
  viewer.stage.addEventListener('dblclick', e => {
    const r = viewer.stage.getBoundingClientRect();
    const one = 1 / viewer.scale;
    if (Math.abs(viewer.z - one) / one < 0.05) fitViewer();
    else zoomViewerAt(one, e.clientX - r.left, e.clientY - r.top);
  });
  const viewerAction = act => {
    if (act === 'in') zoomViewerAt(viewer.z * 1.5, ...stageCenter());
    else if (act === 'out') zoomViewerAt(viewer.z / 1.5, ...stageCenter());
    else if (act === 'fit') fitViewer();
    else if (act === 'one') zoomViewerAt(1 / viewer.scale, ...stageCenter());
    else if (act === 'bg') { viewer.bg = (viewer.bg + 1) % 3; viewer.stage.dataset.bg = ['checker', 'dark', 'light'][viewer.bg]; }
    else if (act === 'close') closeViewer();
  };
  $$('[data-vz]').forEach(b => b.addEventListener('click', () => viewerAction(b.dataset.vz)));
  document.addEventListener('keydown', e => {
    if (viewer.el.classList.contains('hidden')) return;
    const act = { Escape: 'close', '+': 'in', ';': 'in', '-': 'out', '0': 'fit', '1': 'one' }[e.key];
    if (act) { e.preventDefault(); e.stopImmediatePropagation(); viewerAction(act); }
  }, true);
  window.addEventListener('resize', () => { if (!viewer.el.classList.contains('hidden')) fitViewer(); });

  /* ================= タブ ================= */
  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $('#tab-tree').classList.toggle('hidden', name !== 'tree');
    $('#tab-diff').classList.toggle('hidden', name !== 'diff');
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* ================= マスク処理 & 書き出し ================= */
  function removeMask(layer) {
    delete layer.mask;
    delete layer.realMask;
    delete layer.vectorMask;
    if (layer.rawData) layer.rawData.channels = layer.rawData.channels.filter(c => c.id !== -2 && c.id !== -3);
  }

  function applyMask(layer) {
    const img = agPsd.getLayerImageData(layer);
    const m = layer.mask;
    if (!img || !img.width || !m || m.disabled) { removeMask(layer); return; }
    const md = agPsd.getLayerMaskImageData(layer);
    const mw = Math.max(0, (m.right || 0) - (m.left || 0));
    const mh = Math.max(0, (m.bottom || 0) - (m.top || 0));
    const def = (m.defaultColor ?? 255) / 255;
    const density = m.userMaskDensity ?? 1;
    const lx = layer.left || 0, ly = layer.top || 0;
    const d = img.data;
    for (let y = 0; y < img.height; y++) {
      const my = ly + y - (m.top || 0);
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (!d[i + 3]) continue;
        const mx = lx + x - (m.left || 0);
        let v = def;
        if (md && mx >= 0 && my >= 0 && mx < mw && my < mh) v = md.data[(my * mw + mx) * 4] / 255;
        v = 1 - density * (1 - v);
        d[i + 3] = Math.round(d[i + 3] * v);
      }
    }
    delete layer.rawData;
    layer.imageData = img;
    removeMask(layer);
  }

  ui.exportBtn.addEventListener('click', async () => {
    const isClip = state.source === 'clip';
    if (!isClip && !changeCount()) return;
    ui.exportBtn.disabled = true;
    ui.loadingText.textContent = isClip ? 'PSDに変換中…' : '修正版PSDを書き出し中…';
    showView('loading');
    await new Promise(r => setTimeout(r, 30));
    const psd = state.psd;
    const summary = { apply: 0, delete: 0, rename: state.renames.size };
    try {
      for (const [id, op] of state.pending) {
        const n = state.byId.get(id);
        if (!n) continue;
        if (op === 'apply' && canApplyMask(n)) { applyMask(n.layer); summary.apply++; }
        else { removeMask(n.layer); summary.delete++; }
      }
      // 統合画像（エクスプローラーのサムネイル等に使われる）を作り直す。
      // 元の統合画像のままだと、マスクを消した部分などが反映されない
      if (isClip || state.pending.size || !psd.rawCompositeData) {
        ui.loadingText.textContent = '統合画像を作成中…';
        psd.canvas = await renderComposite(psd, Infinity);
        delete psd.imageData;
      } else if (!psd.imageData && !psd.canvas) {
        const comp = agPsd.getCompositeImageData(psd); // 名前変更だけなら元の統合画像をそのまま使う
        if (comp) psd.imageData = comp;
      }
      ui.loadingText.textContent = 'PSDを書き出し中…';
      await new Promise(r => setTimeout(r, 30));
      const out = agPsd.writePsd(psd, { generateThumbnail: true });
      delete psd.canvas;
      const name = isClip ? state.fileName.replace(/\.clip$/i, '') + '.psd' : state.fileName.replace(/\.psd$/i, '') + '_fixed.psd';
      download(new Blob([out], { type: 'image/vnd.adobe.photoshop' }), name);
      state.pending.clear();
      state.renames.clear();
      const parts = [];
      if (summary.apply) parts.push(`マスク適用 ${summary.apply}`);
      if (summary.delete) parts.push(`マスク削除 ${summary.delete}`);
      if (summary.rename) parts.push(`名前変更 ${summary.rename}`);
      await loadBuffer(out, name, out.byteLength);
      toast(`保存しました：${name}${parts.length ? '（' + parts.join(' ／ ') + '）' : ''}`);
    } catch (err) {
      console.error(err);
      toast('書き出しに失敗しました：' + (err && err.message ? err.message : err), 'error');
      // 失敗時は元ファイルの状態が崩れている可能性があるため、再読み込みを促す
      showView('dash');
      renderPending();
    }
  });

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ================= コピー系 ================= */
  function copy(text, msg) {
    const done = () => toast(msg);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('コピーに失敗しました', 'error'); }
    ta.remove();
  }

  function treeText() {
    const lines = [];
    const walk = (list, depth) => list.forEach(n => {
      const marks = [];
      if (n.clipBase) marks.push('[クリップ]');
      if (hasMask(n.layer)) marks.push('[マスク]');
      if (n.layer.hidden) marks.push('[非表示]');
      lines.push(`${'　'.repeat(depth)}${n.isGroup ? '📁 ' : '・'}${n.name || '(名称未設定)'}${marks.length ? ' ' + marks.join('') : ''}`);
      if (n.isGroup) walk(n.children, depth + 1);
    });
    walk(state.roots, 0);
    return lines.join('\n');
  }

  function reportText() {
    const psd = state.psd;
    const out = [`# PSDチェックレポート：${state.fileName}`, '',
      `- キャンバス：${psd.width} × ${psd.height} px / ${psd.bitsPerChannel || 8}bit`,
      `- レイヤー ${state.nodes.filter(n => !n.isGroup).length} ／ フォルダ ${state.nodes.filter(n => n.isGroup).length}`, ''];
    for (const lv of ['err', 'warn']) {
      out.push(`## ${LEVELS[lv].label}`);
      let any = false;
      for (const c of CHECKS.filter(c => c.level === lv)) {
        const hits = state.nodes.filter(n => n.issues.has(c.key));
        if (!hits.length) continue;
        any = true;
        out.push(`### ${c.label}（${hits.length}件）`);
        hits.forEach(n => out.push(`- ${pathOf(n)}${n.notes[c.key] ? `（${[].concat(n.notes[c.key]).join('／')}）` : ''}`));
      }
      if (!any) out.push('なし');
      out.push('');
    }
    return out.join('\n');
  }

  $('#copy-tree-btn').addEventListener('click', () => copy(treeText(), '階層構造をコピーしました'));
  $('#copy-diff-btn').addEventListener('click', () => copy(diffText(), '差分情報をコピーしました'));
  $('#report-btn').addEventListener('click', () => copy(reportText(), 'チェックレポートをコピーしました（Markdown）'));

  /* ================= 設定ダイアログ ================= */
  const dlg = $('#settings-dlg');
  $('#settings-btn').addEventListener('click', () => {
    $('#set-words').value = state.settings.words.join(', ');
    $('#set-dup-groups').checked = state.settings.dupGroups;
    $('#set-dup-hidden').checked = state.settings.dupHidden;
    $('#set-out').value = state.settings.outRatio;
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    state.settings.words = $('#set-words').value.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
    state.settings.dupGroups = $('#set-dup-groups').checked;
    state.settings.dupHidden = $('#set-dup-hidden').checked;
    state.settings.outRatio = Math.min(100, Math.max(1, +$('#set-out').value || 50));
    saveSettings();
    if (state.psd) { runChecks(); renderChecks(); renderTree(); renderDetail(); }
    toast('設定を保存しました');
  });

  /* ================= util ================= */
  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
})();
