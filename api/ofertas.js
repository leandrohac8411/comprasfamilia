// Função da Vercel: busca ofertas do Atacadão e do Dia a Dia para os itens da lista.
// GET /api/ofertas?itens=Arroz|Feijão&cep=73082200&regiao=DF&loja=Sobradinho
// Nada aqui é API oficial dos mercados: são as mesmas consultas públicas que os sites usam.
import { getDocumentProxy } from "unpdf";

const UA = "Mozilla/5.0 (compatible; MinhasCompras/1.0)";
const TTL = 30 * 60 * 1000;
const memo = new Map();

async function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await fn();
  memo.set(key, {at: Date.now(), value});
  return value;
}

const norm = text => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(["de","da","do","das","dos","para","com","sem","em","no","na","nos","nas","os","as","um","uma","tipo","casa","escola","lanche","meninos","meninas","filhos"]);
const words = text => norm(text).split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w));
const decode = html => String(html || "")
  .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const cents = value => Number.isFinite(value) ? Math.round(value * 100) : null;

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {"user-agent": UA, accept: "application/json"},
    redirect: "follow",
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, list.length)}, async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await fn(list[index]).catch(error => ({error: String(error.message || error)}));
    }
  }));
  return out;
}

/* ---------- Atacadão (loja online, preço da região do CEP) ---------- */
const ATACADAO = "https://www.atacadao.com.br";

function atacadaoRegion(cep) {
  if (!cep) return Promise.resolve(null);
  return cached("regiao:" + cep, async () => {
    const data = await getJSON(`${ATACADAO}/api/checkout/pub/regions?country=BRA&postalCode=${cep}&sc=1`);
    return data?.[0]?.id || null;
  });
}

async function atacadaoSearch(term, regionId) {
  return cached(`busca:${regionId}:${norm(term)}`, async () => {
    const url = new URL(`${ATACADAO}/api/io/_v/api/intelligent-search/product_search/`);
    url.searchParams.set("query", term);
    url.searchParams.set("count", "4");
    url.searchParams.set("page", "1");
    url.searchParams.set("locale", "pt-BR");
    url.searchParams.set("hideUnavailableItems", "true");
    if (regionId) url.searchParams.set("regionId", regionId);
    const data = await getJSON(url);
    return (data.products || []).map(product => {
      const item = product.items?.[0];
      const seller = item?.sellers?.find(s => s.commertialOffer?.AvailableQuantity > 0) || item?.sellers?.[0];
      const offer = seller?.commertialOffer || {};
      const price = cents(offer.Price);
      const listPrice = Math.max(price || 0, cents(offer.ListPrice) || 0, cents(offer.PriceWithoutDiscount) || 0);
      return {
        name: product.productName,
        price,
        listPrice,
        promo: !!price && listPrice > price,
        link: ATACADAO + (product.link || ""),
        image: item?.images?.[0]?.imageUrl || null
      };
    }).filter(result => result.price > 0);
  });
}

/* ---------- Dia a Dia (encartes por região e loja) ---------- */
const DIAADIA = "https://ofertas.diaadiaatacadista.com.br";

async function diaadiaCampaigns(regiao, loja) {
  const list = await cached("dd:campanhas", () =>
    getJSON(`${DIAADIA}/wp-json/wp/v2/ofertas?per_page=40&_fields=id,date,link,title,acf`));
  const since = Date.now() - 10 * 24 * 60 * 60 * 1000;
  return list
    .filter(item => new Date(item.date).getTime() >= since)
    .filter(item => (item.acf?.regiao || []).includes(regiao))
    .filter(item => {
      const stores = item.acf?.["segmentacao_" + regiao.toLowerCase()] || [];
      return !loja || !stores.length || stores.some(store => norm(store).includes(norm(loja)));
    })
    .map(item => {
      const flyers = Array.isArray(item.acf?.tabloide) ? item.acf.tabloide : [];
      return {
        id: item.id,
        title: decode(item.title?.rendered),
        date: item.date,
        link: item.link,
        pdfs: flyers.map(f => f.pdf_do_tabloide).filter(Boolean),
        pages: flyers.flatMap(f => f.paginas_do_tabloide || [])
      };
    });
}

// Lê os textos do PDF do encarte (nomes dos produtos).
function pdfLines(url) {
  return cached("pdf:" + url, async () => {
    const response = await fetch(url, {headers: {"user-agent": UA}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("HTTP " + response.status);
    const pdf = await getDocumentProxy(new Uint8Array(await response.arrayBuffer()));
    const lines = [];
    for (let page = 1; page <= Math.min(pdf.numPages, 12); page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      content.items.forEach(item => {
        const text = String(item.str || "").replace(/\s+/g, " ").trim();
        if (text) lines.push(text);
      });
    }
    return lines;
  });
}

// Procura cada item da lista nos textos do encarte.
// A 1ª palavra do item precisa estar no nome do produto; a 2ª (se houver) também.
function matchFlyer(terms, campaign, lines) {
  const normalized = lines.map(norm);
  const has = (text, word) => new RegExp(`(^|[^a-z0-9])${word}`).test(text);
  const found = [];
  terms.forEach(term => {
    const [main, second] = words(term);
    if (!main) return;
    const seen = new Set();
    normalized.forEach((line, index) => {
      if (!has(line, main)) return;
      // nome do produto às vezes vem quebrado em duas linhas
      let text = lines[index];
      const next = lines[index + 1];
      if (next && !/^r\$/i.test(next) && !/cada/i.test(next) && next.length < 40) text += " " + next;
      if (second && !has(norm(text), second)) return;
      const key = norm(text);
      if (seen.has(key) || seen.size >= 3) return;
      seen.add(key);
      found.push({term, product: text, campaign: campaign.title, link: campaign.link, page: campaign.pages[0] || null});
    });
  });
  return found;
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const terms = [...new Set(String(params.get("itens") || "").split("|").map(t => t.trim()).filter(Boolean))].slice(0, 40);
  const cep = String(params.get("cep") || "").replace(/\D/g, "").slice(0, 8);
  const regiao = ["DF", "GO", "TO", "BA"].includes(params.get("regiao")) ? params.get("regiao") : "DF";
  const loja = String(params.get("loja") || "").trim().slice(0, 40);

  const atacadao = (async () => {
    const regionId = await atacadaoRegion(cep).catch(() => null);
    const results = await mapLimit(terms, 6, term => atacadaoSearch(term, regionId));
    return {
      regional: !!regionId,
      items: terms.map((term, index) => Array.isArray(results[index])
        ? {term, results: results[index]}
        : {term, results: [], error: results[index]?.error})
    };
  })().catch(error => ({error: String(error.message || error), items: []}));

  const diaadia = (async () => {
    const campaigns = await diaadiaCampaigns(regiao, loja);
    const matches = [];
    await mapLimit(campaigns, 3, async campaign => {
      for (const pdf of campaign.pdfs.slice(0, 2)) {
        const lines = await pdfLines(pdf);
        matches.push(...matchFlyer(terms, campaign, lines));
      }
    });
    return {campaigns: campaigns.map(({pdfs, ...rest}) => rest), matches};
  })().catch(error => ({error: String(error.message || error), campaigns: [], matches: []}));

  const body = {
    updatedAt: new Date().toISOString(),
    cep, regiao, loja,
    atacadao: await atacadao,
    diaadia: await diaadia
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
  res.statusCode = 200;
  res.end(JSON.stringify(body));
}
