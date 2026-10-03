import type { Purchase } from './model';
import { currencyOf, moneyDecimal, moneyMinor } from './domain.mjs';
import { analyze } from './intelligence-engine.mjs';

/** Compare only purchases from the same shop and profile, with verified composition and amounts. */
export function inspectPurchases(rows: Purchase[], profile = 'all') {
  const buckets = new Map<string, Purchase[]>();
  for (const row of rows) {
    if (row.excluded || row.parse_quality === 'fallback' || currencyOf(row) !== 'RUB' || moneyMinor(row.amount) === null) continue;
    if (profile !== 'all' && row.profile !== profile) continue;
    const key = `${row.source}\u0001${row.profile || 'personal'}`;
    const bucket = buckets.get(key) || []; bucket.push({ ...row, amount: moneyDecimal(moneyMinor(row.amount)!) }); buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([scope, input]) => {
    const report = analyze(input);
    const groups = new Map(report.groups.map(group => [group.id, group]));
    return {
      anomalies: report.anomalies.filter(item => item.type !== 'price_increase' || Math.abs((moneyMinor(input[item.rowIndexes[1]!]!.amount) || 0) - (moneyMinor(input[item.rowIndexes[0]!]!.amount) || 0)) >= 50000).map(item => ({ ...item, rows: item.rowIndexes.map(index => input[index]!), id: `${profile}\u0001${item.type}\u0001${item.rowIndexes.map(index => input[index]!.rowId).sort().join('|')}`.slice(0, 500) })),
      recurring: report.recurring.map(item => ({ ...item, rows: (groups.get(item.groupId)?.rowIndexes || []).map(index => input[index]!), id: `${profile}\u0001${scope}\u0001${item.key}`, legacyId: `${profile}\u0001${item.key}`.slice(0, 500) })),
      prices: report.priceHistory.filter(item => item.observations.length > 1).map(item => ({ ...item, id: `${scope}\u0001${item.key}`, rows: item.observations.map(point => input[point.rowIndex]!) })),
    };
  });
}
