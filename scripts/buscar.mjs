// scripts/buscar.mjs
//
// Roda no GitHub Actions.
// Lê fontes.json, busca cada site, extrai imóveis e salva em imoveis.json + histórico por data.

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
// Regex para links de imóveis
// ----------------------

const PADRAO_LINK_IMOVEL = 
  /\/imovel(\/|\?)|\/imoveis\/[^"']*\/(\d+)|\/detalhes\/(\d+)|\/propriedade\/(\d+)|\/[a-z-]+\/[a-z-]+\/[a-z-]+\/\d+|CA\d{4}-[A-Z0-9]+|SO\d{4}-[A-Z0-9]+/i;

// ----------------------
// Imagens
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
    } catch (e) {
      // bloco nao era JSON valido - ignora
    }
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
      link: href
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
      link: href
    });
  }

  return Array.from(porLink.values()).map(({ _origemConfiavel, ...resto }) => resto);
}

// ----------------------
// Fetch normal e ScrapingBee
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

async function buscarComUmaChave(url, apiKey, opcoes = {}) {
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

// ========== FUNÇÃO PARA TESTAR QUAL CHAVE TEM CRÉDITO ==========
async function encontrarChaveComCredito(chaves) {
  if (chaves.length === 0) return null;
  
  console.log(`  🔍 Testando ${chaves.length} chaves para encontrar uma com crédito...`);
  
  // Testa cada chave fazendo uma requisição simples (sem custo)
  for (let i = 0; i < chaves.length; i++) {
    try {
      const resp = await fetch(
        "https://app.scrapingbee.com/api/v1/account?api_key=" + encodeURIComponent(chaves[i])
      );
      if (!resp.ok) {
        console.log(`  Chave #${i + 1}: HTTP ${resp.status} - ignorando`);
        continue;
      }
      const dados = await resp.json();
      const restante = dados.credit ?? dados.remaining_credit ?? 
                      (dados.max_api_credit - dados.used_api_credit);
      
      if (restante != null && restante > 10) {
        console.log(`  ✅ Chave #${i + 1} tem ${restante} créditos - será usada!`);
        return chaves[i];
      } else {
        console.log(`  Chave #${i + 1}: sem crédito suficiente (${restante})`);
      }
    } catch (e) {
      console.log(`  Chave #${i + 1}: erro ao testar (${e.message})`);
    }
  }
  
  // Se nenhuma chave passou no teste, usa a primeira como fallback
  console.log(`  ⚠️ Nenhuma chave confirmada com crédito, usando chave #1 como fallback`);
  return chaves[0];
}

// ========== BUSCA COM CHAVE PRIORITÁRIA ==========
async function buscarComJS(url, chaves, opcoes = {}) {
  // Primeiro, encontra a melhor chave
  const chavePrioritaria = await encontrarChaveComCredito(chaves);
  if (!chavePrioritaria) {
    throw new Error("Nenhuma chave ScrapingBee disponível");
  }
  
  console.log(`  🚀 Buscando com chave prioritária...`);
  
  // Tenta com a chave prioritária primeiro
  try {
    return await buscarComUmaChave(url, chavePrioritaria, opcoes);
  } catch (e) {
    if (!e.semCredito) throw e; // erro não relacionado a crédito
    
    console.log(`  ⚠️ Chave prioritária falhou (sem crédito), tentando outras...`);
    
    // Fallback: tenta as outras chaves
    for (const chave of chaves) {
      if (chave === chavePrioritaria) continue;
      try {
        return await buscarComUmaChave(url, chave, opcoes);
      } catch (e2) {
        if (!e2.semCredito) throw e2;
        console.log(`  ⚠️ Chave fallback também falhou`);
      }
    }
    throw new Error("Todas as chaves ScrapingBee falharam (sem crédito)");
  }
}

// Cenario pra abrir a galeria de fotos
const CENARIO_ABRIR_GALERIA = {
  instructions: [
    { wait: 1200 },
    { click: "//*[contains(text(),'Fotos') or contains(text(),'fotos')]" },
    { wait: 2000 },
  ],
};

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

async function buscarGaleriaCompleta(url) {
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

// ----------------------
// MAIN
// ----------------------

async function main() {
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
    console.log(`Cache de galerias: ${cacheGaleria.size} imóveis já processados`);
  } catch (e) {
    console.log("Sem imoveis.json anterior - primeira execução.");
  }

  // Chaves ScrapingBee
  const chavesScrapingBee = [
    process.env.SCRAPINGBEE_API_KEY,
    process.env.SCRAPINGBEE_API_KEY_2,
    process.env.SCRAPINGBEE_API_KEY_3,
    process.env.SCRAPINGBEE_API_KEY_4,
    process.env.SCRAPINGBEE_API_KEY_5,
  ].filter(Boolean);

  console.log(`🔑 ${chavesScrapingBee.length} chave(s) ScrapingBee configurada(s)`);

  // Encontra a melhor chave uma vez e reutiliza
  const chaveParaGaleria = chavesScrapingBee.length > 0 ? await encontrarChaveComCredito(chavesScrapingBee) : null;
  if (chaveParaGaleria) {
    console.log(`✅ Chave selecionada para galerias: ${chaveParaGaleria.slice(0, 10)}...`);
  }

  const todos = [];
  const erros = [];

  for (const fonte of fontes) {
    console.log(`\n📡 Buscando: ${fonte.nome} (${fonte.url})${fonte.jsNecessario ? " [via ScrapingBee]" : ""}`);

    try {
      let html;

      if (fonte.jsNecessario) {
        if (chavesScrapingBee.length === 0) {
          const msg = `${fonte.nome}: precisa de JavaScript, mas nenhuma chave está configurada.`;
          console.warn(msg);
          erros.push(msg);
          continue;
        }
        html = await buscarComJS(fonte.url, chavesScrapingBee);
      } else {
        html = await buscarDireto(fonte.url);
      }

      const itens = extrairCards(html, fonte.url, fonte.nome);
      itens.forEach(item => { item._semJS = !fonte.jsNecessario; });
      todos.push(...itens);

      console.log(`  ✅ ${itens.length} imóveis encontrados`);

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

  // Segunda passada: galerias completas - USANDO A CHAVE PRIORITÁRIA
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
      const galeria = await buscarGaleriaCompleta(item.link);
      if (galeria.length > 0) {
        item.imagens = [...new Set([...(item.imagens || []), ...galeria])].slice(0, 8);
        item.imagem = item.imagens[0] || item.imagem;
        item.galeriaCompleta = true;
        buscadosGratis++;
      } else {
        semGaleria++;
      }
      await esperar(400);
    } else if (chaveParaGaleria) {
      try {
        // Usa a chave que já sabemos que tem crédito
        const htmlBrutoJS = await buscarComUmaChave(item.link, chaveParaGaleria, { jsScenario: CENARIO_ABRIR_GALERIA });
        const doJsonLd = buscarImagensViaJsonLd(htmlBrutoJS);
        const html = removerScriptsEEstilos(htmlBrutoJS);
        const doHtml = buscarImagensEmTrecho(html);
        const galeria = [...new Set([...doJsonLd, ...doHtml])]
          .map(u => resolverUrlImagem(u, item.link)).slice(0, 8);
        if (galeria.length > 0) {
          item.imagens = [...new Set([...(item.imagens || []), ...galeria])].slice(0, 8);
          item.imagem = item.imagens[0] || item.imagem;
        }
        item.galeriaCompleta = true;
        buscadosComCredito++;
      } catch (e) {
        console.warn(`  ⚠️ Falha ao buscar galeria de ${item.link}: ${e.message}`);
        semGaleria++;
      }
    }
  }

  console.log(`\n📸 Galerias: ${doCache} cache | ${buscadosGratis} grátis | ${buscadosComCredito} via ScrapingBee | ${semGaleria} sem galeria`);

  const todosLimpos = todos.map(({ _semJS, ...resto }) => resto);

  const infoCreditos = await calcularCreditosRestantes(chavesScrapingBee);

  const saida = {
    atualizadoEm: new Date().toISOString(),
    geradoEm: dataHoje,
    total: todosLimpos.length,
    imoveis: todosLimpos,
    erros,
    creditosScrapingBee: infoCreditos.total,
    creditosScrapingBeeParcial: infoCreditos.algumaFalhou,
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

async function calcularCreditosRestantes(chaves) {
  if (chaves.length === 0) return { total: null, algumaFalhou: false };

  console.log(`\n💰 Verificando créditos ScrapingBee (${chaves.length} chaves)...`);
  let total = 0;
  let algumaFalhou = false;
  let chavesComSaldo = 0;

  for (let i = 0; i < chaves.length; i++) {
    try {
      const resp = await fetch(
        "https://app.scrapingbee.com/api/v1/account?api_key=" + encodeURIComponent(chaves[i])
      );
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const dados = await resp.json();
      
      const restante = dados.credit ?? dados.remaining_credit ?? 
                      (dados.max_api_credit - dados.used_api_credit);
      
      if (restante == null) {
        console.log(`  Chave #${i + 1}: formato desconhecido, assumindo saldo`);
        chavesComSaldo++;
        total += 500;
        continue;
      }
      
      if (restante > 0) {
        console.log(`  Chave #${i + 1}: ✅ ${restante} créditos`);
        total += restante;
        chavesComSaldo++;
      } else {
        console.log(`  Chave #${i + 1}: ⚠️ SEM CRÉDITOS`);
      }
    } catch (e) {
      console.log(`  Chave #${i + 1}: ❌ erro ao verificar (${e.message})`);
      chavesComSaldo++;
      total += 500;
      algumaFalhou = true;
    }
  }

  console.log(`  TOTAL: ${total} créditos (${chavesComSaldo}/${chaves.length} chaves ativas)`);
  return { total, algumaFalhou };
}

main().catch(e => {
  console.error("❌ Falha geral:", e);
  process.exit(1);
});
