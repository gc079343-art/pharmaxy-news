const express = require("express");
const Parser = require("rss-parser");
const path = require("path");

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; PharmaxyNews/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" },
  customFields: { item: [["media:content", "mediaContent", { keepArray: false }], ["media:thumbnail", "mediaThumb"]] }
});

const FEEDS = [
  { source: "Agência Brasil", url: "https://agenciabrasil.ebc.com.br/rss/saude/feed.xml" },
  { source: "g1 Saúde", url: "https://g1.globo.com/rss/g1/saude/" }
];

const CATS = {
  farmacologia: /farmacolog|farm[aá]c|princ[ií]pio ativo|dose|tratamento|terapia/i,
  medicamentos: /medicament|rem[eé]dio|f[aá]rmaco|receita|bula|gen[eé]rico|antibi[oó]tic|vacina|insulina/i,
  anvisa: /anvisa|vigil[aâ]ncia sanit/i,
  pesquisas: /pesquisa|estudo|cient|descoberta|ensaio cl[ií]nico|universidade/i,
  hospitalar: /hospital|\buti\b|interna[cç]|cl[ií]nic|sus\b/i
};

function imageOf(i) {
  if (i.enclosure && i.enclosure.url && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(i.enclosure.url)) return i.enclosure.url;
  if (i.mediaContent && i.mediaContent.$ && i.mediaContent.$.url) return i.mediaContent.$.url;
  if (i.mediaThumb && i.mediaThumb.$ && i.mediaThumb.$.url) return i.mediaThumb.$.url;
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(i["content:encoded"] || i.content || "");
  return m ? m[1] : "";
}

async function readFeed(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PharmaxyNews/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" }
    });
    if (!r.ok) throw new Error("Status code " + r.status);
    return await parser.parseString(await r.text()); // fetch já descompacta gzip
  } finally { clearTimeout(t); }
}

const lastGood = {}; // guarda a última leitura boa de cada fonte

const isLogo = u => !u || /logo|\.svg(\?|$)/i.test(u);

async function ogImage(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 PharmaxyNews" } });
    clearTimeout(t);
    const html = (await r.text()).slice(0, 200000);
    const m = /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
           || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i.exec(html);
    return m && !isLogo(m[1]) ? m[1] : "";
  } catch (e) { return ""; }
}

let cache = { at: 0, news: [], errors: {} };

async function loadAll() {
  if (Date.now() - cache.at < 10 * 60 * 1000 && cache.news.length) return cache.news;
  const errors = {};
  const res = await Promise.all(FEEDS.map(async f => {
    try {
      const feed = await readFeed(f.url);
      const items = feed.items.slice(0, 10).map(i => ({
        title: i.title, link: i.link, image: imageOf(i),
        date: i.isoDate || i.pubDate || "", source: f.source
      }));
      lastGood[f.source] = items;
      return items;
    } catch (e) { console.error(f.source, e.message); errors[f.source] = e.message; return lastGood[f.source] || []; }
  }));
  const news = [].concat(...res).sort((a, b) => new Date(b.date) - new Date(a.date));
  await Promise.all(news.map(async n => {
    if (isLogo(n.image)) n.image = n.link ? await ogImage(n.link) : "";
  }));
  cache = { at: Date.now(), news, errors };
  return cache.news;
}

app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });

app.get("/api/news", async (req, res) => {
  try {
    const cat = String(req.query.category || "todas").toLowerCase();
    let news = await loadAll();
    if (CATS[cat]) news = news.filter(n => CATS[cat].test(n.title + " " + n.source));
    res.json({ success: true, news, errors: cache.errors });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// opcional: serve o index.html do app na mesma pasta do servidor
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Pharmaxy News rodando na porta " + PORT));
