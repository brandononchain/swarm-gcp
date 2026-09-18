/**
 * Where signals come from. Both of these are public APIs with no key, on
 * purpose: the point of this port is the Google Cloud shape around the work,
 * not the scraping. Swap in Apify or LinkedIn later and nothing downstream
 * changes, because everything below this file only sees the normalized shape.
 */

const UA = 'swarm-gcp (+https://github.com/brandononchain/swarm-gcp)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** Repos matching the profile, as a proxy for teams building with agents. */
export async function githubSignals({ query, limit = 25 }) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=${limit}`;
  const data = await getJson(url);
  return (data.items || []).map((r) => ({
    source: 'github',
    external_id: `github:${r.id}`,
    title: r.full_name,
    url: r.html_url,
    body: r.description || '',
    author: r.owner?.login || '',
    signal_at: r.pushed_at,
    metrics: { stars: r.stargazers_count, forks: r.forks_count },
  }));
}

/** Hacker News stories and comments, through the public Algolia index. */
export async function hackerNewsSignals({ query, limit = 25 }) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
  const data = await getJson(url);
  return (data.hits || []).map((h) => ({
    source: 'hackernews',
    external_id: `hn:${h.objectID}`,
    title: h.title || h.story_title || '',
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    body: h.comment_text || h.story_text || '',
    author: h.author || '',
    signal_at: h.created_at,
    metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
  }));
}

export const SOURCES = { github: githubSignals, hackernews: hackerNewsSignals };
