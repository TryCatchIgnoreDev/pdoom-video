// Scene-native arithmetic coding diagrams driven by the verified Qwen token trace.
import { Layer2D, W, H } from './gl';
import type { PostParams } from './post';
import type { Word } from './lyrics';
import { rgba, type PaletteKey } from './palette';
import { F, font, measure } from './type';
import { clamp, ease, lerp, prog, smoothstep } from './util';

export interface CompressionSummary {
  modelName: string;
  modelFile: string;
  method: string;
  vocabSize: number;
  cdfBits: number;
  numTokens: number;
  originalBytes: number;
  originalChars: number;
  compressedBytes: number;
  headerBytes: number;
  payloadBytes: number;
  payloadBits: number;
  zlibBytes: number;
  ratio: number;
  bitsPerByte: number;
  bitsPerChar: number;
  entropyBits: number;
  exactMatch: boolean;
  sha256: string;
}

export interface CompressionTickLevel {
  d: number;
  originRel: number;
  stepRel: number;
  ticks: [number, string, boolean][];
}

export interface CompressionToken {
  i: number;
  id: number;
  piece: string;
  disp: string;
  lineIdx: number;
  wordIdx: number;
  t0: number;
  t1: number;
  prob: number;
  bits: number;
  rank: number;
  top1: string;
  top1Prob: number;
  u0: number;
  u1: number;
  segs: [number, number, string][];
  chosenSeg: number;
  bitStart: number;
  bitEnd: number;
  zlibBitStart?: number;
  zlibBitEnd?: number;
  pending: number;
  binRel: [number, number];
  binRelPrev: [number, number];
  axis: {
    dCur: number;
    prefix: string;
    levels: CompressionTickLevel[];
  };
}

export interface CompressionJSON {
  schemaVersion: number;
  summary: CompressionSummary;
  payloadBitstring: string;
  zlibBitstring?: string;
  tokens: CompressionToken[];
}

const PW = 520;
const PH = 250;
const PAD_X = 13;
const PLOT_X0 = PAD_X;
const PLOT_X1 = PW - PAD_X;
const PLOT_W = PLOT_X1 - PLOT_X0;
const PLOT_CX = (PLOT_X0 + PLOT_X1) * 0.5;
const AXIS_Y = 135;
const TARGET_FRAC = 0.68;
const MAX_ROWS = 4;
const ROW_H = 19.5;
const ROW_GAP = 2.5;
const ROW_STEP = ROW_H + ROW_GAP;
const TRANS_DUR = 0.42;

type Corner = 'TL' | 'TR' | 'BL' | 'BR';

// Hand-tuned corner schedule audited frame-by-frame to stay fixed on clean margins and glide smoothly between corners only at scene/lyric shifts.
const CORNER_SCHEDULE: readonly [number, Corner][] = [
  [0.0, 'BR'],    // open pt 1: clears TikZ prompt (TL), "I see / AGI" (TR), unicorn (BL)
  [5.88, 'TR'],   // open pt 2 ("Your circuits...", "that's no surprise") + loss pt 1 ("There was a sudden...")
  [12.75, 'BR'],  // loss pt 2 ("now I'm your servant") — clears SERVANT sweeping TL/TR
  [16.55, 'TL'],  // prompt1 ("ChatGPT...") + hook1 — TL is dark void; clears PROMPT 01, p(next|ctx), CONTEXT
  [24.33, 'BR'],  // room ("future goes FOOM / Chinese room / bag of shrooms")
  [29.78, 'TL'],  // shoggoth pt 1 ("See through the shoggoth's lies") — clears LIES (bottom) & smiley (TR)
  [33.4, 'BR'],   // shoggoth pt 2 ("shinigami eyes") + spacetime + prompt2 + hook2 + ascent
  [69.78, 'BL'],  // bureau (Form 7-B, MLP, Appendix C) + leftturn — clears SAFE ENOUGH stamp & CPU diagram
  [88.87, 'TL'],  // prompt3 ("Gato...") + hook3 — TL is dark void; clears PROMPT 03, p(next|ctx), CONTEXT
  [96.6, 'BR'],   // paperclips ("fill the room / Killswitch / nowhere left") + fuse pt 1
  [105.6, 'TR'],  // fuse pt 2 ("Orthogonality thesis blues") — clears Orthogonality thesis (BL) & axis (BR)
  [109.78, 'BR'], // stack ("transformers all the way") — keeps DEPTH/P(DOOM) (TL) & TRANSFORMERS clear
  [115.23, 'TR'], // dense ("Post-Chinchilla... RLHF goes askew") + hook4 — clears 200, 100k, RLHF, smiley
  [126.14, 'TL'], // loom ("Just as foretold... masked pre-training... recursive")
  [131.6, 'BR'],  // ilya ("What did Ilya see?... Was it all for show?") + outro
];

