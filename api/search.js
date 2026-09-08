export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.TAVILY_API_KEY;
  if (!key) return res.status(500).json({ error: 'TAVILY_API_KEY is not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const area = detectArea(query);
    const priceLimit = detectPriceLimit(query);

    // 料金情報を取りに行く検索を独立させる。
    // 「最初に見つかった○○円」を料金として採用しない。
    const queries = [
      `${query} サウナ施設 公式サイト 料金 60分 90分 120分 入館料 サウナ料金`,
      `${query} サウナ 施設名 公式 住所 料金表 利用時間 水風呂 外気浴`,
      `${query} サウナ店 公式 料金 通常料金 一般 1時間 90分 2時間`,
      `${query} サウナ施設 公式 料金表 入浴料 サウナ利用料`
    ];

    const responses = await Promise.all(queries.map(q => fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: q,
        search_depth: 'basic',
        max_results: 8,
        include_answer: false,
        include_raw_content: false
      })
    })));

    for (const r of responses) {
      if (!r.ok) return res.status(r.status).json({ error: 'Tavily request failed' });
    }

    const payloads = await Promise.all(responses.map(r => r.json()));
    const rows = payloads.flatMap(d => Array.isArray(d.results) ? d.results : []);
    const candidates = buildCandidates(rows, area, priceLimit);

    return res.status(200).json({
      query,
      searchCount: queries.length,
      priceLimit: priceLimit ?? null,
      results: candidates
    });
  } catch (error) {
    return res.status(500).json({ error: 'Search failed', detail: error?.message || String(error) });
  }
}

function buildCandidates(rows, area, priceLimit) {
  const groups = new Map();

  for (const row of rows) {
    const title = cleanTitle(row.title || '');
    const content = String(row.content || '');
    const url = String(row.url || '');
    const text = `${title}\n${content}`;

    if (!title || !url || isArticlePage(title, url)) continue;

    const location = extractAddress(text);
    if (area && (!location || !matchesArea(location, area))) continue;

    const name = extractFacilityName(title, content);
    if (!name || !isPlausibleFacilityName(name)) continue;

    const signals = countFacilitySignals(text);
    if (signals < 4) continue;
    if (!containsName(content, name)) continue;

    const info = extractInfo(text);

    // 価格条件が指定されている場合は、
    // 「料金を確認できた施設」だけを候補にする。
    if (priceLimit != null) {
      if (!info.priceVerified || info.price == null) continue;
      if (info.price > priceLimit) continue;
    }

    const normalized = normalize(name);
    const candidate = {
      name,
      url,
      snippet: makeSnippet(content),
      score: Number(row.score || 0),
      verified: true,
      facilityConfidence: Math.min(100, 55 + signals * 8),
      address: location || null,
      ...info
    };

    const existing = groups.get(normalized);
    if (!existing || candidateQuality(candidate) > candidateQuality(existing)) {
      groups.set(normalized, candidate);
    }
  }

  return [...groups.values()]
    .sort((a, b) => candidateQuality(b) - candidateQuality(a))
    .slice(0, 8);
}

function detectPriceLimit(query) {
  const q = String(query);

  if (/気にしない|価格.*(指定なし|なし)|料金.*(指定なし|なし)/i.test(q)) return null;

  const m = q.match(/(?:〜|～|以下|以内)\s*([0-9,]+)\s*円?/);
  if (m) return Number(m[1].replace(/,/g, ''));

  // UIの「〜1,500円」のような表記にも対応。
  const m2 = q.match(/([0-9]{3,5})\s*円/);
  if (m2) return Number(m2[1].replace(/,/g, ''));

  return null;
}

function detectArea(query) {
  const q = String(query);
  if (/東京23区外|東京都下|多摩/.test(q)) return 'tokyoOutside23';
  if (/東京23区|東京都23区|23区/.test(q)) return 'tokyo23';
  if (/神奈川|横浜|川崎/.test(q)) return 'kanagawa';
  if (/埼玉/.test(q)) return 'saitama';
  if (/千葉/.test(q)) return 'chiba';
  return null;
}

function matchesArea(address, area) {
  const a = String(address || '');
  const wards = /(千代田|中央|港|新宿|文京|台東|墨田|江東|品川|目黒|大田|世田谷|渋谷|中野|杉並|豊島|北区|荒川|板橋|練馬|足立|葛飾|江戸川)/;

  if (area === 'tokyo23') return /東京都/.test(a) && wards.test(a);
  if (area === 'tokyoOutside23') return /東京都/.test(a) && !wards.test(a);
  if (area === 'kanagawa') return /神奈川県/.test(a);
  if (area === 'saitama') return /埼玉県/.test(a);
  if (area === 'chiba') return /千葉県/.test(a);
  return true;
}

