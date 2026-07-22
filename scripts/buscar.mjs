// scripts/buscar.mjs
//
// Roda no GitHub Actions.
// Suporta: ScrapingBee, Firecrawl e ScraperAPI com fallback automático.
// ✅ Com extração de data por fonte (via JSON-LD e HTML)
// ✅ Suporte a wait e scroll por fonte (ex: Kenlo)
// ✅ Captura imagens da plataforma ImobWeb (rsSlide, data-src)

import { readFile, writeFile } from "node:fs/promises";

// ----------------------
// Utilitários básicos
// ----------------------

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

// ----------------------
// EXTRAÇÃO DE DATA POR FONTE
// ----------------------

function extrairDataDoJsonLd(html) {
  const regexBloco = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  
  while ((match = regexBloco.exec(html)) !== null) {
    try {
      const dados = JSON.parse(match[1].trim());
      const itens = Array.isArray(dados) ? dados : [dados];
      
      for (const item of itens) {
        let data = item.datePublished || 
                   item.publishedAt || 
                   item.dateCreated || 
                   item.uploadDate;
        
        if (data) {
          const dataNormalizada = normalizarData(data);
          if (dataNormalizada) return dataNormalizada;
        }
      }
    } catch (e) {
      // Ignora blocos que não são JSON válido
    }
  }
  return null;
}

function normalizarData(valor) {
  if (!valor) return null;
  
  const matchISO = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (matchISO) return `${matchISO[1]}-${matchISO[2]}-${matchISO[3]}`;
  
  const matchBR = valor.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (matchBR) return `${matchBR[3]}-${matchBR[2]}-${matchBR[1]}`;
  
  if (/^\d+$/.test(valor)) {
    try {
      const data = new Date(parseInt(valor));
      return data.toISOString().split('T')[0];
    } catch (e) {}
  }
  
  return null;
}

