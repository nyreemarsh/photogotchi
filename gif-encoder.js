// Minimal animated GIF89a encoder — no external dependencies
// createAnimatedGIF(canvases, delayCs, maxW) → blob object URL

function createAnimatedGIF(canvases, delayCs = 80, maxW = 420) {
  const src = canvases[0];
  const scale = Math.min(1, maxW / src.width);
  const W = Math.round(src.width * scale), H = Math.round(src.height * scale);

  const frames = canvases.map(c => {
    const s = document.createElement('canvas');
    s.width = W; s.height = H;
    s.getContext('2d').drawImage(c, 0, 0, W, H);
    return s.getContext('2d').getImageData(0, 0, W, H);
  });

  // palette index 0 is reserved as the transparent slot, so colours start at 1
  const palette = [[0, 0, 0], ...buildPalette(frames, 255)];
  const indexed = frames.map(f => quantizeFrame(f, palette));

  const bytes = [];
  const w2  = v => [v & 0xFF, v >> 8];
  const s2b = s => [...s].map(c => c.charCodeAt(0));

  // Header + Logical Screen Descriptor
  bytes.push(...s2b('GIF89a'));
  bytes.push(...w2(W), ...w2(H), 0xF7, 0, 0);

  // Global Color Table (256 × 3 bytes)
  for (let i = 0; i < 256; i++) {
    const c = palette[i] || [0, 0, 0];
    bytes.push(c[0], c[1], c[2]);
  }

  // Netscape looping extension (loop forever)
  bytes.push(0x21, 0xFF, 0x0B, ...s2b('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00);

  for (const idx of indexed) {
    // Graphic Control Extension — disposal 2 (restore to background) so frames
    // don't ghost through each other, plus transparency on palette index 0
    bytes.push(0x21, 0xF9, 0x04, 0x09, ...w2(delayCs), 0x00, 0x00);
    // Image Descriptor
    bytes.push(0x2C, ...w2(0), ...w2(0), ...w2(W), ...w2(H), 0x00);
    // LZW-compressed image data
    const lzw = lzwEncode(idx, 8);
    bytes.push(8);
    for (let i = 0; i < lzw.length; i += 255) {
      const blk = lzw.slice(i, Math.min(i + 255, lzw.length));
      bytes.push(blk.length, ...blk);
    }
    bytes.push(0);
  }
  bytes.push(0x3B); // GIF trailer

  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/gif' }));
}

// ── Colour quantisation ────────────────────────────────────────────────────

function buildPalette(frames, n) {
  const samples = [];
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 16)
      if (d[i + 3] > 64) samples.push([d[i], d[i + 1], d[i + 2]]);
  }
  return medianCut(samples.length ? samples : [[0, 0, 0]], n);
}

function medianCut(colors, n) {
  let boxes = [colors.slice()];
  while (boxes.length < n) {
    let bi = -1, br = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const r = chRange(boxes[i]);
      if (r > br) { br = r; bi = i; }
    }
    if (bi < 0 || br === 0) break;
    const box = boxes[bi];
    const ch  = dominantCh(box);
    box.sort((a, b) => a[ch] - b[ch]);
    const m = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, m), box.slice(m));
  }
  return boxes.map(b =>
    b.length
      ? b.reduce((a, c) => [a[0]+c[0], a[1]+c[1], a[2]+c[2]], [0,0,0])
           .map(v => v / b.length | 0)
      : [0, 0, 0]
  );
}

function chRange(box) {
  let max = 0;
  for (let ch = 0; ch < 3; ch++) {
    let mn = 255, mx = 0;
    for (const c of box) { if (c[ch] < mn) mn = c[ch]; if (c[ch] > mx) mx = c[ch]; }
    if (mx - mn > max) max = mx - mn;
  }
  return max;
}

function dominantCh(box) {
  let best = 0, br = 0;
  for (let ch = 0; ch < 3; ch++) {
    let mn = 255, mx = 0;
    for (const c of box) { if (c[ch] < mn) mn = c[ch]; if (c[ch] > mx) mx = c[ch]; }
    if (mx - mn > br) { br = mx - mn; best = ch; }
  }
  return best;
}

function quantizeFrame(imageData, palette) {
  const d = imageData.data, out = new Uint8Array(d.length >> 2);
  const cache = new Map();
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    if (d[i + 3] < 128) { out[j] = 0; continue; } // transparent slot
    const key = (d[i] << 16) | (d[i+1] << 8) | d[i+2];
    if (!cache.has(key)) {
      let best = 1, bestD = Infinity;
      for (let k = 1; k < palette.length; k++) {
        const p = palette[k];
        const dist = (d[i]-p[0])**2 + (d[i+1]-p[1])**2 + (d[i+2]-p[2])**2;
        if (dist < bestD) { bestD = dist; best = k; }
      }
      cache.set(key, best);
    }
    out[j] = cache.get(key);
  }
  return out;
}

// ── GIF LZW encoder ────────────────────────────────────────────────────────

function lzwEncode(indices, minCode) {
  const clr = 1 << minCode, eof = clr + 1;
  const out = [];
  let buf = 0, bits = 0, cs = minCode + 1, nc = eof + 1, root = {};

  const init = () => {
    root = {};
    for (let i = 0; i < clr; i++) root[i] = { v: i, c: {} };
    nc = eof + 1; cs = minCode + 1;
  };
  const emit = code => {
    buf |= code << bits; bits += cs;
    while (bits >= 8) { out.push(buf & 0xFF); buf >>>= 8; bits -= 8; }
  };

  init(); emit(clr);
  let node = null;
  for (const idx of indices) {
    if (!node) { node = root[idx]; continue; }
    if (node.c[idx]) { node = node.c[idx]; continue; }
    emit(node.v);
    if (nc < 4096) {
      node.c[idx] = { v: nc, c: {} }; nc++;
      // decoders build their table one code behind, so the width must grow one
      // code later than `nc` reaching the limit or the bitstream desyncs
      if (nc > (1 << cs) && cs < 12) cs++;
    } else { emit(clr); init(); }
    node = root[idx];
  }
  if (node) emit(node.v);
  emit(eof);
  if (bits > 0) out.push(buf & 0xFF);
  return out;
}
