export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.TAVILY_API_KEY;
  if (!key) return res.status(500).json({ error: 'TAVILY_API_KEY is not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    // Search from several angles, then require evidence that a result is an actual facility.
    const queries = [
      `${query} サウナ 施設名 住所 公式サイト`,
      `${query} サウナ 店舗 料金 営業時間 水風呂`,
      `${query} サウナ 公式 住所 アクセス`
    ];

    const responses = await Promise.all(queries.map(q => fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: q,
        search_depth: 'basic',
        max_results: 10,
        include_answer: false,
        include_raw_content: false
      })
    })));

    for (const r of responses) {
      if (!r.ok) return res.status(r.status).json({ error: 'Tavily request failed' });
    }

    const payloads = await Promise.all(responses.map(r => r.json()));
    const rows = payloads.flatMap(d => Array.isArray(d.results) ? d.results : []);

    const results = buildFacilityResults(rows);
    return res.status(200).json({ query, searchCount: queries.length, results });
  } catch (error) {
    return res.status(500).json({ error: 'Search failed', detail: error?.message || String(error) });
  }
}

function buildFacilityResults(rows) {
  const groups = new Map();

  for (const row of rows) {
    const title = clean(row.title || '');
    const content = String(row.content || '');
    const url = String(row.url || '');

    if (!title || !url) continue;
    if (isArticleOrCollection(title, url)) continue;

    const info = extractInfo(`${title}\n${content}`);
    const candidate = extractFacilityName(title, content);

    if (!candidate) continue;

    const evidence = facilityEvidence(title, content, url);
    if (evidence < 5) continue;

    const key = normalize(candidate);
    const existing = groups.get(key);

    const item = {
      name: candidate,
      url,
      snippet: makeSnippet(content),
      verified: true,
      facilityConfidence: Math.min(100, 60 + evidence * 7),
      ...info
    };

    if (!existing || item.facilityConfidence > existing.facilityConfidence) {
      groups.set(key, item);
    }
  }

  return [...groups.values()]
    .sort((a,b) => b.facilityConfidence - a.facilityConfidence)
    .slice(0, 8);
}

function extractFacilityName(title, content) {
  const t = clean(title);

  // Reject collection/search/article titles before extracting anything.
  if (isArticleOrCollection(t, '')) return null;

  // Prefer explicit facility-name markers from the page content.
  const patterns = [
    /(?:施設名|店舗名|店名)\s*[:：]\s*([^\n|｜]{2,50})/i,
    /(?:施設名|店舗名|店名)\s*\n\s*([^\n]{2,50})/i
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m && plausibleName(m[1])) return trimName(m[1]);
  }

  // Use title only when it strongly looks like a single facility page.
  // Crucially, a title must contain a facility marker OR be accompanied by strong address/contact evidence.
  const parts = t.split(/\s*[|｜]\s*/).map(s => s.trim()).filter(Boolean);
  const main = parts[0] || '';

  if (plausibleName(main) && looksLikeSingleFacilityTitle(main)) {
    return trimName(main);
  }

  // Some official pages use "Facility Name | official..." so inspect the first title segment.
  if (parts.length >= 2 && plausibleName(parts[0]) && looksLikeSingleFacilityTitle(parts[0])) {
    return trimName(parts[0]);
  }

  return null;
}

function looksLikeSingleFacilityTitle(t) {
  if (!t || t.length < 2 || t.length > 50) return false;
  if (isArticleOrCollection(t, '')) return false;

  // A single facility name usually contains one of these commercial/facility markers.
  const marker = /(サウナ|SAUNA|スパ|SPA|銭湯|温浴|温泉|浴場|おふろ|湯|カプセル|ホテル)/i.test(t);
  if (!marker) return false;

  // Prevent generic search-condition phrases from passing.
  if (/(東京|東京都|都内|関東|全国|横浜|千葉|埼玉)[^。]{0,20}(サウナ|外気浴|水風呂)/i.test(t)) return false;
  return true;
}