function cleanTitle(title) {
  return String(title)
    .replace(/^\s*[🥇🥈🥉①②③④⑤⑥⑦⑧⑨⑩]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isArticlePage(title, url) {
  const t = String(title);
  const u = String(url);

  if (/(\/category\/|\/ranking\/|\/feature\/|\/column\/|\/magazine\/|\/news\/|\/blog\/|\/articles?\/|\/matome\/)/i.test(u)) return true;

  if (/(\d+\s*(選|件)|ランキング|まとめ|おすすめ|編集部|ユーザーが選んだ|特集|徹底解説|完全ガイド|一覧|比較|紹介|人気|ベスト|TOP\s*\d+|個性派|外気浴ができる|サウナ施設|サウナスポット|東京の|都内の|関東の|全国の|〜できる|できるサウナ)/i.test(t)) return true;

  return false;
}

function extractFacilityName(title, content) {
  const t = String(title).replace(/\s+/g, ' ').trim();

  const parts = t
    .split(/\s*[|｜]\s*|\s+[—–]\s+|\s*[：:]\s*/)
    .map(x => x.trim())
    .filter(Boolean);

  const titleCandidates = [];
  if (parts.length) titleCandidates.push(parts[0]);
  if (parts.length > 1) titleCandidates.push(...parts.slice(0, 2));

  for (const c of titleCandidates) {
    const cleaned = stripMetadata(c);
    if (isStrongFacilityName(cleaned)) return cleaned;
  }

  const patterns = [
    /(?:施設名|店舗名|店名)\s*[:：]\s*([^\n。|｜]{2,50})/i,
    /(?:名称|サウナ名)\s*[:：]\s*([^\n。|｜]{2,50})/i
  ];

  for (const re of patterns) {
    const m = String(content).match(re);
    if (m && isStrongFacilityName(stripMetadata(m[1]))) return stripMetadata(m[1]);
  }

  return '';
}

function stripMetadata(s) {
  return String(s)
    .replace(/\s*(?:住所|所在地|〒|電話|TEL|営業時間|営業|料金|入浴料|入館料|アクセス|最寄駅|駐車場|口コミ|評判|公式サイト).*$/i, '')
    .replace(/\s*[📍🏢☎️⏰💰🚃🚗].*$/u, '')
    .replace(/\s*\([^)]*(?:住所|料金|営業時間|アクセス)[^)]*\).*$/i, '')
    .replace(/^\s*(公式|公式サイト)\s*/i, '')
    .trim();
}

function isStrongFacilityName(name) {
  const x = String(name || '').replace(/\s+/g, ' ').trim();
  if (!isPlausibleFacilityName(x)) return false;

  if (/(東京|東京都|都内|関東|全国)\s*(の|で|に|が)?\s*(サウナ|スパ|銭湯|温泉|水風呂|外気浴)|サウナ\s*施設|サウナ\s*スポット/i.test(x)) return false;
  if (/^(サウナ|SAUNA|スパ|SPA|銭湯|温泉|浴場|おふろ|湯|施設|店舗)$/i.test(x)) return false;

  const facilityWord = /(サウナ|SAUNA|スパ|SPA|銭湯|温浴|温泉|浴場|おふろ|湯|カプセル|ホテル|センター|ランド|リゾート|湯屋)/i.test(x);
  const genericPhrase = /(できる|したい|した人|おすすめ|人気|ランキング|まとめ|選|件|比較|紹介|特集|一覧|東京の|都内の|全国の|関東の)/i.test(x);

  if (genericPhrase) return false;

  return facilityWord || (x.length <= 18 && /^[\p{L}\p{N}ー・\- ]+$/u.test(x));
}

function isPlausibleFacilityName(s) {
  const x = String(s || '').replace(/\s+/g, ' ').trim();
  if (x.length < 2 || x.length > 40) return false;
  if (/\d+\s*(選|件)/i.test(x)) return false;
  if (/(ランキング|まとめ|おすすめ|編集部|特集|一覧|比較|紹介|人気|TOP\s*\d+)/i.test(x)) return false;
  return true;
}