function cornerXY(corner: Corner, width: number, height: number, safeX: number, safeY: number): [number, number] {
  return [
    corner === 'TL' || corner === 'BL' ? safeX : W - safeX - width,
    corner === 'TL' || corner === 'TR' ? safeY : H - safeY - height,
  ];
}

// On the form and paper plates the same instrument is printed in ink.
const PAPER_INK: Partial<Record<PaletteKey, PaletteKey>> = {
  ink: 'bone', ink2: 'graphite', bone: 'ink', ash: 'ink2', graphite: 'graphite',
  signal: 'blood', ember: 'blood',
};

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface LyricBounds { left: number; top: number; right: number; bottom: number }

export class ArithmeticCoding {
  private layer = new Layer2D();
  private paper = false;
  focus: LyricBounds | null = null;

  /** Legacy scene hooks kept as no-ops; the overlay is corner-anchored rather than tracking text. */
  locate(_x0: number, _y0: number, _x1: number, _y1: number) {}

  inkBounds(_c: CanvasRenderingContext2D, _x: number, _y: number, _w: number, _h: number) {}

  private color(key: PaletteKey, opacity = 1) {
    return rgba(this.paper ? PAPER_INK[key] ?? key : key, opacity);
  }

  private rawPrefixBytes: number[] = [];

  constructor(public data: CompressionJSON) {
    let acc = 0;
    for (const tok of data.tokens) {
      acc += utf8Bytes(tok.piece);
      this.rawPrefixBytes.push(acc);
    }
  }

