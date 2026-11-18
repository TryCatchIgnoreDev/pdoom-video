"""Compress the P(doom) lyrics with Qwen3.5-9B-Base using llm-compressor's exact arithmetic coding.

Produces:
  - data/lyrics.llmc       Lossless compressed binary (verified round-trip via decompress_bytes)
  - data/compression.json  Per-token CDF intervals, arithmetic-coding bit prefix trace,
                           exact high-precision decimal zoom tick levels, and word-synced timestamps.
"""

from __future__ import annotations

import argparse
from decimal import Decimal, getcontext
import hashlib
import json
import math
from pathlib import Path
import sys
import zlib

import numpy as np

getcontext().prec = 1000

DEFAULT_MODEL = (
    Path.home()
    / ".lmstudio"
    / "models"
    / "mradermacher"
    / "Qwen3.5-9B-Base-GGUF"
    / "Qwen3.5-9B-Base.Q4_K_S.gguf"
)
DEFAULT_LLM_COMPRESSOR = Path.home() / "llm-compressor"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
LYRICS_JSON = PROJECT_ROOT / "data" / "lyrics.json"
OUT_LLMC = PROJECT_ROOT / "data" / "lyrics.llmc"
OUT_JSON = PROJECT_ROOT / "data" / "compression.json"


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def format_token_disp(piece: str) -> str:
    """Format a BPE piece for compact display inside probability interval boxes."""
    if piece == "\n":
        return "\\n"
    if piece == "\t":
        return "\\t"
    s = piece.replace("\n", "\\n").replace("\t", "\\t")
    if s.startswith(" "):
        s = "_" + s[1:]
    return s


def build_char_timeline(lines: list[dict]) -> tuple[str, list[dict]]:
    """Build exact full_text and per-character vocal metadata aligned to data/lyrics.json."""
    parts: list[str] = []
    char_meta: list[dict] = []

    for li, line in enumerate(lines):
        if li > 0:
            prev_end = float(lines[li - 1]["end"])
            next_start = float(line["start"])
            gap = next_start - prev_end
            if gap > 0.05:
                nl_t0 = prev_end + min(0.06, gap * 0.2)
                nl_t1 = prev_end + min(0.24, gap * 0.65)
            else:
                nl_t0 = max(0.0, prev_end - 0.03)
                nl_t1 = prev_end
            parts.append("\n")
            char_meta.append(
                {
                    "lineIdx": li - 1,
                    "wordIdx": -1,
                    "kind": "nl",
                    "t0": nl_t0,
                    "t1": max(nl_t0 + 0.02, nl_t1),
                }
            )

        words = line["words"]
        for wi, w in enumerate(words):
            if wi > 0:
                prev_w = words[wi - 1]
                parts.append(" ")
                char_meta.append(
                    {
                        "lineIdx": li,
                        "wordIdx": wi,
                        "kind": "space",
                        "t0": float(w["start"]),
                        "t1": float(w["start"]),
                    }
                )
            word_str = str(w["w"])
            ws = float(w["start"])
            we = float(w["end"])
            n = max(1, len(word_str))
            parts.append(word_str)
            for ci in range(len(word_str)):
                char_meta.append(
                    {
                        "lineIdx": li,
                        "wordIdx": wi,
                        "kind": "char",
                        "t0": lerp(ws, we, ci / n),
                        "t1": lerp(ws, we, (ci + 1) / n),
                    }
                )

    full_text = "".join(parts)
    assert len(full_text) == len(char_meta)
    return full_text, char_meta


