import lexicon from './category-lexicon.json' with { type: 'json' };
import refinements from '../category-rules.json' with { type: 'json' };

type Rule = [string, number, string[]];
type Evidence = { token: string; score: number; source: string; kind: string };
type Candidate = { category: string; score: number; evidence: Evidence[] };
export interface Classification { category: string; suggestedCategory: string; needsReview: boolean; confidence: number; evidence: Evidence[] }
const normalize = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, ' ').trim();
function match(words: string[], title: string, token: string) {
  if (token.includes(' ')) return title.includes(` ${token} `) ? 'phrase' : '';
  if (words.includes(token)) return 'exact';
  return token.length >= 5 && words.some(word => word.startsWith(token)) ? 'stem' : '';
}
const unique = new Map<string, Evidence & { category: string; weight: number }>();
const packs: [string, Rule[]][] = [
  ['local', refinements.rules.map(rule => [rule.category, rule.weight, rule.tokens])],
  ['builtin', lexicon.rules as Rule[]], ['context', lexicon.contextRules as Rule[]],
];
for (const [source, rules] of packs) for (const [category, weight, tokens] of rules) for (const raw of tokens) {
  const token = normalize(raw), key = `${category}\0${token}`, old = unique.get(key), count = token.split(' ').length;
  if (!old || weight > old.weight) unique.set(key, { category, weight, token, score: weight + count + (count > 1 ? 3 : 0), source, kind: '' });
}
const entries = [...unique.values()];
const negatives = lexicon.negativeContextRules as [string, string, number][];
const reviewOnly = new Set(lexicon.reviewOnlyTokens);
const cache = new Map<string, Classification>();
const unknown = (): Classification => ({ category: 'unknown', suggestedCategory: 'unknown', confidence: 0, needsReview: true, evidence: [] });
function overlap(a: string, b: string) {
  return !a.includes(' ') && !b.includes(' ') ? a.startsWith(b) || b.startsWith(a) : ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}
export function classify(title: string): Classification {
  const normalized = normalize(title);
  if (!normalized || /^(ozon pdf не разобран|wildberries receipt)/.test(normalized)) return unknown();
  const existing = cache.get(normalized); if (existing) return existing;
  const words = normalized.split(' '), padded = ` ${normalized} `, scores = new Map<string, Candidate>();
  for (const entry of entries) {
    const kind = match(words, padded, entry.token); if (!kind) continue;
    const candidate = scores.get(entry.category) || { category: entry.category, score: 0, evidence: [] };
    const evidence = { token: entry.token, score: entry.score, source: entry.source, kind };
    const index = candidate.evidence.findIndex(item => overlap(item.token, entry.token));
    if (index === -1) { candidate.evidence.push(evidence); candidate.score += evidence.score; }
    else if (candidate.evidence[index]!.score < evidence.score) { candidate.score += evidence.score - candidate.evidence[index]!.score; candidate.evidence[index] = evidence; }
    scores.set(entry.category, candidate);
  }
  for (const [category, token, penalty] of negatives) {
    const candidate = scores.get(category);
    if (candidate && match(words, padded, normalize(token))) { candidate.score -= penalty; candidate.evidence.push({ token, score: -penalty, source: 'context', kind: 'negative' }); }
  }
  const [top, second] = [...scores.values()].sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  let result = unknown();
  if (!top && /\s\|\s[\p{L}][\p{L}\s.-]{2,}$/u.test(title)) result = { category: 'Книги', suggestedCategory: 'Книги', confidence: .72, needsReview: false, evidence: [] };
  if (top) {
    const margin = top.score - (second?.score || 0), accepted = top.score >= 7 && (!second || margin >= 3);
    const raw = .28 + Math.min(1, top.score / 22) * .37 + Math.min(1, Math.max(0, margin) / 10) * .2 + Math.min(.15, top.evidence.length * .04);
    const confidence = Number(Math.max(.05, Math.min(.99, accepted ? raw : raw * .58)).toFixed(2));
    const positive = top.evidence.filter(item => item.score > 0), first = positive[0];
    const weak = positive.length === 1 && first?.kind !== 'phrase' && top.score < 12 && reviewOnly.has(first?.token || '') && first?.source !== 'local';
    const strong = positive.some(item => item.kind === 'phrase' && item.score >= 11);
    const sure = accepted && confidence >= .58 && !weak && !(second && margin < 5 && !strong);
    result = { category: sure ? top.category : 'unknown', suggestedCategory: top.category, confidence, needsReview: !sure, evidence: top.evidence };
  }
  cache.set(normalized, result);
  if (cache.size > 4000) cache.delete(cache.keys().next().value!);
  return result;
}
