import { dateAtNoon, money, shortDate } from "./utils";

type Point = { date: string; balance: number };

export function ForecastLineChart({ points, minimumBuffer = 0 }: { points: Point[]; minimumBuffer?: number }) {
  if (!points.length) return null;
  const width = 1000;
  const height = 300;
  const padX = 48;
  const padY = 30;
  const values = points.map(point => Number(point.balance));
  const min = Math.min(...values, minimumBuffer, 0);
  const max = Math.max(...values, minimumBuffer, 0);
  const range = Math.max(max - min, 1);
  const usableWidth = width - padX * 2;
  const usableHeight = height - padY * 2;
  const coordinates = points.map((point, index) => ({
    ...point,
    x: padX + (points.length === 1 ? usableWidth / 2 : index / (points.length - 1) * usableWidth),
    y: padY + (max - point.balance) / range * usableHeight,
  }));
  const polyline = coordinates.map(point => `${point.x},${point.y}`).join(" ");
  const minimumY = padY + (max - minimumBuffer) / range * usableHeight;
  const labels = [coordinates[0], coordinates[Math.floor(coordinates.length / 2)], coordinates.at(-1)!];

  return <div className="forecast-line-wrapper">
    <div className="forecast-line-scroll">
      <svg className="forecast-line-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Evolução do saldo projetado">
        {[0, 1, 2, 3, 4].map(index => {
          const y = padY + index / 4 * usableHeight;
          const value = max - index / 4 * range;
          return <g key={index}><line x1={padX} x2={width - padX} y1={y} y2={y} className="chart-grid-line" /><text x={padX - 10} y={y + 4} textAnchor="end" className="chart-axis-label">{money.format(value)}</text></g>;
        })}
        <line x1={padX} x2={width - padX} y1={minimumY} y2={minimumY} className="chart-minimum-line" />
        <polyline points={polyline} className="chart-balance-line" />
        {coordinates.map(point => <circle key={point.date} cx={point.x} cy={point.y} r="5" className={point.balance < minimumBuffer ? "chart-point danger" : "chart-point"}><title>{shortDate.format(dateAtNoon(point.date))}: {money.format(point.balance)}</title></circle>)}
        {labels.map(point => <text key={point.date} x={point.x} y={height - 5} textAnchor="middle" className="chart-date-label">{shortDate.format(dateAtNoon(point.date)).slice(0, 5)}</text>)}
      </svg>
    </div>
    <div className="forecast-line-legend"><span><i className="line-balance" /> Saldo projetado</span><span><i className="line-minimum" /> Caixa mínimo</span></div>
  </div>;
}