def assign_token_times(pieces: list[str], full_text: str, char_meta: list[dict]) -> list[dict]:
    """Map each token piece sequentially to its character span and monotonic vocal timestamp."""
    cursor = 0
    raw_spans: list[dict] = []
    for i, piece in enumerate(pieces):
        n = len(piece)
        assert full_text[cursor : cursor + n] == piece, f"Token {i} mismatch at {cursor}"
        span_meta = char_meta[cursor : cursor + n]
        non_space = [m for m in span_meta if m["kind"] != "space"]
        primary = non_space if non_space else span_meta
        t0 = float(primary[0]["t0"])
        t1 = float(primary[-1]["t1"])
        line_idx = int(primary[0]["lineIdx"])
        word_idx = int(primary[0]["wordIdx"])
        raw_spans.append(
            {
                "charStart": cursor,
                "charEnd": cursor + n,
                "lineIdx": line_idx,
                "wordIdx": word_idx,
                "t0": t0,
                "t1": max(t0 + 0.03, t1),
                "isNewline": piece == "\n",
            }
        )
        cursor += n
    assert cursor == len(full_text)

    # Ensure strictly monotonic t0 so fast multi-token words still trigger sequentially.
    for i in range(1, len(raw_spans)):
        if raw_spans[i]["t0"] <= raw_spans[i - 1]["t0"] + 0.025:
            raw_spans[i]["t0"] = raw_spans[i - 1]["t0"] + 0.03
            if raw_spans[i]["t1"] <= raw_spans[i]["t0"] + 0.03:
                raw_spans[i]["t1"] = raw_spans[i]["t0"] + 0.04
    return raw_spans


def decimal_prefix_and_ticks(
    L_prev: Decimal,
    H_prev: Decimal,
    L_cur: Decimal,
    H_cur: Decimal,
) -> dict:
    """Compute exact multi-scale decimal tick grids relative to [L_cur, H_cur) at 1000-digit precision."""
    W_prev = H_prev - L_prev
    W_cur = H_cur - L_cur
    C_prev = (L_prev + H_prev) / Decimal(2)
    C_cur = (L_cur + H_cur) / Decimal(2)

    # Number of decimal places where 10^-d is roughly 0.05..0.5 of interval width.
    d_prev = max(1, math.floor(-math.log10(float(W_prev))) if W_prev > Decimal("1e-300") else math.ceil(-float(W_prev.ln() / Decimal(10).ln())))
    d_cur = max(1, math.ceil(-float(W_cur.ln() / Decimal(10).ln())) + 1)

    # Restrict exponent range to cover smooth exponential zoom from W_prev to W_cur.
    d_min = max(1, d_prev - 1)
    d_max = max(d_min, d_cur)

    # Format a scaled integer m (representing m * 10^-d) accurately.
    def fmt_tick(m: int, d: int) -> str:
        if m == 0:
            return "0.0"
        if m == 10**d:
            return "1.0"
        s = str(m).rjust(d + 1, "0")
        whole = s[: len(s) - d]
        raw_frac = s[len(s) - d :]
        if d <= 7:
            frac = raw_frac.rstrip("0") or "0"
            return f"{whole}.{frac}"
        return f"…{raw_frac[-4:]}"

    # Also compute a clean human-readable prefix string at the finest scale d_cur
    mid_scaled = int((C_cur * (Decimal(10) ** d_cur)).to_integral_value())
    mid_str = str(max(0, mid_scaled)).rjust(d_cur + 1, "0")
    mid_frac = mid_str[len(mid_str) - d_cur :]
    if d_cur <= 9:
        prefix_str = f"0.{mid_frac}"
    else:
        prefix_str = f"0.{mid_frac[:4]}…{mid_frac[-5:]}"

    levels = []
    for d in range(d_min, d_max + 1):
        step = Decimal(10) ** (-d)
        step_rel = float(step / W_cur)
        # Estimate camera window along zoom path where this tick spacing is visible
        # (camW roughly in [1.4 * step, 22 * step]).
        w_lo = max(W_cur, step * Decimal("1.1"))
        w_hi = min(W_prev * Decimal("1.6"), step * Decimal("22"))
        if w_lo > w_hi:
            # Always keep finest scale and coarsest scale covered
            if d not in (d_min, d_cur):
                continue
            w_lo = W_cur
            w_hi = W_prev * Decimal("1.6")

        # Linearly/log interpolate camera center between C_prev and C_cur at both ends
        log_tot = float((W_prev / W_cur).ln()) if W_prev > W_cur else 0.0
        centers = []
        for w_cam in (w_lo, w_hi):
            if log_tot > 1e-9:
                alpha = max(0.0, min(1.0, float((W_prev / w_cam).ln()) / log_tot))
            else:
                alpha = 1.0
            c_est = C_prev + (C_cur - C_prev) * Decimal(str(alpha))
            centers.append((c_est - w_cam * Decimal("0.9"), c_est + w_cam * Decimal("0.9")))

        v_lo = max(Decimal(0), min(c[0] for c in centers))
        v_hi = min(Decimal(1), max(c[1] for c in centers))
        m0 = max(0, int((v_lo / step).to_integral_value()) - 1)
        m1 = min(10**d, int((v_hi / step).to_integral_value()) + 1)
        if m1 - m0 > 28:
            # Cap around C_cur to keep JSON compact
            mc = int((C_cur / step).to_integral_value())
            m0 = max(0, mc - 14)
            m1 = min(10**d, mc + 14)

        origin_rel = float((Decimal(m0) * step - L_cur) / W_cur)
        ticks = [[m - m0, fmt_tick(m, d), m % 5 == 0] for m in range(m0, m1 + 1)]
        levels.append(
            {
                "d": d,
                "originRel": origin_rel,
                "stepRel": step_rel,
                "ticks": ticks,
            }
        )

    return {
        "dCur": d_cur,
        "prefix": prefix_str,
        "levels": levels,
    }