function facilityEvidence(title, content, url) {
  const text = `${title}\n${content}`;
  const signals = [
    /住所|所在地|〒\s*\d{3}-?\d{4}/i,
    /営業時間|営業日|定休日|\d{1,2}:\d{2}/i,
    /料金|入浴料|入館料|\d{3,5}\s*円/i,
    /アクセス|最寄駅|徒歩\s*\d+\s*分/i,
    /電話|TEL|\d{2,4}-\d{2,4}-\d{3,4}/i,
    /サウナ|水風呂|外気浴|ロウリュ/i,
    /予約|受付|入館|利用/i
  ];
  let score = signals.filter(r => r.test(text)).length;

  // Official-looking facility domains are useful evidence, but never sufficient alone.
  if (/\/(access|price|facility|shop|store|about|sauna|spa)\b/i.test(url)) score += 1;
  if (/公式|official/i.test(title + content)) score += 1;

  return score;
}

function isArticleOrCollection(title, url) {
  const t = String(title).replace(/\s+/g, ' ').trim();
  const u = String(url);

  const badTitle = [
    /\d+\s*(選|件)/i,
    /ランキング/i, /まとめ/i, /おすすめ/i, /編集部/i, /特集/i,
    /一覧/i, /比較/i, /紹介/i, /人気/i, /ベスト/i, /TOP\s*\d+/i,
    /個性派/i, /徹底解説/i, /完全ガイド/i,
    /外気浴ができる/i, /サウナ施設/i, /サウナスポット/i,
    /全国の/i, /関東の/i, /東京の/i, /都内の/i,
    /できるサウナ/i, /サウナ\s*まとめ/i
  ];

  const badUrl = [
    /\/category\//i, /\/ranking\//i, /\/feature\//i, /\/column\//i,
    /\/magazine\//i, /\/news\//i, /\/blog\//i, /\/articles?\//i,
    /\/matome\//i, /\/search\//i, /[?&](q|query|keyword)=/i
  ];

  return badTitle.some(r => r.test(t)) || badUrl.some(r => r.test(u));
}

function plausibleName(s) {
  const x = trimName(s);
  if (x.length < 2 || x.length > 50) return false;
  if (/^(サウナ|SAUNA|スパ|SPA|銭湯|温泉|水風呂|外気浴|サウナ施設|施設|店舗)$/i.test(x)) return false;
  if (/\d+\s*(選|件)/i.test(x)) return false;
  if (/(ランキング|まとめ|おすすめ|編集部|特集|一覧|比較|紹介|人気|TOP\s*\d+)/i.test(x)) return false;
  if (/(東京|東京都|都内|関東|全国)の.+(サウナ|外気浴|水風呂)/i.test(x)) return false;
  return true;
}

function trimName(s) {
  return String(s).replace(/\s+/g, ' ').replace(/^[「『]|[」』]$/g, '').trim();
}

function clean(s) {
  return String(s)
    .replace(/^\s*[🥇🥈🥉①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '')
    .replace(/\s*[—–]\s*[^—–]+$/g, '')
    .trim();
}

function extractInfo(text) {
  const heat = firstNumber(text, [
    /(\d{2,3})\s*℃(?:前後)?[^\n]{0,30}(?:サウナ|室)/i,
    /サウナ[^\n]{0,30}?(\d{2,3})\s*℃/i
  ]);
  const cold = firstNumber(text, [
    /(\d{1,2})\s*℃(?:前後)?[^\n]{0,30}(?:水風呂|水浴)/i,
    /水風呂[^\n]{0,30}?(\d{1,2})\s*℃/i
  ]);
  const price = firstNumber(text, [/(\d{3,5})\s*円/]);
  const outdoor = /外気浴|露天|外気スペース|外気休憩/i.test(text);
  const type = /スチーム|ミスト/i.test(text) && !/ドライ|高温サウナ/i.test(text)
    ? '湿式'
    : (/ドライ|高温サウナ/i.test(text) ? '乾式' : '不明');

  const loyly = [];
  if (/セルフロウリュ/i.test(text)) loyly.push('セルフロウリュ');
  if (/オートロウリュ/i.test(text)) loyly.push('オートロウリュ');
  if (/アウフグース|熱波/i.test(text)) loyly.push('アウフグース');

  return { heat: heat || null, cold: cold || null, price: price || null, outdoor, type, loyly };
}

function firstNumber(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (!m) continue;
    for (let i=1; i<m.length; i++) if (m[i]) return Number(m[i]);
  }
  return null;
}

function makeSnippet(content) {
  const s = String(content).replace(/\s+/g, ' ').trim();
  return s.length > 180 ? s.slice(0,177) + '…' : s;
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[\s　・「」『』（）()\-ー]/g, '');
}
