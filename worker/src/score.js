/**
 * Scoring, in code. Deterministic, explainable, testable. A model can write
 * the opening line later; the number that decides whether a lead is worth your
 * attention comes from here. Same rule ROAM uses: engines compute, models
 * explain.
 */

const strip = (s) => String(s || '').toLowerCase();

export const DEFAULT_PROFILE = {
  signals: {
    'ai agent': 0.25, agentic: 0.25, llm: 0.15, rag: 0.15, 'tool use': 0.15,
    evals: 0.2, eval: 0.1, observability: 0.15, mcp: 0.2, 'voice ai': 0.2,
    hiring: 0.3, 'we are hiring': 0.35, 'looking for': 0.15, founding: 0.2,
  },
  dealBreakers: ['awesome list', 'tutorial', 'course', 'roadmap', 'cheat sheet', 'interview questions'],
  halfLifeDays: 14,
  threshold: 0.45,
};

export function freshness(signalAt, now = Date.now(), halfLifeDays = 14) {
  const ageDays = (now - Date.parse(signalAt)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

export function scoreSignal(signal, profile = DEFAULT_PROFILE, now = Date.now()) {
  const text = `${strip(signal.title)} ${strip(signal.body)}`;
  const reasons = [];

  const breaker = profile.dealBreakers.find((term) => text.includes(term));
  if (breaker) return { score: 0, reasons: [`deal breaker: ${breaker}`], rejected: true };

  let matched = 0;
  for (const [term, weight] of Object.entries(profile.signals)) {
    if (text.includes(term)) {
      matched += weight;
      reasons.push(`matched "${term}" (+${weight})`);
    }
  }
  const relevance = Math.min(1, matched);

  const fresh = freshness(signal.signal_at, now, profile.halfLifeDays);
  reasons.push(`freshness ${fresh.toFixed(2)}`);

  // Attention is a weak third input on purpose. A popular repo is not a buyer.
  const attention = Math.min(1, Math.log10(1 + (signal.metrics?.stars ?? signal.metrics?.points ?? 0)) / 3);
  reasons.push(`attention ${attention.toFixed(2)}`);

  const score = Number((relevance * 0.6 + fresh * 0.3 + attention * 0.1).toFixed(4));
  return { score, reasons, rejected: score < profile.threshold };
}
