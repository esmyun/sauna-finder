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
    const title = cleanTitle(row.title || '');
    const content = String(row.content || '');
    const url = String(row.url || '');

    // 「記事」ではなく、実在する施設ページとして確認できる候補だけを採用する。
    const verified = verifyFacilityCandidate(title, content, url);
    if (!verified) continue;

    const key = normalize(verified.name);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name: verified.name,
      url,
      snippet: makeSnippet(content),
      score: Number(row.score || 0),
      verified: true,
      ...extractInfo(`${title}\n${content}`)
    });
    if (out.length >= 8) break;
  }
  return out;
}

function cleanTitle(title) {
  return title
    .replace(/^\s*[🥇🥈🥉①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '')
    .replace(/\s*[|｜]\s*[^|｜]+$/g, '')
    .replace(/\s*[—–]\s*[^—–]+$/g, '')
    .trim();
}

// Web記事・ランキング・まとめを施設名として誤認しないための厳格な判定。
function verifyFacilityCandidate(title, content, url) {
  const rawTitle = String(title).replace(/\s+/g, ' ').trim();
  const text = `${rawTitle}\n${content}`;
  const badTitle = /(\d+選|ランキング|まとめ|おすすめ|編集部|ユーザーが選んだ|特集|徹底解説|完全ガイド|一覧|比較|紹介|人気|ベスト|TOP\s*\d+|サウナ施設\s*\d*選|個性派サウナ)/i;
  const badUrl = /(\/category\/|\/ranking\/|\/feature\/|\/column\/|\/magazine\/|\/news\/|\/blog\/|\/articles?\/|\/matome\/)/i;

  if (!rawTitle || rawTitle.length < 2 || rawTitle.length > 55) return null;
  if (badTitle.test(rawTitle) || badUrl.test(url)) return null;

  // 施設ページにありがちな「住所・営業時間・料金・アクセス」等の実在情報。
  const signals = [
    /住所|所在地|〒\s*\d{3}-?\d{4}/i,
    /営業時間|営業日|定休日|\d{1,2}:\d{2}/i,
    /料金|入浴料|入館料|\d{3,5}\s*円/i,
    /アクセス|最寄駅|徒歩\s*\d+分/i,
    /電話|TEL|\d{2,4}-\d{2,4}-\d{3,4}/i,
    /サウナ|水風呂|外気浴|ロウリュ/i
  ];
  const signalCount = signals.filter(re => re.test(text)).length;
  if (signalCount < 3) return null;

  let name = extractNameFromFacilityTitle(rawTitle);
  if (!name) {
    // タイトルだけで施設名を確定できない場合は本文の「施設名/店舗名/店名」表記を優先。
    for (const re of [
      /(?:施設名|店舗名|店名)\s*[:：]\s*([^\n。]{2,45})/i,
      /(?:施設名|店舗名|店名)\s*\n\s*([^\n]{2,45})/i
    ]) {
      const m = content.match(re);
      if (m && isPlausibleFacilityName(m[1])) { name = m[1].trim(); break; }
    }
  }

  if (!name) return null;
  if (!isPlausibleFacilityName(name)) return null;

  // 英数字だけの一般語は、施設ページとして明確に確認できる場合以外は除外。
  const latinOnly = /^[A-Za-z0-9 .&'’_\-]+$/.test(name);
  const nameMentioned = new RegExp(escapeRegExp(name), 'i').test(content);
  if (latinOnly && (!nameMentioned || signalCount < 4)) return null;

  return { name: name.replace(/\s{2,}/g, ' ').trim() };
}

function extractNameFromFacilityTitle(title) {
  let t = title
    .replace(/\s*[|｜]\s*[^|｜]+$/g, '')
    .replace(/^\s*(公式|公式サイト)\s*/i, '')
    .trim();

  // 記事っぽいタイトルはここでも拒否。
  if (/(\d+選|ランキング|まとめ|おすすめ|編集部|特集|一覧|比較|紹介|人気|TOP\s*\d+)/i.test(t)) return '';

  // 「○○ サウナ」「○○SAUNA」「○○スパ」など、施設名として明確なもの。
  if (/(サウナ|SAUNA|スパ|SPA|銭湯|温浴|温泉|浴場|おふろ|湯|カプセル|ホテル)/i.test(t)) {
    return t;
  }

  // 施設ページタイトルが「○○ | 料金・営業時間」のような場合のみ、本文確認に任せる。
  return '';
}

function isPlausibleFacilityName(s) {
  const x = String(s || '').replace(/\s+/g, ' ').trim();
  if (x.length < 2 || x.length > 55) return false;
  if (/^(サウナ|SAUNA|スパ|SPA|銭湯|温泉|サウナ施設|施設|店舗)$/i.test(x)) return false;
  if (/(\d+選|ランキング|まとめ|おすすめ|編集部|特集|一覧|比較|紹介|人気|TOP\s*\d+)/i.test(x)) return false;
  return true;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInfo(text) {
  const heat = firstNumber(text, /(\d{2,3})\s*℃(?:前後)?[^\n]{0,20}(?:サウナ|室)|サウナ[^\n]{0,20}?(\d{2,3})\s*℃/i);
  const cold = firstNumber(text, /(\d{1,2})\s*℃(?:前後)?[^\n]{0,20}(?:水風呂|水浴)|水風呂[^\n]{0,20}?(\d{1,2})\s*℃/i);
  const price = firstNumber(text, /(\d{3,5})\s*円/);
  const outdoor = /外気浴|露天|外気スペース|外気休憩/i.test(text);
  const type = /スチーム|ミスト/i.test(text) && !/ドライ|高温サウナ/i.test(text) ? '湿式' : (/ドライ|高温サウナ/i.test(text) ? '乾式' : '不明');
  const loyly = [];
  if (/セルフロウリュ/i.test(text)) loyly.push('セルフロウリュ');
  if (/オートロウリュ/i.test(text)) loyly.push('オートロウリュ');
  if (/アウフグース|熱波/i.test(text)) loyly.push('アウフグース');
  return { heat: heat || null, cold: cold || null, price: price || null, outdoor, type, loyly };
}
function firstNumber(text, re) { const m = text.match(re); if (!m) return null; for (let i=1;i<m.length;i++) if(m[i]) return Number(m[i]); return null; }
function makeSnippet(content) { const s=String(content).replace(/\s+/g,' ').trim(); return s.length>180?s.slice(0,177)+'…':s; }
function normalize(s) { return s.toLowerCase().replace(/[\s　・「」『』（）()\-ー]/g,''); }
