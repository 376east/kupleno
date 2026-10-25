import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useReducedMotion } from 'motion/react';
import { formatMoney } from '../domain.mjs';
import { spendingSeries } from '../spending-series.mjs';
import type { Purchase } from '../model';

const dateLabel = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
export function SpendingChart({ rows }: { rows: Purchase[] }) {
  const reduce = useReducedMotion();
  const { points, undated } = useMemo(() => spendingSeries(rows), [rows]);
  const visible = points.slice(-90);
  if (!visible.length) return null;
  return <section className="panel spending-history" aria-labelledby="spending-title">
    <div className="panel-heading"><h2 id="spending-title">Как менялись расходы</h2><small>С учётом возвратов</small></div>
    <p className="note-line">Накопленный итог за выбранный период.{points.length > 90 && ' Показаны последние 90 дней с операциями.'}</p>
    <div className="spending-canvas" role="img" aria-label="График накопленных расходов. Точные значения доступны в таблице ниже.">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={visible} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={value => String(value).slice(5).split('-').reverse().join('.')} minTickGap={35} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <YAxis tickFormatter={value => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) / 100)} width={52} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <ReferenceLine y={0} stroke="var(--muted)" />
          <Tooltip labelFormatter={value => dateLabel(String(value))} formatter={value => [formatMoney(Number(value)), 'Накопленный итог']} contentStyle={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8 }} />
          <Area type="linear" dataKey="total" name="Накопленный итог" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.1} strokeWidth={2} isAnimationActive={!reduce} animationDuration={180} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    {undated > 0 && <p className="note-line">Не показаны операции без корректной даты: {undated}. Их суммы остаются в общем итоге.</p>}
    <details className="spending-data"><summary>Точные данные графика</summary><div className="table-wrap"><table><thead><tr><th scope="col">Дата</th><th scope="col">За день</th><th scope="col">Накопленный итог</th></tr></thead><tbody>{visible.map(point => <tr key={point.date}><th scope="row">{dateLabel(point.date)}</th><td>{formatMoney(point.amount)}</td><td>{formatMoney(point.total)}</td></tr>)}</tbody></table></div></details>
  </section>;
}