def select_row_segments(
    comp,
    cdf: np.ndarray,
    chosen_id: int,
    total_freq: int,
    label_cache: dict[int, str],
) -> tuple[list[list], int]:
    """Select global top-K and local neighborhood segments around chosen_id in token_id order."""
    freqs = np.diff(cdf)
    vocab_size = len(freqs)

    # Top global candidates so zoomed-out view shows wide bars.
    top_k = min(44, vocab_size)
    top_ids = np.argpartition(freqs, -top_k)[-top_k:]

    # Local neighborhood around chosen_id so zoomed-in view always shows real adjacent boxes.
    lo_id = max(0, chosen_id - 180)
    hi_id = min(vocab_size, chosen_id + 181)
    local_freqs = freqs[lo_id:hi_id]
    local_top_k = min(20, len(local_freqs))
    local_top = lo_id + np.argpartition(local_freqs, -local_top_k)[-local_top_k:]

    # Immediate adjacent token IDs so borders directly next to chosen_id exist.
    adj = np.arange(max(0, chosen_id - 5), min(vocab_size, chosen_id + 6), dtype=np.int64)

    keep_ids = np.unique(np.concatenate([top_ids, local_top, adj, np.array([chosen_id], dtype=np.int64)]))
    keep_ids.sort()

    def get_label(tid: int) -> str:
        lbl = label_cache.get(tid)
        if lbl is None:
            raw = comp.token_piece_display(tid)
            lbl = format_token_disp(raw)
            if len(label_cache) < 16384:
                label_cache[tid] = lbl
        return lbl

    segs: list[list] = []
    chosen_seg_idx = 0
    for idx, tid_np in enumerate(keep_ids):
        tid = int(tid_np)
        u0 = int(cdf[tid]) / total_freq
        u1 = int(cdf[tid + 1]) / total_freq
        if tid == chosen_id:
            chosen_seg_idx = idx
        # Only serialize text labels for wide-enough or chosen/adjacent tokens.
        is_adj = abs(tid - chosen_id) <= 4
        lbl = get_label(tid) if (tid == chosen_id or is_adj or (u1 - u0) >= 0.002) else ""
        segs.append([u0, u1, lbl])

    return segs, chosen_seg_idx


