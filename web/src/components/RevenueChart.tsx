import { formatDate, formatRupiah } from '../lib/format';
import type { DailyRevenue } from '../types';

export function RevenueChart({ data }: { data: DailyRevenue[] }) {
  const max = Math.max(1, ...data.map((item) => item.totalRevenue));
  const width = 680;
  const height = 220;
  const left = 8;
  const right = 8;
  const gap = data.length > 1 ? 14 : 0;
  const barWidth = Math.max(12, (width - left - right - gap * (data.length - 1)) / Math.max(1, data.length));

  return (
    <div className="chart-wrap">
      <svg className="revenue-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Grafik batang pendapatan harian">
        <title>Pendapatan per hari</title>
        <line x1="0" y1={height - 26} x2={width} y2={height - 26} className="chart-baseline" />
        {data.map((item, index) => {
          const barHeight = item.totalRevenue === 0 ? 2 : Math.max(4, ((height - 58) * item.totalRevenue) / max);
          const x = left + index * (barWidth + gap);
          const y = height - 27 - barHeight;
          return (
            <g key={item.date}>
              <title>{`${formatDate(item.date)}, ${formatRupiah(item.totalRevenue)}, ${item.transactionCount} transaksi`}</title>
              <rect className="chart-bar" x={x} y={y} width={barWidth} height={barHeight} rx="3" />
              <text className="chart-label" x={x + barWidth / 2} y={height - 7} textAnchor="middle">
                {new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' }).format(new Date(`${item.date}T12:00:00`))}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="chart-summary" aria-label="Rincian pendapatan per hari">
        {data.map((item) => (
          <div className="chart-summary__row" key={item.date}>
            <span>{formatDate(item.date)}</span>
            <span>{item.transactionCount} transaksi</span>
            <strong>{formatRupiah(item.totalRevenue)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
