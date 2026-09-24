"use client";
import { useRef, useState } from "react";
import type { Series } from "./market-provider";
import { cash } from "../lib/format";
import { useT } from "../lib/i18n";

/**
 * The reference-price chart, with a scale.
 *
 * It had none. `/api/market/series` has always returned `min`, `max`, `first`, `last` and every
 * plotted point, and the chart drew the polyline and four gridlines at fixed pixel heights that
 * corresponded to no value at all. So the line showed shape and nothing else: you could see that
 * a price moved without being able to read what it moved between.
 *
 * ## Why the labels are HTML rather than SVG text
 *
 * The chart's `<svg>` carries `preserveAspectRatio="none"`, which is what lets the polyline fill
 * a responsive box without the caller knowing the pixel width. It also stretches everything
 * inside it horizontally — a `<text>` element in there would be legible at one viewport width and
 * smeared at every other. So the geometry stays in the SVG and every glyph sits outside it, in a
 * positioned overlay.
 *
 * The positions are not guesses. `series.ts` projects into `viewBox="0 0 400 160"` with a 12-unit
 * pad, so the maximum sits at y=12 and the minimum at y=148 — 7.5% and 92.5% of the height. Those
 * two constants are the contract between the two files and are named here rather than inlined.
 */

/** Matches the projection in `src/lib/chain/series.ts`. */
const VIEW_H = 160;
const PAD = 12;
const topPct = (PAD / VIEW_H) * 100;
const bottomPct = ((VIEW_H - PAD) / VIEW_H) * 100;

/** Where a value sits, as a percentage down the box. */
function yPct(value: number, min: number, max: number): number {
  const range = Math.max(1e-9, max - min);
  return bottomPct - ((value - min) / range) * (bottomPct - topPct);
}

const time = (ms: number, withDate: boolean) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));

export function MarketChart({ series, loading }: { series?: Series; loading: boolean }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);

  const points = series?.points ?? [];
  const line = series?.polyline ?? "";
  const withDate = series?.range !== "1D";

  // The nearest round to the pointer, by time rather than by pixel: the rounds are unevenly
  // spaced — a feed updates on a 0.5% move, not on a clock — so snapping to the closest x would
  // land between two real observations and invent a reading.
  function track(clientX: number) {
    const el = box.current;
    if (!el || points.length === 0 || !series) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const tMin = points[0]!.t;
    const tMax = points[points.length - 1]!.t;
    const want = tMin + frac * (tMax - tMin);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i]!.t - want) < Math.abs(points[best]!.t - want)) best = i;
    }
    const span = Math.max(1, tMax - tMin);
    setHover({ i: best, x: ((points[best]!.t - tMin) / span) * 100 });
  }

  const at = hover && points[hover.i] ? points[hover.i]! : null;

  return (
    <div className="market-chart has-axis">
      <div
        className="chart-plot"
        onPointerMove={(e) => track(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        {/* The overlays live in here rather than in `.chart-plot`, whose right padding reserves
            the label gutter. A percentage resolves against the padding box, so a crosshair at
            100% positioned against the outer element lands *inside* the gutter and sits on top
            of the price it is supposed to be read against. */}
        <div className="chart-area" ref={box}>
          <svg viewBox="0 0 400 160" role="img" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00b9e4" stopOpacity=".22" />
                <stop offset="100%" stopColor="#00ffff" stopOpacity="0" />
              </linearGradient>
            </defs>
            {/* Gridlines on the values the labels name, rather than at fixed pixel heights that
              corresponded to nothing. */}
            {[PAD, VIEW_H / 2, VIEW_H - PAD].map((y) => (
              <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="#00008016" />
            ))}
            {line && (
              <>
                <polygon points={`0,160 ${line} 400,160`} fill="url(#chart-fill)" />
                <polyline
                  points={line}
                  fill="none"
                  stroke="#0058aa"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>

          {/* Everything below is HTML, positioned over the stretched SVG so no glyph is distorted. */}
          {at && series && (
            <>
              <i className="chart-crosshair" style={{ left: `${hover!.x}%` }} aria-hidden="true" />
              <i
                className="chart-dot"
                style={{ left: `${hover!.x}%`, top: `${yPct(at.v, series.min, series.max)}%` }}
                aria-hidden="true"
              />
              <div
                className={"chart-readout" + (hover!.x > 60 ? " is-left" : "")}
                style={{ left: `${hover!.x}%` }}
                role="status"
              >
                <b>{cash(at.v)}</b>
                <small>
                  {time(at.t, withDate)}
                  {at.session !== "MARKET" ? ` · ${at.session.toLowerCase()}` : ""}
                </small>
              </div>
            </>
          )}
        </div>

        {series && points.length > 0 && (
          <div className="chart-scale" aria-hidden="true">
            {[series.max, (series.max + series.min) / 2, series.min].map((v, i) => (
              <span key={i} style={{ top: `${yPct(v, series.min, series.max)}%` }}>
                {cash(v)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* A screen reader gets the shape as a sentence; the visual axis is decorative to it. */}
      <p className="sr-only">
        {series
          ? `${series.symbol} reference price, ${series.axis.label.toLowerCase()}. ${cash(series.first)} to ${cash(series.last)}, ${series.changePct >= 0 ? "up" : "down"} ${Math.abs(series.changePct).toFixed(2)} percent. Low ${cash(series.min)}, high ${cash(series.max)}, across ${series.rounds} oracle updates.`
          : t("Reference price chart loading")}
      </p>

      <div className="chart-axis">
        <span>{series?.axis.left ?? ""}</span>
        <span>
          {loading ? t("LOADING HISTORY…") : series ? series.axis.label : t("HISTORY UNAVAILABLE")}
        </span>
        <span>{series?.axis.right ?? ""}</span>
      </div>
    </div>
  );
}