function countFacilitySignals(text) {
  const signals = [
    /住所|所在地|〒\s*\d{3}-?\d{4}/i,
    /営業時間|営業日|定休日|\d{1,2}:\d{2}/i,
    /料金|入浴料|入館料|\d{3,5}\s*円/i,
    /アクセス|最寄駅|徒歩\s*\d+分/i,
    /電話|TEL|\d{2,4}-\d{2,4}-\d{3,4}/i,
    /サウナ|水風呂|外気浴|ロウリュ/i
  ];
  return signals.filter(re => re.test(text)).length;
}

function containsName(content, name) {
  const n = normalize(name);
  const c = normalize(content);
  return c.includes(n);
}

function extractAddress(text) {
  const s = String(text).replace(/\s+/g, ' ');
  const patterns = [
    /(東京都\s*(?:[\p{L}ー]+区)[^。\n|｜]{0,45})/u,
    /(神奈川県[^。\n|｜]{0,45})/u,
    /(埼玉県[^。\n|｜]{0,45})/u,
    /(千葉県[^。\n|｜]{0,45})/u,
    /(静岡県[^。\n|｜]{0,45})/u,
    /(茨城県[^。\n|｜]{0,45})/u,
    /(栃木県[^。\n|｜]{0,45})/u,
    /(群馬県[^。\n|｜]{0,45})/u
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1].trim();
  }

  return null;
}

/*
 * 料金は「文章中で最初に見つかった○○円」を採用しない。
 *
 * price:
 *   サウナを実際に利用するための最低料金
 *
 * priceLabel:
 *   UIに表示する料金の説明
 *
 * priceType:
 *   時間制 / 入浴+サウナ / サウナ利用 / フリー / その他
 *
 * priceVerified:
 *   料金の意味まで確認できた場合のみ true
 */
function extractInfo(text) {
  const t = String(text).replace(/\s+/g, ' ');

  const heat = firstNumber(t, /(?:サウナ(?:室)?|高温サウナ)[^。]{0,45}?(\d{2,3})\s*℃/i);
  const cold = firstNumber(t, /(?:水風呂|水浴)[^。]{0,45}?(\d{1,2})\s*℃/i);

  const pricing = extractMinimumSaunaPrice(t);

  const outdoor = /外気浴|外気スペース|外気休憩/i.test(t);
  const type =
    /スチーム|ミスト/i.test(t) && !/ドライ|高温サウナ/i.test(t)
      ? '湿式'
      : (/ドライ|高温サウナ/i.test(t) ? '乾式' : '不明');

  const loyly = [];
  if (/セルフロウリュ/i.test(t)) loyly.push('セルフロウリュ');
  if (/オートロウリュ/i.test(t)) loyly.push('オートロウリュ');
  if (/アウフグース|熱波/i.test(t)) loyly.push('アウフグース');

  return {
    heat: heat || null,
    cold: cold || null,
    price: pricing.price,
    priceLabel: pricing.label,
    priceType: pricing.type,
    priceDuration: pricing.duration,
    priceVerified: pricing.verified,
    outdoor,
    type,
    loyly
  };
}

