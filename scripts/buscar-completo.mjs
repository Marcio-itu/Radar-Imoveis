// scripts/buscar-completo.mjs
//
// VERSÃO FINAL - COMPLETA E REVISADA
// ✅ ID único por imóvel
// ✅ Data de publicação (6 meses de validade)
// ✅ Busca prioritária no portal Kenlo
// ✅ Fallback para outras fontes
// ✅ Sem mistura de fotos

import { readFile, writeFile } from "node:fs/promises";

// ============================================================
// UTILITÁRIOS
// ============================================================

function limparTexto(txt) {
  return (txt || "").replace(/\s+/g, " ").trim();
}

function removerTags(html) {
  return (html || "").replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ");
}

function pareceCodigoVazado(texto) {
  return /class=|onfocus=|onclick=|&quot;|function\s*\(|\$\(this\)|span_maximo|span_minimo|\.val\(|botoes_selected/i.test(texto);
}

function tituloSeguro(candidato) {
  if (candidato && !pareceCodigoVazado(candidato)) return candidato;
  return "";
}

function extrairPreco(texto) {
  let m = texto.match(/R\$\s?[\d.,]+/);
  if (m) return m[0];
  m = texto.match(/valor[: ]+R\$\s?[\d.,]+/i);
  if (m) return m[0].replace(/valor[: ]+/i, "").trim();
  if (/sob consulta/i.test(texto)) return "Sob consulta";
  return "";
}

function extrairQuartos(texto) {
  const m = texto.match(/(\d+)\s*(dormit[oó]rio|quarto)/i);
  return m ? m[1] : "";
}

function extrairArea(texto) {
  const m = texto.match(/(\d+[.,]?\d*)\s*m²/);
  return m ? m[1] : "";
}

function extrairVagas(texto) {
  const m = texto.match(/(\d+)\s*vagas?/i);
  return m ? m[1] : "";
}

function extrairSuites(texto) {
  const m = texto.match(/(\d+)\s*su[ií]tes?/i);
  return m ? m[1] : "";
}

function extrairTipo(texto, href) {
  const alvo = (texto + " " + href).toLowerCase();
  if (/apartamento|apto\b/.test(alvo)) return "apartamento";
  if (/\bcasa\b/.test(alvo)) return "casa";
  if (/terreno|lote\b/.test(alvo)) return "terreno";
  if (/galp[aã]o/.test(alvo)) return "galpão";
  if (/\bsala\b/.test(alvo)) return "sala comercial";
  if (/comercial/.test(alvo)) return "comercial";
  return "";
}

function extrairFinalidade(texto) {
  const temVenda = /\bvenda\b/i.test(texto);
  const temAluguel = /\balug|loca[cç][aã]o/i.test(texto);
  if (temVenda && temAluguel) return "venda e aluguel";
  if (temVenda) return "venda";
  if (temAluguel) return "aluguel";
  return "";
}

// ============================================================
// DATA DE PUBLICAÇÃO (COM FALLBACK)
// ============================================================

function extrairDataPublicacao(texto) {
  if (!texto) return null;
  
  // Padrão 1: "Publicado há X dias"
  let match = texto.match(/publicado\s*há\s*(\d+)\s*dias?/i);
  if (match) {
    const dias = parseInt(match[1]);
    const data = new Date();
    data.setDate(data.getDate() - dias);
    return data.toISOString().split('T')[0];
  }
  
  // Padrão 2: "Publicado há X meses"
  match = texto.match(/publicado\s*há\s*(\d+)\s*meses?/i);
  if (match) {
    const meses = parseInt(match[1]);
    const data = new Date();
    data.setMonth(data.getMonth() - meses);
    return data.toISOString().split('T')[0];
  }
  
  // Padrão 3: "Anunciado em DD/MM/AAAA"
  match = texto.match(/anunciado\s*em\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
  
  // Padrão 4: "Há X dias"
  match = texto.match(/há\s*(\d+)\s*dias?/i);
  if (match) {
    const dias = parseInt(match[1]);
    const data = new Date();
    data.setDate(data.getDate() - dias);
    return data.toISOString().split('T')[0];
  }
  
  // Padrão 5: Data em formato DD/MM/AAAA
  match = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
  
  return null;
}

function imovelEstaAtivo(dataPublicacao, diasMaximo = 180) {
  if (!dataPublicacao) return false;
  
  const hoje = new Date();
  const data = new Date(dataPublicacao);
  const diffTime = hoje - data;
  const diffDias = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return diffDias <= diasMaximo;
}

// ============================================================
// ID ÚNICO DO IMÓVEL
// ============================================================

function gerarIdImovel(link) {
  let linkLimpo = link.replace(/\?from=.*$/, '').replace(/\/$/, '');
  const partes = linkLimpo.split('/');
  let id = partes[partes.length - 1];
  if (!id || id.length < 3) {
    id = linkLimpo.split('/').slice(-2).join('-');
  }
  return id;
}

// ============================================================
// IMAGENS
// ============================================================

function resolverUrlImagem(url, baseUrl) {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) {
    const base = new URL(baseUrl);
    return base.origin + url;
  }
  return url;
}

const PADRAO_IMAGEM_INVALIDA = /logo|icone|icon|avatar|placeholder|spinner|loading|lazy|blank|pixel|\.svg|1x1/i;

function buscarImagensEmTrecho(trechoHtml) {
  const padroes = [
    /<img[^>]+src=["']([^"']+)["']/gi,
    /<img[^>]+data-src=["']([^"']+)["']/gi,
    /<img[^>]+srcset=["']([^"',\s]+)/gi
  ];

  const encontradas = [];
  for (const padrao of padroes) {
    for (const m of trechoHtml.matchAll(padrao)) {
      const url = m[1];
      if (url && !PADRAO_IMAGEM_INVALIDA.test(url) && !encontradas.includes(url)) {
        encontradas.push(url);
      }
    }
  }
  return encontradas;
}

function buscarImagensViaJsonLd(html) {
  const encontradas = [];
  const regexBloco = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const m of html.matchAll(regexBloco)) {
    try {
      const dados = JSON.parse(m[1].trim());
      const itens = Array.isArray(dados) ? dados : [dados];
      for (const item of itens) {
        let img = item.image;
        if (!img) continue;
        const lista = Array.isArray(img) ? img : [img];
        for (const entrada of lista) {
          const url = typeof entrada === "string" ? entrada : (entrada && entrada.url);
          if (url && !PADRAO_IMAGEM_INVALIDA.test(url) && !encontradas.includes(url)) {
            encontradas.push(url);
          }
        }
      }
    } catch (e) {}
  }
  return encontradas;
}

function extrairImagensDoCard(cardHtml, baseUrl) {
  const doHtml = buscarImagensEmTrecho(cardHtml);
  const doJsonLd = buscarImagensViaJsonLd(cardHtml);
  const todas = [...new Set([...doJsonLd, ...doHtml])];
  return todas.map(url => resolverUrlImagem(url, baseUrl)).slice(0, 8);
}

function removerScriptsEEstilos(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

const PADRAO_LINK_IMOVEL = 
  /\/imovel(\/|\?)|\/imoveis\/[^"']*\/(\d+)|\/detalhes\/(\d+)|\/propriedade\/(\d+)|\/[a-z-]+\/[a-z-]+\/[a-z-]+\/\d+|CA\d{4}-[A-Z0-9]+|SO\d{4}-[A-Z0-9]+/i;

// ============================================================
// EXTRAÇÃO DE CARDS (COM CAPTURA POR CARD)
// ============================================================

function extrairCards(htmlBruto, baseUrl, nomeFonte) {
  const porId = new Map();
  const html = removerScriptsEEstilos(htmlBruto);

  function capturarCard(html, posicaoLink) {
    const tagsPai = ['<div', '<article', '<li', '<section'];
    let inicioCard = -1;
    let tagFechamento = '';
    
    for (const tag of tagsPai) {
      const idx = html.lastIndexOf(tag, posicaoLink);
      if (idx > inicioCard) {
        inicioCard = idx;
        tagFechamento = tag.replace('<', '</').split(' ')[0] + '>';
      }
    }
    
    if (inicioCard === -1) {
      const inicio = Math.max(0, posicaoLink - 300);
      const fim = Math.min(html.length, posicaoLink + 500);
      return html.slice(inicio, fim);
    }
    
    let fimCard = html.indexOf(tagFechamento, posicaoLink);
    if (fimCard === -1) {
      fimCard = Math.min(html.length, posicaoLink + 2000);
    } else {
      fimCard += tagFechamento.length;
    }
    
    return html.slice(inicioCard, fimCard);
  }

  function registrar(href, candidato) {
    href = href.replace(/\?from=.*$/, '').replace(/\/$/, '');
    const id = gerarIdImovel(href);
    
    const existente = porId.get(id);
    if (existente) {
      if (existente.link !== href) {
        const novoId = id + '-' + href.split('/').pop();
        porId.set(novoId, { ...candidato, id: novoId, link: href });
        return;
      }
      porId.set(id, {
        ...existente,
        ...candidato,
        imagens: existente.imagens.length > 0 ? existente.imagens : candidato.imagens,
        id: id,
      });
      return;
    }
    
    porId.set(id, { ...candidato, id: id });
  }

  const regexLink = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regexLink.exec(html)) !== null) {
    let href = match[1];
    const anchorHtmlBruto = match[2];
    const posicaoLink = match.index;
    const textoLink = limparTexto(removerTags(anchorHtmlBruto));

    if (!PADRAO_LINK_IMOVEL.test(href)) continue;

    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = base.origin + href;
    }

    const cardHtml = capturarCard(html, posicaoLink);
    const textoCard = limparTexto(removerTags(cardHtml));

    // ========== EXTRAI DATA DE PUBLICAÇÃO ==========
    let dataPublicacao = extrairDataPublicacao(textoCard) || extrairDataPublicacao(textoLink);
    if (!dataPublicacao) {
      dataPublicacao = extrairDataPublicacao(cardHtml);
    }

    const imagens = extrairImagensDoCard(cardHtml, baseUrl);
    const preco = extrairPreco(textoCard) || extrairPreco(textoLink);
    const quartos = extrairQuartos(textoCard) || extrairQuartos(textoLink);
    const suites = extrairSuites(textoCard) || extrairSuites(textoLink);
    const vagas = extrairVagas(textoCard) || extrairVagas(textoLink);
    const area = extrairArea(textoCard) || extrairArea(textoLink);
    const bairro = extrairBairro(textoCard) || extrairBairro(textoLink);
    const cidade = extrairCidade(textoCard, href) || extrairCidade(textoLink, href);
    const tipo = extrairTipo(textoCard, href) || extrairTipo(textoLink, href);
    const finalidade = extrairFinalidade(textoCard) || extrairFinalidade(textoLink);

    let titulo = tituloSeguro(textoLink);
    if (!titulo || titulo === "Imóvel" || titulo.length < 5) {
      titulo = tituloSeguro(textoCard);
    }
    if (!titulo || titulo === "Imóvel" || titulo.length < 5) {
      titulo = "Imóvel " + (href.split('/').pop() || '');
    }

    registrar(href, {
      fonte: nomeFonte,
      titulo: titulo,
      imagens: imagens,
      imagem: imagens[0] || "",
      preco: preco,
      quartos: quartos,
      suites: suites,
      vagas: vagas,
      area: area,
      bairro: bairro,
      cidade: cidade,
      tipo: tipo,
      finalidade: finalidade,
      dataPublicacao: dataPublicacao,
      link: href
    });
  }

  return Array.from(porId.values());
}

// ============================================================
// FUNÇÕES DE BAIRRO E CIDADE
// ============================================================

const CIDADES_REGEX_TEXTO = "Itu|Indaiatuba|Salto|Sorocaba|Cabreúva|Cabreuva";

function pareceControleDePagina(texto) {
  return /crescente|decrescente|\d+\s*im[oó]ve(l|is)|ordenar\s*por/i.test(texto);
}

function extrairBairro(texto) {
  let m = texto.match(
    new RegExp(
      `([A-ZÀ-Ú][\\wÀ-ú0-9°º.'\\s]{2,45}?)\\s*[-–]\\s*(?:${CIDADES_REGEX_TEXTO})\\s*[-–]\\s*SP\\b`,
      "i"
    )
  );
  if (m && !pareceControleDePagina(m[1])) return limparTexto(m[1]);

  m = texto.match(
    /(?:bairro|condom[ií]nio|residencial|jardim|parque|vila)\s*:?\s+([A-ZÀ-Ú][\wÀ-ú0-9°º.'\s]{2,40})/i
  );
  if (m && !pareceControleDePagina(m[0])) return limparTexto(m[0]);

  m = texto.match(/(?:em|no|na)\s+([A-ZÀ-Ú][\wÀ-ú\s]{2,40})/);
  if (m && !pareceControleDePagina(m[1])) return limparTexto(m[1]);
  return "";
}

const CIDADES_CONHECIDAS = ["itu", "indaiatuba", "salto", "sorocaba", "cabreúva", "cabreuva"];

function extrairCidade(texto, href) {
  const matchTexto = texto.match(/[-–]\s*([A-ZÀ-Ú][a-zà-ú]+)\s*[\/\-]\s*SP\b/i);
  if (matchTexto) return limparTexto(matchTexto[1]);

  const alvoHref = href.toLowerCase();
  for (const cidade of CIDADES_CONHECIDAS) {
    if (alvoHref.includes("/" + cidade)) {
      return cidade.charAt(0).toUpperCase() + cidade.slice(1);
    }
  }
  return "";
}

// ============================================================
// FETCH: DIRETO + SCRAPINGBEE + FIRECRAWL + SCRAPERAPI
// ============================================================

async function buscarDireto(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    }
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.text();
}

async function buscarScrapingBee(url, apiKey, opcoes = {}) {
  let endpoint =
    "https://app.scrapingbee.com/api/v1/?api_key=" +
    encodeURIComponent(apiKey) +
    "&url=" +
    encodeURIComponent(url) +
    "&render_js=true" +
    "&wait=2500";

  if (opcoes.jsScenario) {
    endpoint += "&js_scenario=" + encodeURIComponent(JSON.stringify(opcoes.jsScenario));
  }

  const resp = await fetch(endpoint);
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    const semCredito =
      resp.status === 402 ||
      resp.status === 401 ||
      resp.status === 429 ||
      /credit|quota|insufficient|limit reached|too many requests|exceeded/i.test(corpo);
    const erro = new Error("ScrapingBee HTTP " + resp.status + " " + corpo.slice(0, 200));
    erro.semCredito = semCredito;
    throw erro;
  }
  return await resp.text();
}

async function buscarFirecrawl(url, apiKey) {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: url,
      formats: ["html"],
      waitFor: 3000,
      onlyMainContent: false
    })
  });

  if (!response.ok) {
    const erro = await response.text().catch(() => "");
    if (response.status === 402 || response.status === 401 || /limit|quota|credit/i.test(erro)) {
      const e = new Error("Firecrawl: sem créditos ou limite atingido");
      e.semCredito = true;
      throw e;
    }
    throw new Error("Firecrawl HTTP " + response.status + " " + erro.slice(0, 200));
  }

  const dados = await response.json();
  if (!dados.success || !dados.data) {
    throw new Error("Firecrawl: resposta inesperada");
  }

  const html = dados.data.html || dados.data.content || "";
  if (!html || html.length < 100) {
    throw new Error("Firecrawl: HTML vazio ou muito curto");
  }

  return html;
}