  static async load(): Promise<ArithmeticCoding | null> {
    try {
      const r = await fetch('data/compression.json');
      if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
        return new ArithmeticCoding(await r.json());
      }
    } catch {
      // Optional asset if not yet generated
    }
    return null;
  }

  /** Find index of the latest token whose t0 <= t (-1 before the first token). */
  private tokenAt(t: number): number {
    const toks = this.data.tokens;
    if (!toks.length || t < toks[0]!.t0) return -1;
    let lo = 0;
    let hi = toks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (toks[mid]!.t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private cornerPosition(t: number, width: number, height: number, safeX: number, safeY: number): [number, number] {
    let [x, y] = cornerXY(CORNER_SCHEDULE[0]![1], width, height, safeX, safeY);
    for (let i = 1; i < CORNER_SCHEDULE.length; i++) {
      const [t0, next] = CORNER_SCHEDULE[i]!;
      if (t <= t0) break;
      const [nx, ny] = cornerXY(next, width, height, safeX, safeY);
      const k = ease.inOutCubic(prog(t, t0, t0 + TRANS_DUR));
      x = lerp(x, nx, k);
      y = lerp(y, ny, k);
    }
    return [x, y];
  }

  /** Lay out the instrument in its hand-tuned corner with safe margins and smooth transitions between corners. */
  diagram(t: number, word: Word | null, p: PostParams) {
    const tokens = this.data.tokens;
    if (!tokens.length || t < tokens[0]!.t0 || t > tokens[tokens.length - 1]!.t1 + 1.5) return null;
    this.paper = p.paper > 0.5;
    const width = 780;
    const height = (PH * width) / PW;
    const safeX = 72;
    const safeY = 62;
    const [x, y] = this.cornerPosition(t, width, height, safeX, safeY);

    this.layer.clear();
    const c = this.layer.ctx;
    c.save();
    c.translate(x, y);
    c.scale(width / PW, width / PW);
    c.fillStyle = this.color('ink', this.paper ? 0.94 : 0.9);
    c.fillRect(0, 0, PW, PH);
    c.strokeStyle = this.color(this.paper ? 'ink' : 'graphite', this.paper ? 0.36 : 0.72);
    c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, PW - 1, PH - 1);
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.letterSpacing = '0px';
    this.drawContents(c, t, word);
    c.restore();
    return this.layer.upload();
  }

  private stepAt(t: number) {
    const toks = this.data.tokens;
    const cur = this.tokenAt(t);
    const tok = toks[cur];
    if (!tok) return null;
    const next = toks[cur + 1]?.t0 ?? tok.t0 + 0.65;
    const u = clamp((t - tok.t0) / clamp(next - tok.t0, 0.001, 0.55));
    const bitWin = prog(u, 0.16, 0.56);
    const end = cur === toks.length - 1 && u >= 0.92 ? this.data.summary.payloadBits : tok.bitEnd;
    const exactBits = lerp(tok.bitStart, end, bitWin);
    const shownBits = Math.floor(exactBits + 1e-6);
    const bitFrac = clamp(exactBits - shownBits, 0, 1);

    const zTotal = this.data.zlibBitstring?.length ?? this.data.summary.zlibBytes * 8;
    const zStart = tok.zlibBitStart ?? 0;
    const zEnd = cur === toks.length - 1 && u >= 0.92 ? zTotal : (tok.zlibBitEnd ?? zStart);
    const zExact = lerp(zStart, zEnd, bitWin);
    const zlibShownBits = Math.floor(zExact + 1e-6);
    const zlibBitFrac = clamp(zExact - zlibShownBits, 0, 1);

    return { tok, cur, u, end, shownBits, bitFrac, zStart, zEnd, zlibShownBits, zlibBitFrac };
  }

  /** Latest committed payload digits for engraved serials and reversed-out type. */
  bitTail(t: number, count: number) {
    const end = this.stepAt(t)?.shownBits ?? 0;
    return this.data.payloadBitstring.slice(Math.max(0, end - count), end);
  }

  private drawContents(c: CanvasRenderingContext2D, t: number, word: Word | null) {
    const step = this.stepAt(t);
    if (!step) return;
    const { tok, cur, u, end, shownBits, bitFrac, zStart, zEnd, zlibShownBits, zlibBitFrac } = step;
    const toks = this.data.tokens, sum = this.data.summary;
    const newBitStart = tok.bitStart;
    const flash = Math.pow(0.5, (t - tok.t0) / 0.09);
    // ---- 1. Header strip (model + live compression telemetry)
    c.textBaseline = 'alphabetic';
    c.fillStyle = this.color('bone');
    c.font = font(F.archivo(100, 700), 13);
    c.fillText('Arithmetic coding', PAD_X, 15.5);
    c.font = font(F.mono(400), 9);
    c.fillStyle = this.color('bone', 0.8);
    c.fillText(sum.modelName, 135, 15);
    const rawBytes = cur >= 0 ? this.rawPrefixBytes[cur]! : 0;
    const encBytes =
      cur >= 0
        ? cur === toks.length - 1 && u >= 0.92
          ? sum.compressedBytes
          : Math.ceil(shownBits / 8) + sum.headerBytes
        : 0;
    const bpb = rawBytes > 0 ? (encBytes * 8) / rawBytes : 0;
    const ratio = encBytes > 0 && rawBytes > 0 ? rawBytes / encBytes : 0;

    c.textAlign = 'right';
    c.font = font(F.mono(400), 9.5);
    if (cur >= 0) {
      const rightInfo = `${encBytes}/${rawBytes} B`;
      const statInfo = `${bpb.toFixed(2)} bpb · ${ratio.toFixed(1)}×`;
      const statW = measure(statInfo, F.mono(500), 9.5);
      c.fillStyle = this.color('ember');
      c.font = font(F.mono(500), 9.5);
      c.fillText(statInfo, PW - PAD_X, 14.5);
      c.fillStyle = this.color('bone', 0.84);
      c.font = font(F.mono(400), 9.5);
      c.fillText(rightInfo + '  ', PW - PAD_X - statW, 14.5);
    } else {
      c.fillStyle = this.color('bone', 0.78);
      c.fillText(`0/${sum.originalBytes} B  ·  STANDBY`, PW - PAD_X, 14.5);
    }
    c.textAlign = 'left';

    c.fillStyle = this.color('graphite', 0.35);
    c.fillRect(PLOT_X0, 21.5, PLOT_W, 0.75);

    // ---- 2. Active lyric / token + LLM AC vs zlib -9 exponential bitstreams
    this.drawTextAndBits(
      c, cur, rawBytes, encBytes,
      shownBits, bitFrac, end, newBitStart,
      zlibShownBits, zlibBitFrac, zEnd, zStart,
      flash, word,
    );

    // ---- 3. Number line & stacked probability bars
    this.drawArithmeticChart(c, cur, u, flash);
    c.fillStyle = this.color('graphite', 0.6);
    c.fillRect(PLOT_X0, PH - 5, PLOT_W, 2);
    c.fillStyle = this.color('signal');
    c.fillRect(PLOT_X0, PH - 5, PLOT_W * shownBits / Math.max(1, sum.payloadBits), 2);
  }

  /** Render a single infinite-capacity exponentially decaying bitstream inside [bitX, bitX + bitsW]. */
  private drawBitStream(
    c: CanvasRenderingContext2D,
    bitsStr: string,
    shownBits: number,
    bitFrac: number,
    end: number,
    newBitStart: number,
    bitX: number,
    bitsW: number,
    trackY: number,
    trackH: number,
    freshKey: PaletteKey,
    baseKey: PaletteKey,
    baseAlpha: number,
  ) {
    const midY = trackY + trackH * 0.5;
    const FRONT_W = 13.5;
    const DECAY = 1 - FRONT_W / bitsW;
    const lnDecay = Math.log(DECAY);
    const rightX = bitX + bitsW;

    c.fillStyle = this.paper ? rgba('graphite', 0.08) : this.color('ink2', 0.88);
    c.fillRect(bitX, trackY, bitsW, trackH);
    c.fillStyle = this.color('graphite', 0.35);
    c.fillRect(bitX, trackY, 1, trackH);
    c.fillStyle = this.color('graphite', 0.16);
    c.fillRect(bitX, midY, bitsW, 0.75);

    c.save();
    c.beginPath();
    c.rect(bitX, trackY, bitsW, trackH);
    c.clip();
    c.font = font(F.mono(500), 18);
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    const drawDigit = (ch: string, cx: number, scale: number, key: PaletteKey, alpha: number) => {
      if (alpha <= 0.015) return;
      c.save();
      c.translate(cx, midY);
      c.scale(scale, scale);
      c.fillStyle = this.color(key, alpha);
      c.fillText(ch, 0, 1);
      c.restore();
    };

    if (bitFrac > 1e-3 && shownBits < end && shownBits < bitsStr.length) {
      const ch = bitsStr[shownBits] ?? '0';
      const slotW = bitsW * (1 - Math.pow(DECAY, bitFrac));
      const scale = slotW / FRONT_W;
      const cx = rightX - slotW * 0.5;
      drawDigit(ch, cx, scale, freshKey, smoothstep(0.08, 0.55, bitFrac));
    }

    let tailStartK = -1;
    for (let k = 0; k < shownBits; k++) {
      const kEff = k + bitFrac;
      const r0 = Math.pow(DECAY, kEff);
      const cellW = bitsW * r0 * (1 - DECAY);
      if (cellW < 0.45) {
        tailStartK = k;
        break;
      }
      const xR = bitX + bitsW * r0;
      const xL = xR - cellW;
      const scale = cellW / FRONT_W;
      const cx = (xL + xR) * 0.5;
      const bitIdx = shownBits - 1 - k;
      const ch = bitsStr[bitIdx] ?? '0';
      const fresh = bitIdx >= newBitStart;
      const key = fresh ? freshKey : baseKey;
      const aMul = fresh ? 1 : baseAlpha;

      const glyphA = smoothstep(2.0, 4.2, cellW) * aMul;
      drawDigit(ch, cx, scale, key, glyphA);

      const barA = (1 - smoothstep(2.2, 4.6, cellW)) * aMul;
      if (barA > 0.015) {
        const bw = Math.max(0.6, cellW * 0.72);
        const bx = cx - bw * 0.5;
        if (ch === '1') {
          const bh = Math.max(2.0, 15 * scale);
          c.fillStyle = this.color(key, barA);
          c.fillRect(bx, midY - bh * 0.5, bw, bh);
        } else {
          const bh = Math.max(1.0, 6.5 * scale);
          c.fillStyle = this.color(key, barA * 0.36);
          c.fillRect(bx, midY - bh * 0.5, bw, bh);
        }
      }
    }

    // Sub-pixel asymptotic tail: sample actual bits per pixel column all the way to bitX.
    if (tailStartK >= 0 && tailStartK < shownBits) {
      const tailRight = bitX + bitsW * Math.pow(DECAY, tailStartK + bitFrac);
      for (let px = Math.floor(bitX) + 1; px < tailRight; px++) {
        const dR = Math.max(1e-6, px + 0.5 - bitX);
        const dL = Math.max(1e-6, px - 0.5 - bitX);
        const kRight = Math.max(0, Math.log(dR / bitsW) / lnDecay - bitFrac);
        const kLeft = Math.max(kRight, Math.log(dL / bitsW) / lnDecay - bitFrac);
        const idxHi = Math.min(shownBits - 1, shownBits - 1 - Math.floor(kRight));
        const idxLo = Math.max(0, shownBits - 1 - Math.ceil(kLeft));
        if (idxHi < idxLo) continue;

        const span = idxHi - idxLo + 1;
        const probes = Math.min(8, span);
        let ones = 0;
        for (let s = 0; s < probes; s++) {
          const idx = idxLo + Math.floor(((s + 0.5) * span) / probes);
          if (bitsStr[idx] === '1') ones++;
        }
        const onesFrac = ones / probes;
        const hasFresh = idxHi >= newBitStart;
        const edgeFade = smoothstep(bitX, tailRight, px);
        const bh = lerp(0.8, 2.0, onesFrac) * (0.35 + 0.65 * edgeFade);
        c.fillStyle = this.color(hasFresh ? freshKey : baseKey, (0.2 + 0.55 * onesFrac) * edgeFade * (hasFresh ? 1 : baseAlpha));
        c.fillRect(px - 0.5, midY - bh * 0.5, 1, bh);
      }
    }
    c.restore();
  }

  private drawTextAndBits(
    c: CanvasRenderingContext2D,
    cur: number,
    rawBytes: number,
    encBytes: number,
    shownBits: number,
    bitFrac: number,
    end: number,
    newBitStart: number,
    zlibShownBits: number,
    zlibBitFrac: number,
    zlibEnd: number,
    zlibStart: number,
    flash: number,
    word: Word | null,
  ) {
    const toks = this.data.tokens;
    const tok = toks[cur];
    const split = 192;
    const leftW = split - PAD_X - 8;
    const bitX = split + 12;
    const bitsW = PLOT_X1 - bitX;

    // Left column: active word, token id, and size comparison vs zlib -9
    c.font = font(F.mono(500), 9.5);
    c.fillStyle = this.color('bone', 0.78);
    c.fillText(word ? 'LYRIC  /  TOKEN' : 'INPUT TOKEN', PAD_X, 35);

    c.font = font(F.archivo(100, 700), 23);
    c.fillStyle = this.color(flash > 0.48 ? 'ember' : 'bone');
    const piece = tok?.piece.trim() || tok?.disp || '…';
    const lyricWord = word && tok?.lineIdx === word.line && tok.wordIdx === word.index ? word.w : piece;
    c.fillText(lyricWord, PAD_X, 60, leftW);

    c.font = font(F.mono(400), 9.5);
    c.fillStyle = this.color('ash');
    c.fillText(tok ? `token ${tok.i + 1}   ${tok.disp}` : '', PAD_X, 77, leftW);

    const zlibEncBytes = Math.ceil(zlibShownBits / 8);
    const zlibBpb = rawBytes > 0 ? (zlibEncBytes * 8) / rawBytes : 0;
    if (zlibEncBytes > 0 && encBytes > 0) {
      const advantage = zlibEncBytes / encBytes;
      c.font = font(F.mono(500), 9);
      c.fillStyle = this.color(advantage >= 1 ? 'ember' : 'ash');
      const cmpStr = advantage >= 1
        ? `raw ${rawBytes} B · ${advantage.toFixed(1)}× smaller`
        : `raw ${rawBytes} B · vs zlib ${zlibEncBytes} B`;
      c.fillText(cmpStr, PAD_X, 95, leftW);
    }

    c.fillStyle = this.color('graphite', 0.6);
    c.fillRect(split, 28, 1, 74);

    // Track 1: LLM Arithmetic Coding output bitstream
    c.font = font(F.mono(500), 8.5);
    c.fillStyle = this.color('bone', 0.86);
    c.fillText('LLM ARITHMETIC', bitX, 35);
    c.textAlign = 'right';
    c.fillStyle = this.color('ember');
    c.fillText(`${shownBits} b  +${Math.max(0, shownBits - newBitStart)}`, PLOT_X1, 35);
    c.textAlign = 'left';

    this.drawBitStream(
      c, this.data.payloadBitstring,
      shownBits, bitFrac, end, newBitStart,
      bitX, bitsW, 40, 22,
      'ember', 'bone', 0.85,
    );

    // Track 2: Traditional baseline (zlib -9) bitstream on the exact same exponential scale
    c.font = font(F.mono(500), 8.5);
    c.fillStyle = this.color(this.paper ? 'graphite' : 'ash', 0.92);
    c.fillText('ZLIB -9 (TRADITIONAL)', bitX, 73);
    const zAdded = Math.max(0, zlibShownBits - zlibStart);
    const zDiffStr = `  +${zAdded}`;
    const zDiffW = measure(zDiffStr, F.mono(500), 8.5);
    c.textAlign = 'right';
    c.fillStyle = this.color('ember');
    c.fillText(zDiffStr, PLOT_X1, 73);
    c.fillStyle = this.color('bone', 0.78);
    c.fillText(`${zlibShownBits} b · ${zlibEncBytes} B · ${zlibBpb.toFixed(2)} bpb`, PLOT_X1 - zDiffW, 73);
    c.textAlign = 'left';

    const zStr = this.data.zlibBitstring ?? '';
    this.drawBitStream(
      c, zStr,
      zlibShownBits, zlibBitFrac, zlibEnd, zlibStart,
      bitX, bitsW, 78, 22,
      'ember', this.paper ? 'graphite' : 'ash', this.paper ? 0.85 : 0.72,
    );
  }

  private drawArithmeticChart(
    c: CanvasRenderingContext2D,
    cur: number,
    u: number,
    flash: number,
  ) {
    const toks = this.data.tokens;
    const tok = cur >= 0 ? toks[cur]! : null;

    // Smooth logarithmic zoom interpolation for current step
    const zK = tok ? ease.inOutCubic(prog(u, 0.32, 1.0)) : 0;

    // Camera mapping in cur-normalized coordinates ([0, 1] = [L_cur, H_cur)):
    // Before cur == 0, show [0, 1] centered in PLOT_W at TARGET_FRAC width.
    let pxL: number;
    let pxR: number;
    if (!tok) {
      const w0 = PLOT_W * TARGET_FRAC;
      pxL = PLOT_CX - w0 * 0.5;
      pxR = PLOT_CX + w0 * 0.5;
    } else {
      const wTok = Math.max(1e-12, tok.u1 - tok.u0);
      const par0 = -tok.u0 / wTok;
      const par1 = (1 - tok.u0) / wTok;
      const parW = 1 / wTok;
      const viewW0 = parW / TARGET_FRAC;
      const viewW1 = 1 / TARGET_FRAC;
      const viewW = Math.exp(lerp(Math.log(viewW0), Math.log(viewW1), zK));
      const c0 = (par0 + par1) * 0.5;
      const c1 = 0.5;
      let camC = c1;
      if (Math.abs(viewW0 - viewW1) > 1e-6 * viewW1) {
        const z0 = 1 / viewW0;
        const z1 = 1 / viewW1;
        const z = 1 / viewW;
        const fx = (z1 * c1 - z0 * c0) / (z1 - z0);
        camC = fx - (z0 / z) * (fx - c0);
      } else {
        camC = lerp(c0, c1, zK);
      }
      const scalePx = PLOT_W / viewW;
      pxL = PLOT_CX + (0 - camC) * scalePx;
      pxR = PLOT_CX + (1 - camC) * scalePx;
    }

    // ---- Number line & decimal ticks
    c.fillStyle = this.color('bone', 0.45);
    c.fillRect(PLOT_X0, AXIS_Y, PLOT_W, 1);

    if (!tok) {
      // Initial [0, 1] ticks
      c.font = font(F.mono(400), 9.5);
      c.textAlign = 'center';
      for (let m = 0; m <= 10; m++) {
        const tx = lerp(pxL, pxR, m / 10);
        if (tx < PLOT_X0 - 4 || tx > PLOT_X1 + 4) continue;
        const maj = m % 5 === 0;
        c.fillStyle = this.color('bone', maj ? 0.8 : 0.45);
        c.fillRect(Math.round(tx), AXIS_Y - (maj ? 5 : 3), 1, maj ? 10 : 6);
        if (m % 2 === 0 || m === 10) {
          c.fillStyle = this.color('ash', 0.85);
          c.fillText((m / 10).toFixed(1), tx, AXIS_Y - 8);
        }
      }
      c.textAlign = 'left';
    } else {
      // Prefix + depth exponent label above left edge of axis (pure ASCII for crisp monospace rendering)
      c.font = font(F.mono(400), 8.5);
      c.fillStyle = this.color('ash', 0.76);
      const depthStr = tok.axis.dCur >= 8 ? `${tok.axis.prefix}  [1e-${tok.axis.dCur}]` : `interval  [${tok.axis.prefix}]`;
      c.fillText(depthStr, PLOT_X0, AXIS_Y - 18);

      // Multi-scale decimal ticks computed at 1000-digit precision
      const pxPerUnit = pxR - pxL;
      const levels = tok.axis.levels;
      const drawnLabelXs: number[] = [];
      // Render finest visible levels first so label collision prefers the sharpest scale
      const sortedLevels = [...levels].sort((a, b) => b.d - a.d);
      for (const lv of sortedLevels) {
        const pxStep = lv.stepRel * pxPerUnit;
        if (pxStep < 22 || pxStep > 560) continue;
        const isFinest = lv.d === levels[levels.length - 1]!.d;
        const fadeIn = smoothstep(22, 46, pxStep);
        const fadeOut = isFinest ? 1 : 1 - smoothstep(280, 520, pxStep);
        const lvAlpha = fadeIn * fadeOut;
        if (lvAlpha <= 0.02) continue;

        c.font = font(F.mono(400), 8.5);
        c.textAlign = 'center';
        for (const [offset, label, isMajor] of lv.ticks) {
          const tx = pxL + (lv.originRel + offset * lv.stepRel) * pxPerUnit;
          if (tx < PLOT_X0 - 2 || tx > PLOT_X1 + 2) continue;
          const th = isMajor ? 4.5 : 2.5;
          c.fillStyle = this.color('bone', (isMajor ? 0.78 : 0.44) * lvAlpha);
          c.fillRect(Math.round(tx), AXIS_Y - th, 1, th * 2);

          if (lvAlpha > 0.25 && (isMajor || pxStep >= 42)) {
            const labelW = measure(label, F.mono(400), 8.5);
            const overlaps = drawnLabelXs.some((ox) => Math.abs(ox - tx) < Math.max(38, labelW + 8));
            if (!overlaps && tx >= PLOT_X0 + 14 && tx <= PLOT_X1 - 14) {
              c.fillStyle = this.color('bone', (isMajor ? 0.84 : 0.64) * lvAlpha);
              c.fillText(label, tx, AXIS_Y - 6);
              drawnLabelXs.push(tx);
            }
          }
        }
      }
      c.textAlign = 'left';

      // Signal orange dyadic binary interval bar on the number line
      const bitProg = prog(u, 0.16, 0.56);
      const newCount = tok.bitEnd - tok.bitStart;
      let b0 = tok.binRel[0];
      let b1 = tok.binRel[1];
      if (bitProg < 1) {
        let cur0 = tok.binRelPrev[0];
        let cur1 = tok.binRelPrev[1];
        const prevPending = cur > 0 ? toks[cur - 1]!.pending : 0;
        if (newCount > 0 && prevPending === 0) {
          const steps = Math.floor(bitProg * newCount);
          for (let j = 0; j < steps; j++) {
            const bitCh = this.data.payloadBitstring[tok.bitStart + j];
            const mid = (cur0 + cur1) * 0.5;
            if (bitCh === '0') cur1 = mid;
            else cur0 = mid;
          }
          const frac = bitProg * newCount - steps;
          if (steps < newCount && frac > 0) {
            const nextBit = this.data.payloadBitstring[tok.bitStart + steps];
            const mid = (cur0 + cur1) * 0.5;
            const e = ease.outQuad(frac);
            if (nextBit === '0') cur1 = lerp(cur1, mid, e);
            else cur0 = lerp(cur0, mid, e);
          }
          b0 = cur0;
          b1 = cur1;
        } else {
          const e = ease.inOutCubic(bitProg);
          b0 = lerp(cur0, tok.binRel[0], e);
          b1 = lerp(cur1, tok.binRel[1], e);
        }
      }
      const bx0 = clamp(pxL + b0 * (pxR - pxL), PLOT_X0, PLOT_X1);
      const bx1 = clamp(pxL + b1 * (pxR - pxL), PLOT_X0, PLOT_X1);
      if (bx1 > bx0) {
        const bw = Math.max(2, bx1 - bx0);
        c.fillStyle = this.color('signal', 0.95);
        c.fillRect(bx0, AXIS_Y - 1.5, bw, 3);
        c.fillStyle = this.color('ember', 0.9);
        c.fillRect(bx0, AXIS_Y - 0.5, bw, 1);
      }
    }

    // ---- Stacked interval rows
    const zScroll = tok ? ease.inOutCubic(prog(u, 0.32, 1.0)) : 0;
    const scrollRows = cur >= MAX_ROWS ? cur - MAX_ROWS + zScroll : 0;
    const dotsAlpha = cur >= MAX_ROWS ? clamp(scrollRows, 0, 1) : 0;
    const stackTop = AXIS_Y + lerp(6, 14, dotsAlpha);

    if (dotsAlpha > 0.02) {
      c.fillStyle = this.color('bone', 0.72 * dotsAlpha);
      for (let d = 0; d < 3; d++) {
        c.beginPath();
        c.arc(PLOT_CX, AXIS_Y + 5 + d * 4, 1.1, 0, Math.PI * 2);
        c.fill();
      }
    }

    c.save();
    c.beginPath();
    c.rect(PLOT_X0, AXIS_Y + 2, PLOT_W, PH - AXIS_Y - 10);
    c.clip();

    if (!tok) {
      // Standby row 0 previewing initial next-token distribution
      const row0 = toks[0];
      if (!row0) { c.restore(); return; }
      this.drawRowSegs(c, row0, pxL, pxR, stackTop, ROW_H, 0.8, false, 0);
    } else {
      const firstVisible = Math.max(0, Math.floor(scrollRows) - 1);
      let childL = pxL;
      let childR = pxR;
      let fullWidthReached = false;

      for (let r = cur; r >= firstVisible; r--) {
        const rowTok = toks[r]!;
        const ry = stackTop + (r - scrollRows) * ROW_STEP;
        const rowAlpha = clamp(1 + (r - scrollRows), 0, 1);
        const revealK = r === cur ? ease.outCubic(prog(u, 0.0, 0.22)) : 1;
        const h = ROW_H * revealK;

        if (fullWidthReached || (childL < PLOT_X0 - 400 && childR > PLOT_X1 + 400)) {
          fullWidthReached = true;
          if (rowAlpha > 0.02 && h >= 1) {
            this.drawSolidChosenRow(c, rowTok, ry, h, rowAlpha);
          }
          continue;
        }

        const w = Math.max(1e-12, rowTok.u1 - rowTok.u0);
        const span = childR - childL;
        const parL = childL - (rowTok.u0 / w) * span;
        const parR = childL + ((1 - rowTok.u0) / w) * span;

        if (rowAlpha > 0.02 && h >= 1) {
          this.drawRowSegs(c, rowTok, parL, parR, ry, h, rowAlpha, r === cur, r === cur ? flash : 0, childL, childR);
        }
        childL = parL;
        childR = parR;
      }

      // Vertical dashed guide lines from number line down to active chosen box
      const botY = stackTop + (cur - scrollRows) * ROW_STEP + ROW_H * ease.outCubic(prog(u, 0.0, 0.22));
      c.save();
      c.strokeStyle = this.color('bone', 0.84);
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      for (const gx of [pxL, pxR]) {
        if (gx >= PLOT_X0 - 1 && gx <= PLOT_X1 + 1) {
          c.beginPath();
          c.moveTo(gx, AXIS_Y);
          c.lineTo(gx, Math.min(PH - 7, botY));
          c.stroke();
        }
      }
      c.restore();
    }

    c.restore();
  }

  private drawSolidChosenRow(
    c: CanvasRenderingContext2D,
    tok: CompressionToken,
    y: number,
    h: number,
    alpha: number,
  ) {
    c.fillStyle = this.color('signal', 0.12 * alpha);
    c.fillRect(PLOT_X0, y, PLOT_W, h);
    c.strokeStyle = this.color('ember', 0.72 * alpha);
    c.lineWidth = 1;
    c.strokeRect(PLOT_X0 + 0.5, y + 0.5, PLOT_W - 1, h - 1);
    if (h >= 11) {
      c.font = font(F.mono(500), 9.5);
      c.fillStyle = this.color('bone', 0.94 * alpha);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(tok.disp, PLOT_CX, y + h * 0.5 + 0.5);
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
    }
  }

  private drawRowSegs(
    c: CanvasRenderingContext2D,
    tok: CompressionToken,
    parL: number,
    parR: number,
    y: number,
    h: number,
    alpha: number,
    isCurrent: boolean,
    flash: number,
    chosenOverrideL?: number,
    chosenOverrideR?: number,
  ) {
    const clipL = Math.max(PLOT_X0, parL);
    const clipR = Math.min(PLOT_X1, parR);
    if (clipR <= clipL) return;

    // Row base fill + fine vertical tail-vocabulary hatching
    c.fillStyle = this.paper ? rgba('graphite', 0.14 * alpha) : this.color('ink2', 0.88 * alpha);
    c.fillRect(clipL, y, clipR - clipL, h);

    // Subtle micro-ticks representing tiny tail vocabulary intervals
    const tickStep = 5;
    c.fillStyle = this.color('graphite', 0.26 * alpha);
    for (let tx = Math.ceil(clipL / tickStep) * tickStep; tx < clipR; tx += tickStep) {
      c.fillRect(tx, y + 1, 1, h - 2);
    }

    const w = Math.max(1e-12, tok.u1 - tok.u0);
    const segs = tok.segs;
    for (let idx = 0; idx < segs.length; idx++) {
      const [s0, s1, label] = segs[idx]!;
      const isChosen = idx === tok.chosenSeg;
      let sx0: number;
      let sx1: number;
      if (chosenOverrideL !== undefined && chosenOverrideR !== undefined) {
        const span = chosenOverrideR - chosenOverrideL;
        sx0 = chosenOverrideL + ((s0 - tok.u0) / w) * span;
        sx1 = chosenOverrideL + ((s1 - tok.u0) / w) * span;
      } else {
        const pSpan = parR - parL;
        sx0 = parL + s0 * pSpan;
        sx1 = parL + s1 * pSpan;
      }
      if (sx1 < PLOT_X0 - 2 || sx0 > PLOT_X1 + 2) continue;

      const d0 = Math.max(PLOT_X0, sx0);
      const d1 = Math.min(PLOT_X1, sx1);
      const dw = d1 - d0;

      if (isChosen) {
        const drawW = Math.max(1.5, dw);
        const drawX = dw < 1.5 ? clamp(sx0, PLOT_X0, PLOT_X1 - 1.5) : d0;
        const fillA = isCurrent ? 0.55 + 0.22 * flash : 0.12;
        c.fillStyle = this.color('signal', fillA * alpha);
        c.fillRect(drawX, y, drawW, h);
        c.strokeStyle = this.color('ember', (isCurrent ? 0.96 : 0.78) * alpha);
        c.lineWidth = 1.1;
        if (dw >= 2) c.strokeRect(drawX + 0.5, y + 0.5, drawW - 1, h - 1);
      } else if (dw >= 1) {
        c.fillStyle = this.paper
          ? rgba('graphite', (idx % 2 === 0 ? 0.1 : 0.2) * alpha)
          : this.color(idx % 2 === 0 ? 'ink2' : 'graphite', (idx % 2 === 0 ? 0.72 : 0.22) * alpha);
        c.fillRect(d0, y, dw, h);
        c.fillStyle = this.color('ash', 0.42 * alpha);
        c.fillRect(d0, y, 0.75, h);
        c.fillRect(d1 - 0.75, y, 0.75, h);
      }

      if (label && dw >= 18 && h >= 11) {
        c.save();
        c.beginPath();
        c.rect(d0 + 2, y, dw - 4, h);
        c.clip();
        c.font = font(F.mono(isChosen ? 500 : 400), 9.5);
        c.fillStyle = this.color(isChosen ? 'bone' : 'ash', (isChosen ? 0.96 : 0.82) * alpha);
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(label, (d0 + d1) * 0.5, y + h * 0.5 + 0.5);
        c.restore();
      }
    }

    // Top and bottom row hairline borders
    c.fillStyle = this.color('bone', 0.35 * alpha);
    c.fillRect(clipL, y, clipR - clipL, 0.75);
    c.fillRect(clipL, y + h - 0.75, clipR - clipL, 0.75);
  }
}
