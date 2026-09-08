export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.TAVILY_API_KEY;
  if (!key) return res.status(500).json({ error: 'TAVILY_API_KEY is not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    // 1回の検索だけだと記事ページに結果が偏るため、切り口を変えて3回検索する。
    // 施設候補を増やしつつ、最後に厳格な施設判定を通す。
    const queries = [
      `${query} サウナ施設 店舗名 公式 料金 営業時間`,
      `${query} サウナ 施設 住所 水風呂 外気浴 ロウリュ`,
      `${query} サウナ 公式サイト 店舗 施設名`
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
    const candidates = buildCandidates(rows);

    return res.status(200).json({
      query,
      searchCount: queries.length,
      results: candidates
    });
  } catch (error) {
    return res.status(500).json({ error: 'Search failed', detail: error?.message || String(error) });
  }
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
  const genericTitle = /(\d+\s*(選|件)|ランキング|まとめ|おすすめ|編集部|ユーザーが選んだ|特集|徹底解説|完全ガイド|一覧|比較|紹介|人気|ベスト|TOP\s*\d+|個性派|外気浴ができる|サウナ施設|サウナスポット|東京の|都内の|関東の|全国の|〜できる|できるサウナ)/i;
  const badUrl = /(\/category\/|\/ranking\/|\/feature\/|\/column\/|\/magazine\/|\/news\/|\/blog\/|\/articles?\/|\/matome\/)/i;
  if (!rawTitle || rawTitle.length < 2 || rawTitle.length > 60) return null;
  if (genericTitle.test(rawTitle) || badUrl.test(url)) return null;

  const signals = [
    /住所|所在地|〒\s*\d{3}-?\d{4}/i,
    /営業時間|営業日|定休日|\d{1,2}:\d{2}/i,
    /料金|入浴料|入館料|\d{3,5}\s*円/i,
    /アクセス|最寄駅|徒歩\s*\d+分/i,
    /電話|TEL|\d{2,4}-\d{2,4}-\d{3,4}/i,
    /サウナ|水風呂|外気浴|ロウリュ/i
  ];
  const signalCount = signals.filter(re => re.test(text)).length;
  if (signalCount < 4) return null;

  let name = '';
  // 本文に明示された施設名を最優先。検索記事から拾う場合もここで施設名らしさを確認。
  for (const re of [
    /(?:施設名|店舗名|店名|店名は)\s*[:：]?\s*([^\n。|｜]{2,45})/i,
    /(?:施設名|店舗名|店名)\s*\n\s*([^\n]{2,45})/i
  ]) {
    const m = content.match(re);
    if (m && isPlausibleFacilityName(m[1])) { name = m[1].trim(); break; }
  }

  // 施設ページ自身のタイトルだけを候補にする。一般記事タイトルは絶対に採用しない。
  if (!name && looksLikeFacilityPageTitle(rawTitle)) name = extractNameFromFacilityTitle(rawTitle);
  if (!name || !isPlausibleFacilityName(name)) return null;

  // 施設名が本文にも現れることを要求（タイトルだけの推測を防ぐ）。
  const nameMentioned = new RegExp(escapeRegExp(name), 'i').test(content);
  if (!nameMentioned && signalCount < 5) return null;

  // 「サウナ」等の一般語だけ、検索条件そのもの、件数表現を除外。
  if (/^(東京|東京都|都内|関東|全国)?の?(外気浴|サウナ|水風呂|サウナ施設|サウナスポット)(が|の)?(できる|ある)?$/i.test(name)) return null;
  if (/\d+\s*(選|件)/i.test(name)) return null;

  return { name: name.replace(/\s{2,}/g, ' ').trim() };
}

function looksLikeFacilityPageTitle(title) {
  const t = String(title).replace(/\s+/g, ' ').trim();
  if (!t || /(\d+\s*(選|件)|ランキング|まとめ|おすすめ|編集部|特集|一覧|比較|紹介|人気|TOP\s*\d+|外気浴ができる|東京の|都内の|関東の|全国の|〜できる|できるサウナ)/i.test(t)) return false;
  // 施設名として使える強い語を含み、タイトルが短めなら採用。
  return /サウナ|SAUNA|スパ|SPA|銭湯|温浴|温泉|浴場|おふろ|湯|カプセル|ホテル/i.test(t) && t.length <= 45;
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
