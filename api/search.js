export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.TAVILY_API_KEY;
  if (!key) return res.status(500).json({ error: 'TAVILY_API_KEY is not configured' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    const searchQuery = `${query} サウナ施設 店舗名 営業時間 料金 水風呂 外気浴`;
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: searchQuery, search_depth: 'basic', max_results: 10, include_answer: true, include_raw_content: false })
    });
    if (!response.ok) return res.status(response.status).json({ error: 'Tavily request failed' });
    const data = await response.json();
    return res.status(200).json({ query, answer: data.answer || '', results: buildCandidates(Array.isArray(data.results) ? data.results : []) });
  } catch (error) { return res.status(500).json({ error: 'Search failed', detail: error?.message || String(error) }); }
}
function buildCandidates(rows) {
  const seen = new Set(), out = [];
  for (const row of rows) {
    const title = cleanTitle(row.title || ''), content = String(row.content || ''), url = String(row.url || '');
    const name = extractFacilityName(title, content);
    if (!name) continue;
    const key = normalize(name); if (seen.has(key)) continue; seen.add(key);
    out.push({ name, url, snippet: makeSnippet(content), score: Number(row.score || 0), ...extractInfo(`${title}\n${content}`) });
    if (out.length >= 8) break;
  }
  return out;
}
function cleanTitle(title) { return title.replace(/\s*[|｜]\s*[^|｜]+$/g, '').replace(/\s*[—–-]\s*[^—–-]+$/g, '').trim(); }
function extractFacilityName(title, content) {
  const bad = /(編集部|ランキング|まとめ|45選|10選|20選|30選|おすすめ.*選|ユーザーが選んだ|記事|ブログ|ニュース|検索結果|完全ガイド)/i;
  let t = title.replace(/^\s*[🥇🥈🥉①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '').replace(/(おすすめ|ランキング|まとめ|一覧|特集|徹底解説|紹介|レビュー|口コミ).*$/i, '').replace(/(のサウナ|サウナ施設|サウナ一覧).*$/i, '').trim();
  if (t && t.length >= 2 && t.length <= 45 && !bad.test(t) && looksLikeFacility(t)) return t;
  for (const re of [/[「『]([^」』]{2,40})[」』]/g, /(?:施設名|店舗名|店名)\s*[:：]\s*([^\n。]{2,40})/g]) {
    const m = re.exec(content); if (m && looksLikeFacility(m[1]) && !bad.test(m[1])) return m[1].trim();
  }
  if (t && /サウナ|スパ|温浴|銭湯|浴場/i.test(t) && !bad.test(t) && t.length <= 45) return t;
  return '';
}
function looksLikeFacility(s) { return /サウナ|スパ|銭湯|温浴|浴場|湯|温泉|カプセル|ホテル|らく|おふろ/i.test(s) || /^[A-Za-z0-9 .・ー\-&]+$/.test(s); }
function extractInfo(text) {
  const heat = firstNumber(text, /(\d{2,3})\s*℃(?:前後)?[^\n]{0,20}(?:サウナ|室)|サウナ[^\n]{0,20}?(\d{2,3})\s*℃/i);
  const cold = firstNumber(text, /(\d{1,2})\s*℃(?:前後)?[^\n]{0,20}(?:水風呂|水浴)|水風呂[^\n]{0,20}?(\d{1,2})\s*℃/i);
  const price = firstNumber(text, /(\d{3,5})\s*円/);
  const outdoor = /外気浴|露天|外気スペース|外気休憩/i.test(text);
  const type = /スチーム|ミスト/i.test(text) && !/ドライ|高温サウナ/i.test(text) ? '湿式' : (/ドライ|高温サウナ/i.test(text) ? '乾式' : '不明');
  const loyly = []; if (/セルフロウリュ/i.test(text)) loyly.push('セルフロウリュ'); if (/オートロウリュ/i.test(text)) loyly.push('オートロウリュ'); if (/アウフグース|熱波/i.test(text)) loyly.push('アウフグース');
  return { heat: heat || null, cold: cold || null, price: price || null, outdoor, type, loyly };
}
function firstNumber(text, re) { const m = text.match(re); if (!m) return null; for (let i=1;i<m.length;i++) if(m[i]) return Number(m[i]); return null; }
function makeSnippet(content) { const s=String(content).replace(/\s+/g,' ').trim(); return s.length>180?s.slice(0,177)+'…':s; }
function normalize(s) { return s.toLowerCase().replace(/[\s　・「」『』（）()\-ー]/g,''); }