function extractMinimumSaunaPrice(text) {
  const t = String(text).replace(/\s+/g, ' ');
  const candidates = [];

  // 1) 時間制料金：
  // 「60分 1,600円」「1時間 1600円」「90分/2,000円」など。
  const timed = /(?:(\d{1,3})\s*分|(\d{1,2}(?:\.\d+)?)\s*時間)\s*(?:コース|利用|プラン|料金)?\s*[:：]?\s*(?:[^\d]{0,12})?(\d{3,5})\s*円/gi;
  let m;
  while ((m = timed.exec(t))) {
    const minutes = m[1] ? Number(m[1]) : Math.round(Number(m[2]) * 60);
    const price = Number(m[3]);
    if (minutes >= 30 && minutes <= 1440 && price >= 300 && price <= 30000 && !nearExcludedPriceContext(t, m.index)) {
      candidates.push({
        price,
        duration: `${minutes >= 60 ? formatHours(minutes) : minutes + '分'}`,
        type: '時間制',
        label: `${minutes >= 60 ? formatHours(minutes) : minutes + '分'} ${price.toLocaleString()}円〜`,
        verified: true
      });
    }
  }

  // 2) 明示的なサウナ利用料金：
  // 「サウナ料金 1,500円」「サウナ利用 1500円」など。
  const saunaFee = /(?:サウナ(?:利用|料金|代|料)|サウナ入館料|サウナコース|サウナプラン)[^。]{0,25}?(\d{3,5})\s*円/gi;
  while ((m = saunaFee.exec(t))) {
    const price = Number(m[1]);
    if (price >= 300 && price <= 30000 && !nearExcludedPriceContext(t, m.index)) {
      candidates.push({
        price,
        duration: null,
        type: 'サウナ利用',
        label: `サウナ利用 ${price.toLocaleString()}円〜`,
        verified: true
      });
    }
  }

  // 3) 「入浴料550円＋サウナ300円」のような銭湯型。
  const bathPlusSauna = /(?:入浴料|入浴料金|入館料|大人(?:料金)?)[^。]{0,25}?(\d{3,5})\s*円[^。]{0,20}?(?:\+|＋|と|、|及び|＆|&)[^。]{0,20}?(?:サウナ(?:料金|利用|代|料)?)[^。]{0,10}?(\d{3,5})\s*円/gi;
  while ((m = bathPlusSauna.exec(t))) {
    const bath = Number(m[1]);
    const sauna = Number(m[2]);
    const total = bath + sauna;
    if (total >= 500 && total <= 30000 && !nearExcludedPriceContext(t, m.index)) {
      candidates.push({
        price: total,
        duration: null,
        type: '入浴＋サウナ',
        label: `入浴＋サウナ ${total.toLocaleString()}円〜`,
        verified: true
      });
    }
  }

  // 4) 「入浴＋サウナ 1,200円」「入館（サウナ含む）1,500円」など。
  const included = /(?:入浴\s*[＋+&＆]\s*サウナ|入浴＋サウナ|入館料?\s*(?:サウナ込み|サウナ含む)|サウナ込み|サウナ含む)[^。]{0,20}?(\d{3,5})\s*円/gi;
  while ((m = included.exec(t))) {
    const price = Number(m[1]);
    if (price >= 500 && price <= 30000 && !nearExcludedPriceContext(t, m.index)) {
      candidates.push({
        price,
        duration: null,
        type: '入浴＋サウナ',
        label: `入浴＋サウナ ${price.toLocaleString()}円〜`,
        verified: true
      });
    }
  }

  // 5) 「フリータイム 3,000円」「入館 2,500円」など。
  const general = /(?:フリータイム|フリー|一般料金|通常料金|大人料金|入館料|入館料金)[^。]{0,25}?(\d{3,5})\s*円/gi;
  while ((m = general.exec(t))) {
    const price = Number(m[1]);
    if (price >= 500 && price <= 30000 && !nearExcludedPriceContext(t, m.index)) {
      candidates.push({
        price,
        duration: '時間制限なし',
        type: 'フリー',
        label: `フリー ${price.toLocaleString()}円〜`,
        verified: true
      });
    }
  }

  // 「料金 1,500円」だけでは何の料金か不明なので、採用しない。
  // タオル、岩盤浴、食事、延長、会員、子供料金なども最低利用料金にはしない。
  if (!candidates.length) {
    return { price: null, label: '料金未確認', type: '不明', duration: null, verified: false };
  }

  candidates.sort((a, b) => a.price - b.price);
  const best = candidates[0];

  return {
    price: best.price,
    label: best.label,
    type: best.type,
    duration: best.duration,
    verified: true
  };
}

function nearExcludedPriceContext(text, index) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 100);
  const ctx = text.slice(start, end);

  return /(延長|追加料金|追加|会員|メンバー|子供|小人|学生|タオル|レンタル|岩盤浴|食事|ドリンク|マッサージ|駐車場|クーポン|割引|ポイント)/i.test(ctx);
}

function formatHours(minutes) {
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function firstNumber(text, re) {
  const m = String(text).match(re);
  if (!m) return null;
  for (let i = 1; i < m.length; i++) {
    if (m[i]) return Number(m[i]);
  }
  return null;
}

function candidateQuality(c) {
  return (
    (c.facilityConfidence || 0) +
    (c.address ? 15 : 0) +
    (c.priceVerified ? 15 : -20) +
    (c.heat != null ? 3 : 0) +
    (c.cold != null ? 3 : 0) +
    (c.loyly?.length ? 2 : 0)
  );
}

function makeSnippet(content) {
  const s = String(content).replace(/\s+/g, ' ').trim();
  return s.length > 180 ? s.slice(0, 177) + '…' : s;
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[\s　・「」『』（）()\-ー]/g, '');
}
