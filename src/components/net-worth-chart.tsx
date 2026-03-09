'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/format';

interface SnapshotPoint {
  date: string;
  net_worth: number;
  assets: number;
  liabilities: number;
}

interface NetWorthChartProps {
  className?: string;
}

export function NetWorthChart({ className }: NetWorthChartProps) {
  const [points, setPoints] = useState<SnapshotPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    async function fetchSnapshots() {
      try {
        const res = await fetch('/api/dashboard/snapshots');
        if (!res.ok) return;
        const data = await res.json();
        setPoints(data.points ?? []);
      } catch {
        // Silently fail — chart is non-critical
      } finally {
        setLoading(false);
      }
    }
    fetchSnapshots();
  }, []);

  if (loading) {
    return (
      <div className={className}>
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Loading trend data...
        </div>
      </div>
    );
  }

  if (points.length < 2) {
    return (
      <div className={className}>
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Not enough snapshot data yet. Trend chart will appear after 2+ daily snapshots.
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <SVGLineChart points={points} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />
      {hoveredIndex !== null && points[hoveredIndex] && (
        <ChartTooltip point={points[hoveredIndex]} />
      )}
    </div>
  );
}

// --- SVG Chart ---

const CHART_WIDTH = 600;
const CHART_HEIGHT = 200;
const PADDING = { top: 20, right: 20, bottom: 30, left: 70 };

function SVGLineChart({
  points,
  hoveredIndex,
  onHover,
}: {
  points: SnapshotPoint[];
  hoveredIndex: number | null;
  onHover: (idx: number | null) => void;
}) {
  const netWorths = points.map((p) => p.net_worth);
  const assets = points.map((p) => p.assets);
  const liabilities = points.map((p) => p.liabilities);

  const allValues = [...netWorths, ...assets, ...liabilities];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = minVal - padding;
  const yMax = maxVal + padding;

  const plotW = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotH = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const toX = (i: number) =>
    PADDING.left + (i / (points.length - 1)) * plotW;
  const toY = (val: number) =>
    PADDING.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  const netWorthPath = buildPath(points.length, (i) => toX(i), (i) => toY(netWorths[i]));
  const assetsPath = buildPath(points.length, (i) => toX(i), (i) => toY(assets[i]));
  const liabilitiesPath = buildPath(points.length, (i) => toX(i), (i) => toY(liabilities[i]));

  // Y-axis labels (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const val = yMin + (i / 4) * (yMax - yMin);
    return { val, y: toY(val) };
  });

  // X-axis labels (show ~5 dates)
  const step = Math.max(1, Math.floor(points.length / 5));
  const xTicks = points
    .map((p, i) => ({ date: p.date, x: toX(i), i }))
    .filter((_, i) => i % step === 0 || i === points.length - 1);

  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="w-full h-auto"
      onMouseLeave={() => onHover(null)}
    >
      {/* Grid lines */}
      {yTicks.map((t) => (
        <line
          key={t.val}
          x1={PADDING.left}
          x2={CHART_WIDTH - PADDING.right}
          y1={t.y}
          y2={t.y}
          stroke="currentColor"
          strokeOpacity={0.08}
        />
      ))}

      {/* Y-axis labels */}
      {yTicks.map((t) => (
        <text
          key={`label-${t.val}`}
          x={PADDING.left - 8}
          y={t.y + 4}
          textAnchor="end"
          className="fill-muted-foreground"
          fontSize={10}
        >
          {formatCompactValue(t.val)}
        </text>
      ))}

      {/* X-axis labels */}
      {xTicks.map((t) => (
        <text
          key={t.date}
          x={t.x}
          y={CHART_HEIGHT - 6}
          textAnchor="middle"
          className="fill-muted-foreground"
          fontSize={10}
        >
          {formatShortDate(t.date)}
        </text>
      ))}

      {/* Lines */}
      <path d={assetsPath} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeOpacity={0.4} />
      <path d={liabilitiesPath} fill="none" stroke="#ef4444" strokeWidth={1.5} strokeOpacity={0.4} />
      <path d={netWorthPath} fill="none" stroke="#3b82f6" strokeWidth={2} />

      {/* Hover indicator */}
      {hoveredIndex !== null && (
        <>
          <line
            x1={toX(hoveredIndex)}
            x2={toX(hoveredIndex)}
            y1={PADDING.top}
            y2={PADDING.top + plotH}
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeDasharray="4 2"
          />
          <circle cx={toX(hoveredIndex)} cy={toY(netWorths[hoveredIndex])} r={4} fill="#3b82f6" />
          <circle cx={toX(hoveredIndex)} cy={toY(assets[hoveredIndex])} r={3} fill="#22c55e" />
          <circle cx={toX(hoveredIndex)} cy={toY(liabilities[hoveredIndex])} r={3} fill="#ef4444" />
        </>
      )}

      {/* Invisible hover rectangles for each data point */}
      {points.map((_, i) => {
        const segW = plotW / points.length;
        return (
          <rect
            key={i}
            x={toX(i) - segW / 2}
            y={PADDING.top}
            width={segW}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => onHover(i)}
          />
        );
      })}
    </svg>
  );
}

function ChartTooltip({ point }: { point: SnapshotPoint }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
      <span className="text-muted-foreground">{formatShortDate(point.date)}</span>
      <span>
        <span className="inline-block h-2 w-2 rounded-full bg-blue-500 mr-1" />
        Net Worth: <strong>{formatCurrency(point.net_worth)}</strong>
      </span>
      <span>
        <span className="inline-block h-2 w-2 rounded-full bg-green-500 mr-1" />
        Assets: <strong>{formatCurrency(point.assets)}</strong>
      </span>
      <span>
        <span className="inline-block h-2 w-2 rounded-full bg-red-500 mr-1" />
        Liabilities: <strong>{formatCurrency(point.liabilities)}</strong>
      </span>
    </div>
  );
}

// --- Helpers ---

function buildPath(
  len: number,
  getX: (i: number) => number,
  getY: (i: number) => number
): string {
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    parts.push(`${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(i).toFixed(1)}`);
  }
  return parts.join(' ');
}

function formatCompactValue(val: number): string {
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