function extrairDataPorFonte(html, nomeFonte) {
  const dataJsonLd = extrairDataDoJsonLd(html);
  if (dataJsonLd) return dataJsonLd;
  
  const texto = limparTexto(removerTags(html));
  
  if (nomeFonte.includes("Kenlo")) {
    const match = texto.match(/publicado\s*(?:em|há)?\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (match) return normalizarData(match[1]);
  }
  
  if (nomeFonte.includes("Grupo Kaion")) {
    const match = texto.match(/publicado\s*(?:em|há)?\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (match) return normalizarData(match[1]);
  }
  
  if (nomeFonte.includes("VivaReal")) {
    const match = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match) return normalizarData(match[0]);
  }
  
  if (nomeFonte.includes("Residencial")) {
    return null;
  }
  
  const padroes = [
    /publicado\s*em\s*(\d{2}\/\d{2}\/\d{4})/i,
    /publicado\s*há\s*(\d+)\s*dias?/i,
    /publicado\s*há\s*(\d+)\s*meses?/i,
    /anunciado\s*em\s*(\d{2}\/\d{2}\/\d{4})/i,
    /cadastrado\s*em\s*(\d{2}\/\d{2}\/\d{4})/i,
    /data\s*[:\-]\s*(\d{2}\/\d{2}\/\d{4})/i,
    /(\d{2})\/(\d{2})\/(\d{4})/
  ];
  
  for (const padrao of padroes) {
    const match = texto.match(padrao);
    if (match) {
      if (match[1] && padrao.toString().includes('dias')) {
        const dias = parseInt(match[1]);
        const data = new Date();
        data.setDate(data.getDate() - dias);
        return data.toISOString().split('T')[0];
      }
      if (match[1] && padrao.toString().includes('meses')) {
        const meses = parseInt(match[1]);
        const data = new Date();
        data.setMonth(data.getMonth() - meses);
        return data.toISOString().split('T')[0];
      }
      const dataNormalizada = normalizarData(match[0]);
      if (dataNormalizada) return dataNormalizada;
    }
  }
  
  return null;
}

// ----------------------
// Regex para links de imóveis
// ----------------------

const PADRAO_LINK_IMOVEL = 
  /\/imovel(\/|\?)|\/imoveis\/[^"']*\/(\d+)|\/detalhes\/(\d+)|\/propriedade\/(\d+)|\/[a-z-]+\/[a-z-]+\/[a-z-]+\/\d+|CA\d{4}-[A-Z0-9]+|SO\d{4}-[A-Z0-9]+/i;

// ----------------------
// Imagens - CORRIGIDO PARA IMOBWEB
// ----------------------

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
  // 🔴 Lista de palavras que indicam que a imagem NÃO é do imóvel
  const PALAVRAS_IGNORAR = [
    'flat.jpg', 'placeholder', 'logo', 'icone', 'icon', 
    'avatar', 'spinner', 'loading', 'lazy', 'blank', 
    'pixel', '1x1', 'transparent', 'selo', 'bandeira',
    'flag', 'whatsapp', 'facebook', 'instagram', 'twitter',
    'email', 'imobibrasil.com.br/t'
  ];

  const padroes = [
    // Padrões padrão
    /<img[^>]+src=["']([^"']+)["']/gi,
    /<img[^>]+data-src=["']([^"']+)["']/gi,
    /<img[^>]+srcset=["']([^"',\s]+)/gi,
    // IMOBWEB: Captura imagens com classe rsImg (slider)
    /<img[^>]+class=["'][^"']*rsImg[^"']*["'][^>]*src=["']([^"']+)["']/gi,
    // IMOBWEB: Captura imagens com data-src (lazy loading)
    /<img[^>]+data-src=["']([^"']+)["']/gi,
    // IMOBWEB: Captura imagens em containers rsSlide
    /<div[^>]*class=["'][^"']*rsSlide[^"']*["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/gi
  ];

  const encontradas = [];
  for (const padrao of padroes) {
    for (const m of trechoHtml.matchAll(padrao)) {
      const url = m[1];
      if (!url) continue;
      
      // 🔴 Verifica se a URL contém alguma palavra que devemos ignorar
      const deveIgnorar = PALAVRAS_IGNORAR.some(palavra => 
        url.toLowerCase().includes(palavra.toLowerCase())
      );
      
      if (deveIgnorar) continue;
      
      // 🔴 PRIORIDADE: Se a imagem vem do CDN imobibrasil, é a correta
      const isImobCdn = url.includes('cdn-imobibrasil.com.br');
      
      // 🔴 Verifica se já não foi adicionada
      if (!encontradas.some(e => e.url === url)) {
        encontradas.push({ url, isImobCdn });
      }
    }
  }
  
  // 🔴 Ordena: primeiro as do CDN, depois as outras
  encontradas.sort((a, b) => (b.isImobCdn ? 1 : 0) - (a.isImobCdn ? 1 : 0));
  
  // 🔴 Retorna apenas as URLs
  return encontradas.map(item => item.url);
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

function extrairImagens(anchorHtmlBruto, htmlCompleto, matchIndex, baseUrl) {
  const doAncora = buscarImagensEmTrecho(anchorHtmlBruto);
  
  if (doAncora.length > 0) {
    return {
      imagens: doAncora.map(url => resolverUrlImagem(url, baseUrl)).slice(0, 8),
      origemConfiavel: true
    };
  }
  
  const inicioJanela = Math.max(0, matchIndex - 800);
  const fimJanela = Math.min(htmlCompleto.length, matchIndex + 200);
  const trechoProximo = htmlCompleto.slice(inicioJanela, fimJanela);
  const daJanela = buscarImagensEmTrecho(trechoProximo);
  
  return {
    imagens: daJanela.map(url => resolverUrlImagem(url, baseUrl)).slice(0, 8),
    origemConfiavel: false
  };
}

// ----------------------
// Limpeza de HTML
// ----------------------

function removerScriptsEEstilos(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

// ----------------------
// Extração de cards
// ----------------------

function extrairCards(htmlBruto, baseUrl, nomeFonte) {
  const porLink = new Map();
  const html = removerScriptsEEstilos(htmlBruto);

  function registrar(href, candidato) {
    href = href.replace(/\?from=.*$/, '');
    
    const existente = porLink.get(href);
    if (!existente) {
      porLink.set(href, candidato);
      return;
    }
    
    const imagensUnidas = [...new Set([...existente.imagens, ...candidato.imagens])].slice(0, 8);
    const existenteConfiavel = existente._origemConfiavel;
    const candidatoConfiavel = candidato._origemConfiavel;

    let imagensFinal = imagensUnidas;
    if (!existenteConfiavel && candidatoConfiavel) {
      imagensFinal = [...new Set([...candidato.imagens, ...existente.imagens])].slice(0, 8);
    }

    let dataFinal = existente.dataPublicacao;
    if (!dataFinal && candidato.dataPublicacao) {
      dataFinal = candidato.dataPublicacao;
    }

    porLink.set(href, {
      ...existente,
      imagens: imagensFinal,
      _origemConfiavel: existenteConfiavel || candidatoConfiavel,
      preco: existente.preco || candidato.preco,
      quartos: existente.quartos || candidato.quartos,
      suites: existente.suites || candidato.suites,
      vagas: existente.vagas || candidato.vagas,
      area: existente.area || candidato.area,
      bairro: existente.bairro || candidato.bairro,
      cidade: existente.cidade || candidato.cidade,
      tipo: existente.tipo || candidato.tipo,
      finalidade: existente.finalidade || candidato.finalidade,
      titulo: (existente.titulo && existente.titulo !== "Imóvel") ? existente.titulo : candidato.titulo,
      dataPublicacao: dataFinal,
    });
  }

  const regexLink = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regexLink.exec(html)) !== null) {
    let href = match[1];
    const anchorHtmlBruto = match[2];
    const textoLink = limparTexto(removerTags(anchorHtmlBruto));

    if (!PADRAO_LINK_IMOVEL.test(href)) continue;

    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = base.origin + href;
    }

    const textoPrincipal = textoLink.length > 25 ? textoLink : 
      limparTexto(removerTags(html.slice(Math.max(0, match.index - 700), Math.min(html.length, match.index + 700))));

    const { imagens, origemConfiavel } = extrairImagens(anchorHtmlBruto, html, match.index, baseUrl);

    const inicioCard = Math.max(0, match.index - 1500);
    const fimCard = Math.min(html.length, match.index + 1500);
    const cardHtml = html.slice(inicioCard, fimCard);
    const dataPublicacao = extrairDataPorFonte(cardHtml, nomeFonte);

    registrar(href, {
      fonte: nomeFonte,
      titulo: tituloSeguro(textoLink) || "Imóvel",
      imagens: imagens.slice(0, 8),
      imagem: imagens[0] || "",
      _origemConfiavel: origemConfiavel,
      preco: extrairPreco(textoPrincipal),
      quartos: extrairQuartos(textoPrincipal),
      suites: extrairSuites(textoPrincipal),
      vagas: extrairVagas(textoPrincipal),
      area: extrairArea(textoPrincipal),
      bairro: extrairBairro(textoPrincipal),
      cidade: extrairCidade(textoPrincipal, href),
      tipo: extrairTipo(textoPrincipal, href),
      finalidade: extrairFinalidade(textoPrincipal),
      link: href,
      dataPublicacao: dataPublicacao,
    });
  }

  const regexOnclick = /onclick=["']location\.href=['"]([^"']+)['"]/gi;
  let m2;
  while ((m2 = regexOnclick.exec(html)) !== null) {
    let href = m2[1];
    if (!PADRAO_LINK_IMOVEL.test(href)) continue;

    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = base.origin + href;
    }

    const inicioJanela = Math.max(0, m2.index - 700);
    const fimJanela = Math.min(html.length, m2.index + 700);
    const janelaHtml = html.slice(inicioJanela, fimJanela);
    const textoJanela = limparTexto(removerTags(janelaHtml));

    const { imagens, origemConfiavel } = extrairImagens(janelaHtml, html, m2.index, baseUrl);
    const dataPublicacao = extrairDataPorFonte(janelaHtml, nomeFonte);

    registrar(href, {
      fonte: nomeFonte,
      titulo: "Imóvel",
      imagens: imagens.slice(0, 8),
      imagem: imagens[0] || "",
      _origemConfiavel: origemConfiavel,
      preco: extrairPreco(textoJanela),
      quartos: extrairQuartos(textoJanela),
      suites: extrairSuites(textoJanela),
      vagas: extrairVagas(textoJanela),
      area: extrairArea(textoJanela),
      bairro: extrairBairro(textoJanela),
      cidade: extrairCidade(textoJanela, href),
      tipo: extrairTipo(textoJanela, href),
      finalidade: extrairFinalidade(textoJanela),
      link: href,
      dataPublicacao: dataPublicacao,
    });
  }

  return Array.from(porLink.values()).map(({ _origemConfiavel, ...resto }) => resto);
}

// ----------------------
// Funções de Bairro e Cidade
// ----------------------

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

// ----------------------
// Fetch: Direto + ScrapingBee + Firecrawl + ScraperAPI
// ----------------------

async function buscarDireto(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    }
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.text();
}

// ========== SCRAPINGBEE COM SUPORTE A WAIT E SCROLL ==========
async function buscarScrapingBee(url, apiKey, opcoes = {}) {
  const wait = opcoes.wait || 2500;
  let endpoint =
    "https://app.scrapingbee.com/api/v1/?api_key=" +
    encodeURIComponent(apiKey) +
    "&url=" +
    encodeURIComponent(url) +
    "&render_js=true" +
    "&wait=" + wait;

  // Se a fonte pedir scroll, adiciona o cenário (sintaxe corrigida)
  if (opcoes.scroll) {
    endpoint += "&js_scenario=" + encodeURIComponent(JSON.stringify({
      instructions: [
        { wait: 2000 },
        { scroll: { direction: "down", repeat: 5 } },
        { wait: 3000 }
      ]
    }));
  }

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

// ========== FIRECRAWL ==========
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

// ========== SCRAPERAPI ==========
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

// ========== BUSCA COM FALLBACK MÚLTIPLO ==========
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

// ========== GALERIA PARA SITES SEM JS ==========
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

// ========== GALERIA PARA SITES COM JS ==========
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

// ----------------------
// MAIN
// ----------------------

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 BUSCAR.MJS - COM EXTRAÇÃO DE DATA");
  console.log("   ✅ Mantém todos os imóveis");
  console.log("   ✅ Suporte a wait e scroll por fonte");
  console.log("   ✅ Captura imagens ImobWeb (rsSlide)");
  console.log("=".repeat(60));

  let fontesRaw;
  try {
    fontesRaw = await readFile(new URL("../fontes.json", import.meta.url), "utf-8");
  } catch (e) {
    console.error("Erro ao ler fontes.json:", e.message);
    process.exit(1);
  }

  let fontes;
  try {
    fontes = JSON.parse(fontesRaw);
  } catch (e) {
    console.error("Erro ao fazer parse de fontes.json:", fontesRaw.slice(0, 500));
    process.exit(1);
  }

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

  const scrapingBeeKeys = [
    process.env.SCRAPINGBEE_API_KEY,
    process.env.SCRAPINGBEE_API_KEY_2,
    process.env.SCRAPINGBEE_API_KEY_3,
  ].filter(Boolean);

  const firecrawlKey = process.env.FIRECRAWL_API_KEY || "";
  const scraperAPIKey = process.env.SCRAPERAPI_API_KEY || "";

  const chaves = {
    scrapingBeeKeys,
    firecrawlKey,
    scraperAPIKey,
  };

  console.log(`\n🐝 ScrapingBee: ${scrapingBeeKeys.length} chave(s)`);
  console.log(`🔥 Firecrawl: ${firecrawlKey ? "✅ Configurado" : "❌ Não configurado"}`);
  console.log(`🧪 ScraperAPI: ${scraperAPIKey ? "✅ Configurado" : "❌ Não configurado"}`);

  const todos = [];
  const erros = [];
  let comData = 0;
  let semData = 0;

  for (const fonte of fontes) {
    console.log(`\n📡 Buscando: ${fonte.nome} (${fonte.url})${fonte.jsNecessario ? " [via JS]" : ""}`);
    if (fonte.wait) console.log(`   ⏱️  Wait: ${fonte.wait}ms`);
    if (fonte.scroll) console.log(`   📜 Scroll: ativado`);

    try {
      let html;

      if (fonte.jsNecessario) {
        const temAlgumaChave = scrapingBeeKeys.length > 0 || firecrawlKey || scraperAPIKey;
        if (!temAlgumaChave) {
          console.warn(`  ⚠️ Nenhuma chave configurada`);
          erros.push(`${fonte.nome}: sem chave`);
          continue;
        }
        // Passa as opções da fonte (wait, scroll) para o ScrapingBee
        const opcoes = {};
        if (fonte.wait) opcoes.wait = fonte.wait;
        if (fonte.scroll) opcoes.scroll = fonte.scroll;
        html = await buscarComJS(fonte.url, chaves, opcoes);
      } else {
        html = await buscarDireto(fonte.url);
      }

      const itens = extrairCards(html, fonte.url, fonte.nome);
      itens.forEach(item => { 
        item._semJS = !fonte.jsNecessario; 
        if (item.dataPublicacao) {
          comData++;
        } else {
          semData++;
        }
      });
      todos.push(...itens);

      const comDataCount = itens.filter(i => i.dataPublicacao).length;
      const semDataCount = itens.filter(i => !i.dataPublicacao).length;
      console.log(`  ✅ ${itens.length} imóveis encontrados (${comDataCount} com data, ${semDataCount} sem data)`);

      if (itens.length === 0) {
        const contemImovel = (html.match(/\/imovel\//gi) || []).length;
        const contemComprar = (html.match(/\/(comprar|alugar)\//gi) || []).length;
        const pareceBloqueio = /captcha|access denied|cloudflare|habilite o javascript/i.test(html);

        erros.push(
          `${fonte.nome}: 0 imóveis encontrados. HTML: ${html.length} chars. ` +
          `"/imovel/": ${contemImovel}. "/comprar/|/alugar/": ${contemComprar}. ` +
          `Bloqueio: ${pareceBloqueio ? "SIM" : "não"}.`
        );
      }
    } catch (e) {
      console.error(`  ❌ ERRO: ${e.message}`);
      erros.push(`${fonte.nome}: ${e.message}`);
    }
  }

  const dataHoje = new Date().toISOString().split("T")[0];

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
      const temAlgumaChave = scrapingBeeKeys.length > 0 || firecrawlKey || scraperAPIKey;
      if (temAlgumaChave) {
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
      } else {
        semGaleria++;
      }
    }
  }

  console.log(`\n📸 Galerias: ${doCache} cache | ${buscadosGratis} grátis | ${buscadosComCredito} via JS | ${semGaleria} sem galeria`);
  console.log(`\n📅 Data: ${comData} imóveis com data | ${semData} imóveis sem data`);

  const todosLimpos = todos.map(({ _semJS, ...resto }) => resto);

  const saida = {
    atualizadoEm: new Date().toISOString(),
    geradoEm: dataHoje,
    total: todosLimpos.length,
    imoveis: todosLimpos,
    erros,
    resumoData: {
      comData: comData,
      semData: semData,
      total: todosLimpos.length
    }
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
