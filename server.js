const express = require("express");
const Parser = require("rss-parser");
const path = require("path");

const app = express();
const parser = new Parser({
  timeout: 10000,
  customFields: { item: [["media:content", "mediaContent", { keepArray: false }], ["media:thumbnail", "mediaThumb"]] }
});

const FEEDS = [
  { source: "Anvisa", url: "https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/RSS" },
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

let cache = { at: 0, news: [] };

async function loadAll() {
  if (Date.now() - cache.at < 10 * 60 * 1000 && cache.news.length) return cache.news;
  const res = await Promise.all(FEEDS.map(async f => {
    try {
      const feed = await parser.parseURL(f.url);
      return feed.items.slice(0, 10).map(i => ({
        title: i.title, link: i.link, image: imageOf(i),
        date: i.isoDate || i.pubDate || "", source: f.source
      }));
    } catch (e) { console.error(f.source, e.message); return []; }
  }));
  cache = { at: Date.now(), news: [].concat(...res).sort((a, b) => new Date(b.date) - new Date(a.date)) };
  return cache.news;
}

app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });

app.get("/api/news", async (req, res) => {
  try {
    const cat = String(req.query.category || "todas").toLowerCase();
    let news = await loadAll();
    if (CATS[cat]) news = news.filter(n => CATS[cat].test(n.title + " " + n.source));
    res.json({ success: true, news });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// opcional: serve o index.html do app na mesma pasta do servidor
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Pharmaxy News rodando na porta " + PORT));