async function buscarScraperAPI(url, apiKey) {
  const endpoint =
    "http://api.scraperapi.com?api_key=" +
    encodeURIComponent(apiKey) +
    "&url=" +
    encodeURIComponent(url) +
    "&render=true" +
    "&wait=3000" +
    "&country_code=br";

  const resp = await fetch(endpoint);
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    const semCredito =
      resp.status === 402 ||
      resp.status === 401 ||
      resp.status === 429 ||
      /credit|quota|insufficient|limit reached|too many requests|exceeded/i.test(corpo);
    const erro = new Error("ScraperAPI HTTP " + resp.status + " " + corpo.slice(0, 200));
    erro.semCredito = semCredito;
    throw erro;
  }
  return await resp.text();
}

// ============================================================
// BUSCA COM FALLBACK
// ============================================================

async function buscarComJS(url, chaves, opcoes = {}) {
  const { scrapingBeeKeys, firecrawlKey, scraperAPIKey } = chaves;
  
  if (scrapingBeeKeys && scrapingBeeKeys.length > 0) {
    for (let i = 0; i < scrapingBeeKeys.length; i++) {
      try {
        console.log(`  🐝 Tentando ScrapingBee #${i + 1}...`);
        const result = await buscarScrapingBee(url, scrapingBeeKeys[i], opcoes);
        console.log(`  ✅ ScrapingBee #${i + 1} funcionou!`);
        return result;
      } catch (e) {
        if (!e.semCredito) throw e;
        console.log(`  ⚠️ ScrapingBee #${i + 1} sem crédito`);
      }
    }
  }

  if (firecrawlKey) {
    try {
      console.log(`  🔥 Tentando Firecrawl...`);
      const result = await buscarFirecrawl(url, firecrawlKey);
      console.log(`  ✅ Firecrawl funcionou!`);
      return result;
    } catch (e) {
      if (!e.semCredito) throw e;
      console.log(`  ⚠️ Firecrawl sem crédito`);
    }
  }

  if (scraperAPIKey) {
    try {
      console.log(`  🧪 Tentando ScraperAPI...`);
      const result = await buscarScraperAPI(url, scraperAPIKey);
      console.log(`  ✅ ScraperAPI funcionou!`);
      return result;
    } catch (e) {
      if (!e.semCredito) throw e;
      console.log(`  ⚠️ ScraperAPI sem crédito`);
    }
  }

  throw new Error(`Todos os serviços falharam (sem crédito).`);
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// GALERIAS
// ============================================================

async function buscarGaleriaCompletaSemJS(url) {
  try {
    const htmlBruto = await buscarDireto(url);
    const doJsonLd = buscarImagensViaJsonLd(htmlBruto);
    const html = removerScriptsEEstilos(htmlBruto);
    const doHtml = buscarImagensEmTrecho(html);
    const imagens = [...new Set([...doJsonLd, ...doHtml])];
    return imagens.map(u => resolverUrlImagem(u, url)).slice(0, 8);
  } catch (e) {
    return [];
  }
}

async function buscarGaleriaCompletaJS(url, chaves) {
  if (chaves.scrapingBeeKeys && chaves.scrapingBeeKeys.length > 0) {
    for (let i = 0; i < chaves.scrapingBeeKeys.length; i++) {
      try {
        const html = await buscarScrapingBee(url, chaves.scrapingBeeKeys[i], {});
        const doJsonLd = buscarImagensViaJsonLd(html);
        const htmlLimpo = removerScriptsEEstilos(html);
        const doHtml = buscarImagensEmTrecho(htmlLimpo);
        const imagens = [...new Set([...doJsonLd, ...doHtml])];
        if (imagens.length > 0) {
          return imagens.map(u => resolverUrlImagem(u, url)).slice(0, 8);
        }
      } catch (e) {
        if (!e.semCredito) throw e;
      }
    }
  }

  if (chaves.firecrawlKey) {
    try {
      const html = await buscarFirecrawl(url, chaves.firecrawlKey);
      const doJsonLd = buscarImagensViaJsonLd(html);
      const htmlLimpo = removerScriptsEEstilos(html);
      const doHtml = buscarImagensEmTrecho(htmlLimpo);
      const imagens = [...new Set([...doJsonLd, ...doHtml])];
      if (imagens.length > 0) {
        return imagens.map(u => resolverUrlImagem(u, url)).slice(0, 8);
      }
    } catch (e) {
      if (!e.semCredito) throw e;
    }
  }

  if (chaves.scraperAPIKey) {
    try {
      const html = await buscarScraperAPI(url, chaves.scraperAPIKey);
      const doJsonLd = buscarImagensViaJsonLd(html);
      const htmlLimpo = removerScriptsEEstilos(html);
      const doHtml = buscarImagensEmTrecho(htmlLimpo);
      const imagens = [...new Set([...doJsonLd, ...doHtml])];
      if (imagens.length > 0) {
        return imagens.map(u => resolverUrlImagem(u, url)).slice(0, 8);
      }
    } catch (e) {
      if (!e.semCredito) throw e;
    }
  }

  return [];
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 BUSCAR-COMPLETO.MJS - VERSÃO FINAL");
  console.log("   ✅ ID único | ✅ Data de publicação | ✅ Kenlo");
  console.log("=".repeat(60));

  // ========== FONTES ==========
  // PRIORIDADE: Kenlo (portal geral) primeiro
  const fontes = [
    {
      nome: "Kenlo - Portal Geral",
      url: "https://portal.kenlo.com.br/imoveis/a-venda/itu",
      jsNecessario: true,
      prioridade: 1
    },
    ...JSON.parse(await readFile(new URL("../fontes.json", import.meta.url), "utf-8"))
      .filter(f => f.nome !== "Kenlo - Portal Geral")
  ];

  // Cache de galerias
  const cacheGaleria = new Map();
  try {
    const anteriorRaw = await readFile(new URL("../imoveis.json", import.meta.url), "utf-8");
    const anterior = JSON.parse(anteriorRaw);
    for (const item of anterior.imoveis || []) {
      if (item.galeriaCompleta && item.link && item.imagens && item.imagens.length > 0) {
        cacheGaleria.set(item.link, item.imagens.slice(0, 8));
      }
    }
    console.log(`📦 Cache de galerias: ${cacheGaleria.size} imóveis`);
  } catch (e) {
    console.log("📦 Sem cache - primeira execução.");
  }

  // ========== CHAVES ==========
  const scrapingBeeKeys = [
    process.env.SCRAPINGBEE_API_KEY,
    process.env.SCRAPINGBEE_API_KEY_2,
    process.env.SCRAPINGBEE_API_KEY_3,
  ].filter(Boolean);

  const firecrawlKey = process.env.FIRECRAWL_API_KEY || "";
  const scraperAPIKey = process.env.SCRAPERAPI_API_KEY || "";

  console.log(`\n🔑 CHAVES CONFIGURADAS:`);
  console.log(`  🐝 ScrapingBee: ${scrapingBeeKeys.length} chave(s)`);
  console.log(`  🔥 Firecrawl: ${firecrawlKey ? "✅ Configurado" : "❌ Não configurado"}`);
  console.log(`  🧪 ScraperAPI: ${scraperAPIKey ? "✅ Configurado" : "❌ Não configurado"}`);

  const chaves = { scrapingBeeKeys, firecrawlKey, scraperAPIKey };

  const todos = [];
  const erros = [];
  const DIAS_MAXIMO = 180; // 6 meses

  for (const fonte of fontes) {
    console.log(`\n📡 Buscando: ${fonte.nome} (${fonte.url})${fonte.jsNecessario ? " [via JS]" : ""}`);

    try {
      let html;

      if (fonte.jsNecessario) {
        const temAlgumaChave = scrapingBeeKeys.length > 0 || firecrawlKey || scraperAPIKey;
        if (!temAlgumaChave) {
          console.warn(`  ⚠️ Nenhuma chave configurada`);
          erros.push(`${fonte.nome}: sem chave`);
          continue;
        }
        html = await buscarComJS(fonte.url, chaves);
      } else {
        html = await buscarDireto(fonte.url);
      }

      const itens = extrairCards(html, fonte.url, fonte.nome);
      
      // Filtra por data de publicação
      let ativos = 0;
      let removidos = 0;
      
      for (const item of itens) {
        // Se tem data e está ativo, mantém
        if (item.dataPublicacao) {
          if (imovelEstaAtivo(item.dataPublicacao, DIAS_MAXIMO)) {
            item._semJS = !fonte.jsNecessario;
            todos.push(item);
            ativos++;
          } else {
            removidos++;
            console.log(`  🗑️ Removido (mais de 6 meses): ${item.titulo}`);
          }
        } else {
          // Se não tem data, remove (não podemos confirmar se está ativo)
          removidos++;
          console.log(`  🗑️ Removido (sem data de publicação): ${item.titulo}`);
        }
      }
      
      console.log(`  ✅ ${itens.length} imóveis encontrados | ${ativos} ativos | ${removidos} removidos`);

      if (itens.length === 0) {
        erros.push(`${fonte.nome}: 0 imóveis`);
      }
    } catch (e) {
      console.error(`  ❌ ERRO: ${e.message}`);
      erros.push(`${fonte.nome}: ${e.message}`);
    }
  }

  const dataHoje = new Date().toISOString().split("T")[0];

  // ========== GALERIAS ==========
  let doCache = 0, buscadosGratis = 0, buscadosComCredito = 0, semGaleria = 0;

  for (const item of todos) {
    if (!item.link) continue;

    const cacheada = cacheGaleria.get(item.link);
    if (cacheada) {
      item.imagens = cacheada.slice(0, 8);
      item.imagem = item.imagens[0] || item.imagem;
      item.galeriaCompleta = true;
      doCache++;
      continue;
    }

    if (item._semJS) {
      const galeria = await buscarGaleriaCompletaSemJS(item.link);
      if (galeria.length > 0) {
        item.imagens = [...new Set([...(item.imagens || []), ...galeria])].slice(0, 8);
        item.imagem = item.imagens[0] || item.imagem;
        item.galeriaCompleta = true;
        buscadosGratis++;
      } else {
        semGaleria++;
      }
      await esperar(400);
    } else {
      try {
        const galeria = await buscarGaleriaCompletaJS(item.link, chaves);
        if (galeria.length > 0) {
          item.imagens = [...new Set([...(item.imagens || []), ...galeria])].slice(0, 8);
          item.imagem = item.imagens[0] || item.imagem;
          item.galeriaCompleta = true;
          buscadosComCredito++;
        } else {
          semGaleria++;
        }
        await esperar(1000);
      } catch (e) {
        console.warn(`  ⚠️ Galeria falhou: ${e.message.slice(0, 60)}`);
        semGaleria++;
      }
    }
  }

  console.log(`\n📸 Galerias: ${doCache} cache | ${buscadosGratis} grátis | ${buscadosComCredito} via JS | ${semGaleria} sem galeria`);

  const todosLimpos = todos.map(({ _semJS, ...resto }) => resto);

  const saida = {
    atualizadoEm: new Date().toISOString(),
    geradoEm: dataHoje,
    total: todosLimpos.length,
    imoveis: todosLimpos,
    erros,
    disclaimer: "Imóveis com até 6 meses de publicação. Alguns podem não estar disponíveis caso a imobiliária não tenha atualizado sua página."
  };

  await writeFile(
    new URL("../imoveis.json", import.meta.url),
    JSON.stringify(saida, null, 2),
    "utf-8"
  );

  await writeFile(
    new URL(`../historico/imoveis-${dataHoje}.json`, import.meta.url),
    JSON.stringify(saida, null, 2),
    "utf-8"
  );

  console.log(`\n✅ Total: ${todosLimpos.length} imóveis salvos em imoveis.json`);
  if (erros.length > 0) {
    console.log(`⚠️ ${erros.length} avisos/erros`);
  }
}

main().catch(e => {
  console.error("❌ Falha geral:", e);
  process.exit(1);
});