def main() -> int:
    parser = argparse.ArgumentParser(description="Compress pdoom-video lyrics with Qwen3.5-9B-Base.")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--llm-compressor", type=Path, default=DEFAULT_LLM_COMPRESSOR)
    parser.add_argument("--lyrics", type=Path, default=LYRICS_JSON)
    parser.add_argument("--out-llmc", type=Path, default=OUT_LLMC)
    parser.add_argument("--out-json", type=Path, default=OUT_JSON)
    args = parser.parse_args()

    sys.path.insert(0, str(args.llm_compressor.resolve()))
    from arithmetic_coder import (  # noqa: E402
        ArithmeticEncoder,
        BitOutputStream,
        DEFAULT_CDF_BITS,
        FULL_RANGE,
        logits_to_cdf,
    )
    from compressor import LLMCompressor  # noqa: E402

    lyrics_data = json.loads(args.lyrics.read_text(encoding="utf-8"))
    lines = lyrics_data["lines"]
    full_text, char_meta = build_char_timeline(lines)
    raw_bytes = full_text.encode("utf-8")
    zlib_blob = zlib.compress(raw_bytes, level=9)
    zlib_bytes = len(zlib_blob)
    zlib_bitstring = "".join(f"{b:08b}" for b in zlib_blob)

    with LLMCompressor(
        args.model,
        n_ctx=2048,
        n_gpu_layers=-1,
        fast_cdf=False,
        streams=1,
    ) as comp:
        # 1) Standard llm-compressor round-trip verification & binary export
        blob, stats = comp.compress_bytes(full_text, collect_trace=True)
        restored, dec_stats = comp.decompress_bytes(blob)
        assert restored == full_text, "Lossless decompression mismatch!"
        assert hashlib.sha256(restored.encode("utf-8")).hexdigest() == hashlib.sha256(raw_bytes).hexdigest()

        args.out_llmc.parent.mkdir(parents=True, exist_ok=True)
        args.out_llmc.write_bytes(blob)

        # 2) Detailed CDF + arithmetic coder interval trace for visualization
        tokens = comp.tokenize(raw_bytes)
        pieces = [comp.detokenize_bytes([tid]).decode("utf-8") for tid in tokens]
        assert "".join(pieces) == full_text
        spans = assign_token_times(pieces, full_text, char_meta)

        total_freq = 1 << DEFAULT_CDF_BITS
        comp._ensure_context(required_streams=1, total_n_ctx=comp.n_ctx)
        comp._prime_bos_streams(1)
        histories: list[list[int]] = [[]]
        stream_pos = 1

        bits_trace: list[int] = []

        class TrackBitOut(BitOutputStream):
            def write_bit(self, bit: int) -> None:
                bits_trace.append(bit & 1)
                super().write_bit(bit)

        bit_out = TrackBitOut()
        enc = ArithmeticEncoder(bit_out)
        label_cache: dict[int, str] = {}

        L_prev = Decimal(0)
        H_prev = Decimal(1)
        B0_prev = Decimal(0)
        B1_prev = Decimal(1)
        zlib_prev_bits = 0
        step_entries: list[dict] = []

        for i, tid in enumerate(tokens):
            logits = comp._logits_view(0)
            cdf = logits_to_cdf(logits, total_freq=total_freq)
            u0 = int(cdf[tid]) / total_freq
            u1 = int(cdf[tid + 1]) / total_freq
            prob = (int(cdf[tid + 1]) - int(cdf[tid])) / total_freq
            bits = -math.log2(prob)

            top1_id = int(np.argmax(logits))
            top1_prob = (int(cdf[top1_id + 1]) - int(cdf[top1_id])) / total_freq
            model_rank = int(np.sum(logits > logits[tid]))
            top1_piece = comp.token_piece_display(top1_id)

            segs, chosen_seg_idx = select_row_segments(comp, cdf, tid, total_freq, label_cache)

            bit_start = len(bits_trace)
            enc.encode_symbol(tid, cdf)
            bit_end = len(bits_trace)
            zlib_bit_start = zlib_prev_bits
            prefix_bytes = full_text[: spans[i]["charEnd"]].encode("utf-8")
            zlib_bit_end = max(zlib_bit_start, len(zlib.compress(prefix_bytes, level=9)) * 8)
            zlib_prev_bits = zlib_bit_end

            m = bit_end
            p = enc.pending_bits
            E = int("".join(map(str, bits_trace)), 2) if m > 0 else 0
            denom = Decimal(1 << (m + p)) * Decimal(FULL_RANGE)
            e3_off = ((1 << p) - 1) * (FULL_RANGE >> 1) if p > 0 else 0
            base = (E << p) * FULL_RANGE + e3_off
            L_cur = Decimal(base + enc.low) / denom
            H_cur = Decimal(base + enc.high + 1) / denom

            # Dyadic binary interval represented by emitted bits_trace[:m]
            if m > 0:
                dy_denom = Decimal(1 << m)
                B0 = Decimal(E) / dy_denom
                B1 = Decimal(E + 1) / dy_denom
            else:
                B0 = Decimal(0)
                B1 = Decimal(1)

            span_cur = H_cur - L_cur
            bin_rel = [
                float((B0 - L_cur) / span_cur),
                float((B1 - L_cur) / span_cur),
            ]
            bin_rel_prev_in_cur = [
                float((B0_prev - L_cur) / span_cur),
                float((B1_prev - L_cur) / span_cur),
            ]

            axis_data = decimal_prefix_and_ticks(L_prev, H_prev, L_cur, H_cur)

            step_entries.append(
                {
                    "i": i,
                    "id": tid,
                    "piece": pieces[i],
                    "disp": format_token_disp(pieces[i]),
                    "lineIdx": spans[i]["lineIdx"],
                    "wordIdx": spans[i]["wordIdx"],
                    "t0": round(spans[i]["t0"], 4),
                    "t1": round(spans[i]["t1"], 4),
                    "prob": round(prob, 8),
                    "bits": round(bits, 4),
                    "rank": model_rank,
                    "top1": format_token_disp(top1_piece),
                    "top1Prob": round(top1_prob, 6),
                    "u0": u0,
                    "u1": u1,
                    "segs": segs,
                    "chosenSeg": chosen_seg_idx,
                    "bitStart": bit_start,
                    "bitEnd": bit_end,
                    "zlibBitStart": zlib_bit_start,
                    "zlibBitEnd": zlib_bit_end,
                    "pending": p,
                    "binRel": bin_rel,
                    "binRelPrev": bin_rel_prev_in_cur,
                    "axis": axis_data,
                }
            )

            L_prev, H_prev = L_cur, H_cur
            B0_prev, B1_prev = B0, B1
            if i + 1 < len(tokens):
                stream_pos = comp._advance_streams([tid], histories, 1, stream_pos, comp.n_ctx)

        payload = enc.finish()
        payload_bits = "".join(f"{b:08b}" for b in payload)
        assert payload == blob[stats.header_bytes :], "Payload mismatch vs compress_bytes!"

    doc = {
        "schemaVersion": 1,
        "summary": {
            "modelName": "Qwen3.5-9B-Base",
            "modelFile": args.model.name,
            "method": "Exact Softmax CDF + 62-bit Arithmetic Coding",
            "vocabSize": stats.vocab_size,
            "cdfBits": stats.cdf_bits,
            "numTokens": stats.num_tokens,
            "originalBytes": stats.original_bytes,
            "originalChars": len(full_text),
            "compressedBytes": stats.compressed_bytes,
            "headerBytes": stats.header_bytes,
            "payloadBytes": stats.payload_bytes,
            "payloadBits": len(payload_bits),
            "zlibBytes": zlib_bytes,
            "ratio": round(stats.compression_ratio, 4),
            "bitsPerByte": round(stats.bits_per_byte, 4),
            "bitsPerChar": round((stats.compressed_bytes * 8.0) / len(full_text), 4),
            "entropyBits": round(stats.theoretical_entropy_bits, 2),
            "exactMatch": True,
            "sha256": hashlib.sha256(raw_bytes).hexdigest(),
        },
        "payloadBitstring": payload_bits,
        "zlibBitstring": zlib_bitstring,
        "tokens": step_entries,
    }

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_kb = args.out_json.stat().st_size / 1024
    print(f"Wrote {args.out_llmc} ({len(blob)} bytes)")
    print(f"Wrote {args.out_json} ({size_kb:.1f} KB, {len(step_entries)} tokens)")
    print(f"Verified lossless SHA-256: {doc['summary']['sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
