import { useState } from "react";
import { COLORS } from "../config";

interface Props {
  years: number[];
  values: number[];
  selectedYear: number;
  onPickYear?: (y: number) => void;
  /** tooltip unit, e.g. "homes built" */
  unit?: string;
}

const compact = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v.toLocaleString();

const W = 340;
const H = 150;
const M = { top: 10, right: 6, bottom: 22, left: 38 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

/** Homes built per year: a single-series bar chart. The selected year uses the map's "built this year" colour. */
export default function BuiltChart({ years, values, selectedYear, onPickYear, unit = "homes built" }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...values));
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const step = iw / years.length;
  const bw = Math.max(2, step - 2); // 2px gap between bars
  const y = (v: number) => M.top + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Bar chart of ${unit} per year`}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#e4e3df" strokeWidth={1} />
            <text x={M.left - 6} y={y(t) + 3} textAnchor="end" className="axis">
              {compact(t)}
            </text>
          </g>
        ))}
        {years.map((yr, i) => {
          const v = values[i];
          const x = M.left + i * step + 1;
          const h = Math.max(0, M.top + ih - y(v));
          const r = Math.min(2, h / 2, bw / 2);
          const fill = yr === selectedYear ? COLORS.builtThisYear : "#2a78d6";
          const faded = yr > selectedYear;
          return (
            <g key={yr}>
              {h > 0 && (
                <path
                  d={`M${x},${M.top + ih} V${M.top + ih - h + r} Q${x},${M.top + ih - h} ${x + r},${M.top + ih - h}
                      H${x + bw - r} Q${x + bw},${M.top + ih - h} ${x + bw},${M.top + ih - h + r} V${M.top + ih} Z`}
                  fill={fill} opacity={faded ? 0.3 : hover === i || hover === null ? 1 : 0.7}
                />
              )}
              {/* hit target taller/wider than the mark */}
              <rect x={M.left + i * step} y={M.top} width={step} height={ih} fill="transparent"
                onMouseEnter={() => setHover(i)} onClick={() => onPickYear?.(yr)}
                style={{ cursor: onPickYear ? "pointer" : "default" }} />
            </g>
          );
        })}
        <line x1={M.left} x2={W - M.right} y1={M.top + ih} y2={M.top + ih} stroke="#a3a29b" />
        {years.filter((yr) => yr % 5 === 0).map((yr) => (
          <text key={yr} x={M.left + years.indexOf(yr) * step + step / 2} y={H - 6}
            textAnchor="middle" className="axis">{yr}</text>
        ))}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{
          left: `${((M.left + hover * step + step / 2) / W) * 100}%`,
        }}>
          <strong>{years[hover]}</strong>
          <span>{values[hover].toLocaleString()} {unit}</span>
        </div>
      )}
    </div>
  );
}
