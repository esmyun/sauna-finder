// Vercel Serverless Function
// Set TAVILY_API_KEY in the deployment environment.
// Tavily's current free plan provides 1,000 API credits/month with no credit card required.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});
  const key = process.env.TAVILY_API_KEY;
  if (!key) return res.status(503).json({error:"TAVILY_API_KEY is not configured"});
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const query = String(body?.query || "").trim();
    if (!query) return res.status(400).json({error:"query required"});
    const response = await fetch("https://api.tavily.com/search", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        api_key:key,
        query,
        search_depth:"basic",
        max_results:8,
        include_answer:false
      })
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({error:"Tavily error", detail:text});
    }
    const data = await response.json();
    return res.status(200).json({results:(data.results||[]).map(x=>({
      title:x.title, url:x.url, content:x.content, score:x.score
    }))});
  } catch(e) {
    return res.status(500).json({error:"Search failed", detail:String(e)});
  }
}
