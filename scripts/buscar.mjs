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

// Remove tags HTML de forma mais robusta que um simples /<[^>]+>/g - esse
// padrao simples quebra quando um atributo (ex: onclick, onfocus) tem um
// ">" dentro dele mesmo (comum em JS inline, tipo comparacoes numericas),
// porque ele fecha a tag no lugar errado e deixa lixo de codigo misturado
// no texto. Esse padrao aqui ignora ">" que estao dentro de aspas.
function removerTags(html) {
  return (html || "").replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ");
}

// Rede de seguranca: alguns sites tem widgets (sliders, filtros) cujo
// codigo JS/HTML as vezes vaza pro texto capturado, mesmo depois de limpar
// as tags. Em vez de tentar prever cada variacao possivel, rejeita qualquer
// texto que "cheire" a codigo em vez de descricao de imovel.
function pareceCodigoVazado(texto) {
  return /class=|onfocus=|onclick=|&quot;|function\s*\(|\$\(this\)|span_maximo|span_minimo|\.val\(|botoes_selected/i.test(texto);
}

function tituloSeguro(candidato) {
  if (candidato && !pareceCodigoVazado(candidato)) return candidato;
  return "";
}

function extrairPreco(texto) {
  // Formatos comuns: "R$ 1.200.000", "R$1.200.000,00", etc.
  let m = texto.match(/R\$\s?[\d.,]+/);
  if (m) return m[0];

  // Fallback: "valor: R$ 1.200.000"
  m = texto.match(/valor[: ]+R\$\s?[\d.,]+/i);
  if (m) return m[0].replace(/valor[: ]+/i, "").trim();

  // "sob consulta"
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
// Regex mais abrangente para links de imóveis
// ----------------------

const PADRAO_LINK_IMOVEL =
  /\/imovel(\/|\?)|\/imoveis\/[^"']*\/(\d+)|\/detalhes\/(\d+)|\/propriedade\/(\d+)|\/[a-z-]+\/[a-z-]+\/[a-z-]+\/\d+/i;

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

// "Porta dos fundos": muitos sites embutem um bloco de dados estruturados
// (JSON-LD, <script type="application/ld+json">) destinado ao Google indexar
// fotos na busca - isso ja vem pronto no HTML, sem depender de clique nem de
// JavaScript rodando. Vale a pena checar sempre, é de graca.
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
      // bloco nao era JSON valido - ignora e segue
    }
  }
  return encontradas;
}

// Retorna uma LISTA de imagens (nao so uma), priorizando as que estao DENTRO
// do proprio link (mais confiavel - pertence garantidamente aquele imovel)
// e so complementando com as que estao no texto ao redor (menos confiavel,
// pode pertencer a um card vizinho).
function extrairImagens(anchorHtmlBruto, precedendoHtmlBruto, baseUrl) {
  const doAncora = buscarImagensEmTrecho(anchorHtmlBruto);
  const daJanela = buscarImagensEmTrecho(precedendoHtmlBruto);

  const todas = [...doAncora, ...daJanela]
    .map(url => resolverUrlImagem(url, baseUrl))
    .filter(Boolean);

  // remove duplicadas mantendo ordem, e marca a origem da primeira (a mais
  // confiavel) pra decidir prioridade no merge entre ocorrencias repetidas
  const unicas = [...new Set(todas)];

  return {
    imagens: unicas,
    origemConfiavel: doAncora.length > 0, // true = veio de dentro do proprio <a>
  };
}

function extrairImagem(anchorHtmlBruto, precedendoHtmlBruto, baseUrl) {
  let encontrada = buscarImgEmTrecho(anchorHtmlBruto);
  if (!encontrada) encontrada = buscarImgEmTrecho(precedendoHtmlBruto);
  return resolverUrlImagem(encontrada, baseUrl);
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
  const porLink = new Map(); // href -> resultado (permite atualizar com dado melhor)

  // remove scripts/estilos/comentários
  const html = removerScriptsEEstilos(htmlBruto);

  function registrar(href, candidato) {
    const existente = porLink.get(href);
    if (!existente) {
      porLink.set(href, candidato);
      return;
    }
    // Alguns sites repetem o mesmo imovel varias vezes na pagina - uma vez
    // sem foto/preco de verdade associado, e de novo em outro lugar com o
    // dado completo. Por isso, ao encontrar o mesmo link de novo, so
    // substituimos o que falta, sem perder o que a versao anterior ja tinha.
    //
    // Para IMAGENS: junta as listas das duas ocorrencias (mais fotos e
    // melhor pro cliente ver), mas põe primeiro as que vieram de origem
    // confiavel (de dentro do proprio link) - assim uma imagem errada
    // pega por engano no card vizinho nao fica na frente da certa.
    const imagensUnidas = [...new Set([...existente.imagens, ...candidato.imagens])];
    const existenteConfiavel = existente._origemConfiavel;
    const candidatoConfiavel = candidato._origemConfiavel;

    let imagensFinal = imagensUnidas;
    if (!existenteConfiavel && candidatoConfiavel) {
      // o candidato novo tem origem mais confiavel - poe as dele primeiro
      imagensFinal = [...new Set([...candidato.imagens, ...existente.imagens])];
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

  // captura links em <a href="...">
  const regexLink = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regexLink.exec(html)) !== null) {
    let href = match[1];
    const anchorHtmlBruto = match[2];
    const textoLink = limparTexto(removerTags(anchorHtmlBruto));

    // se o href não parece link de imóvel, pula
    if (!PADRAO_LINK_IMOVEL.test(href)) continue;

    // normaliza href relativo
    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = base.origin + href;
    }

    // janelas maiores para capturar preço/imagem/bairro/cidade
    const inicioJanela = Math.max(0, match.index - 700);
    const fimJanela = Math.min(html.length, match.index + 700);
    const janelaHtml = html.slice(inicioJanela, fimJanela);
    const textoJanela = limparTexto(removerTags(janelaHtml));

    // imagem geralmente fica bem antes do link
    const precedendoImagem = html.slice(Math.max(0, match.index - 3500), match.index);
    const { imagens, origemConfiavel } = extrairImagens(anchorHtmlBruto, precedendoImagem, baseUrl);

    // prioriza texto dentro do link; se for curto, usa janela
    const textoPrincipal = textoLink.length > 25 ? textoLink : textoJanela;

    registrar(href, {
      fonte: nomeFonte,
      titulo: tituloSeguro(textoLink) || "Imóvel",
      imagens,
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

  // captura links em onclick="location.href='...'"
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

    const precedendoImagem = html.slice(Math.max(0, m2.index - 3500), m2.index);
    const { imagens, origemConfiavel } = extrairImagens(janelaHtml, precedendoImagem, baseUrl);

    registrar(href, {
      fonte: nomeFonte,
      titulo: "Imóvel",
      imagens,
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
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
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
    "&wait=2500"; // da tempo pro carrossel/galeria (lazy-load) terminar de carregar antes do "print"

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

// Tenta cada chave da lista em ordem. Se uma falhar por falta de credito
// (HTTP 402, ou mensagem de credito/quota esgotada), tenta a proxima
// automaticamente. Se falhar por outro motivo (site fora do ar, etc), nao
// adianta trocar de chave - propaga o erro direto.
async function buscarComJS(url, chaves, opcoes = {}) {
  let ultimoErro = null;
  for (let i = 0; i < chaves.length; i++) {
    try {
      return await buscarComUmaChave(url, chaves[i], opcoes);
    } catch (e) {
      ultimoErro = e;
      if (!e.semCredito) throw e; // erro que trocar de chave nao resolve
      console.warn(`  Chave ScrapingBee #${i + 1} sem crédito, tentando a próxima...`);
    }
  }
  throw ultimoErro;
}

// Cenario pra abrir a galeria de fotos antes de capturar a pagina. Varios
// sites (confirmado na Kenlo) so carregam as fotos extras quando alguem
// clica no botao/link "Fotos" - sem isso, so a foto de capa aparece no HTML,
// mesmo com JavaScript habilitado e tempo de espera.
const CENARIO_ABRIR_GALERIA = {
  instructions: [
    { wait: 1200 },
    { click: "//*[contains(text(),'Fotos') or contains(text(),'fotos')]" },
    { wait: 2000 },
  ],
};

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Visita a pagina INDIVIDUAL de um imovel (nao a listagem) pra pegar a
// galeria completa de fotos - a listagem normalmente só tem 1 foto de capa
// por card, a galeria completa fica na pagina propria de cada imovel.
// So faz isso pra sites SEM JavaScript (fetch direto, sem custo de credito).
async function buscarGaleriaCompleta(url) {
  try {
    const htmlBruto = await buscarDireto(url);
    // JSON-LD precisa ser lido ANTES de remover scripts (ele mora dentro
    // de uma tag <script>)
    const doJsonLd = buscarImagensViaJsonLd(htmlBruto);
    const html = removerScriptsEEstilos(htmlBruto);
    const doHtml = buscarImagensEmTrecho(html);
    const imagens = [...new Set([...doJsonLd, ...doHtml])];
    return imagens.map(u => resolverUrlImagem(u, url)).slice(0, 20);
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

  // Le o imoveis.json da execucao ANTERIOR (se existir) pra montar um cache
  // de "esse imovel eu ja visitei a pagina individual dele e ja tenho a
  // galeria completa". Assim, rodadas futuras nao pagam credito de novo por
  // imoveis que ja foram processados - so pagam pelos que sao realmente novos.
  const cacheGaleria = new Map(); // link -> array de imagens ja confirmado
  try {
    const anteriorRaw = await readFile(new URL("../imoveis.json", import.meta.url), "utf-8");
    const anterior = JSON.parse(anteriorRaw);
    for (const item of anterior.imoveis || []) {
      if (item.galeriaCompleta && item.link && item.imagens && item.imagens.length > 0) {
        cacheGaleria.set(item.link, item.imagens);
      }
    }
    console.log(`Cache de galerias: ${cacheGaleria.size} imóveis já processados em execuções anteriores (não vão gastar crédito de novo).`);
  } catch (e) {
    console.log("Sem imoveis.json anterior (ou erro ao ler) - primeira execução, cache vazio.");
  }

  // Aceita ate 5 chaves do ScrapingBee - se uma ficar sem credito, tenta a
  // proxima da lista automaticamente. So a primeira (SCRAPINGBEE_API_KEY) e
  // obrigatoria - as demais (_2 a _5) sao opcionais; se nao existirem, so
  // usa as que estiverem configuradas.
  const chavesScrapingBee = [
    process.env.SCRAPINGBEE_API_KEY,
    process.env.SCRAPINGBEE_API_KEY_2,
    process.env.SCRAPINGBEE_API_KEY_3,
    process.env.SCRAPINGBEE_API_KEY_4,
    process.env.SCRAPINGBEE_API_KEY_5,
  ].filter(Boolean);

  const todos = [];
  const erros = [];

  for (const fonte of fontes) {
    console.log(
      `Buscando: ${fonte.nome} (${fonte.url})${fonte.jsNecessario ? " [via ScrapingBee]" : ""}`
    );

    try {
      let html;

      if (fonte.jsNecessario) {
        if (chavesScrapingBee.length === 0) {
          const msg = `${fonte.nome}: precisa de JavaScript, mas nenhuma SCRAPINGBEE_API_KEY está configurada. Busca pulada.`;
          console.warn(msg);
          erros.push(msg);
          continue;
        }
        html = await buscarComJS(fonte.url, chavesScrapingBee);
      } else {
        html = await buscarDireto(fonte.url);
      }

      const itens = extrairCards(html, fonte.url, fonte.nome);
      // marca pra saber, na proxima etapa, quais podem ter a pagina propria
      // visitada sem custo de credito (sites sem JS)
      itens.forEach(item => { item._semJS = !fonte.jsNecessario; });
      todos.push(...itens);

      console.log(`  -> ${itens.length} imóveis encontrados`);

      if (itens.length === 0) {
        const contemImovel = (html.match(/\/imovel\//gi) || []).length;
        const contemComprar = (html.match(/\/(comprar|alugar)\//gi) || []).length;
        const pareceBloqueio =
          /captcha|access denied|cloudflare|habilite o javascript/i.test(html);

        erros.push(
          `${fonte.nome}: 0 imóveis encontrados. HTML: ${html.length} chars. ` +
            `"/imovel/": ${contemImovel}. "/comprar/|/alugar/": ${contemComprar}. ` +
            `Bloqueio/JS: ${pareceBloqueio ? "SIM" : "não"}.`
        );
      }
    } catch (e) {
      console.error(`  -> ERRO: ${e.message}`);
      erros.push(`${fonte.nome}: ${e.message}`);
    }
  }

  const dataHoje = new Date().toISOString().split("T")[0];

  // Segunda passada: visita a pagina INDIVIDUAL de cada imovel pra pegar a
  // galeria completa (a listagem só tem a foto de capa). Usa o cache primeiro
  // (imoveis ja processados antes nao gastam credito de novo). Sites sem
  // JavaScript sao sempre buscados (gratis). Sites com JavaScript (Kenlo)
  // só sao buscados se NAO estiverem no cache - assim o gasto de credito cai
  // drasticamente depois da primeira rodada completa.
  let doCache = 0, buscadosGratis = 0, buscadosComCredito = 0, semGaleria = 0;

  for (const item of todos) {
    if (!item.link) continue;

    const cacheada = cacheGaleria.get(item.link);
    if (cacheada) {
      item.imagens = cacheada;
      item.imagem = item.imagens[0] || item.imagem;
      item.galeriaCompleta = true;
      doCache++;
      continue;
    }

    if (item._semJS) {
      const galeria = await buscarGaleriaCompleta(item.link);
      if (galeria.length > 0) {
        item.imagens = [...new Set([...(item.imagens || []), ...galeria])];
        item.imagem = item.imagens[0] || item.imagem;
        item.galeriaCompleta = true;
        buscadosGratis++;
      } else {
        semGaleria++;
      }
      await esperar(400); // educado com o servidor - nao martela requisicoes
    } else if (chavesScrapingBee.length > 0) {
      try {
        const htmlBrutoJS = await buscarComJS(item.link, chavesScrapingBee, { jsScenario: CENARIO_ABRIR_GALERIA });
        const doJsonLd = buscarImagensViaJsonLd(htmlBrutoJS);
        const html = removerScriptsEEstilos(htmlBrutoJS);
        const doHtml = buscarImagensEmTrecho(html);
        const galeria = [...new Set([...doJsonLd, ...doHtml])]
          .map(u => resolverUrlImagem(u, item.link)).slice(0, 20);
        if (galeria.length > 0) {
          item.imagens = [...new Set([...(item.imagens || []), ...galeria])];
          item.imagem = item.imagens[0] || item.imagem;
        }
        item.galeriaCompleta = true; // marca mesmo se vazio, pra nao tentar de novo a toa
        buscadosComCredito++;
      } catch (e) {
        console.warn(`  Falha ao buscar galeria (via ScrapingBee) de ${item.link}: ${e.message}`);
        semGaleria++;
      }
    }
  }

  console.log(
    `\nGalerias: ${doCache} do cache (sem custo) | ${buscadosGratis} buscados grátis (sites sem JS) | ` +
    `${buscadosComCredito} buscados via ScrapingBee (gastaram crédito) | ${semGaleria} sem galeria.`
  );

  // remove os campos internos de controle antes de salvar
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

  // histórico diário
  await writeFile(
    new URL(`../historico/imoveis-${dataHoje}.json`, import.meta.url),
    JSON.stringify(saida, null, 2),
    "utf-8"
  );

  console.log(`\nTotal: ${todosLimpos.length} imóveis salvos em imoveis.json`);
  if (erros.length > 0) {
    console.log(`Avisos/erros: ${erros.length}`);
  }
}

// Consulta o saldo de credito de cada chave ScrapingBee configurada e soma
// tudo, pra facilitar acompanhar o orcamento total disponivel sem precisar
// entrar em cada painel separadamente. Devolve o total pra ser salvo no
// imoveis.json (e assim aparecer no proprio site), alem de logar no console.
async function calcularCreditosRestantes(chaves) {
  if (chaves.length === 0) return { total: null, algumaFalhou: false };

  console.log(`\n--- Créditos ScrapingBee (${chaves.length} chave(s) configurada(s)) ---`);
  let total = 0;
  let algumaFalhou = false;

  for (let i = 0; i < chaves.length; i++) {
    try {
      const resp = await fetch(
        "https://app.scrapingbee.com/api/v1/account?api_key=" + encodeURIComponent(chaves[i])
      );
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const dados = await resp.json();
      // o nome do campo pode variar - tenta os formatos conhecidos
      const restante =
        dados.max_api_credit != null && dados.used_api_credit != null
          ? dados.max_api_credit - dados.used_api_credit
          : dados.credit ?? dados.remaining_credit ?? null;

      if (restante == null) {
        console.log(`  Chave #${i + 1}: resposta inesperada (${JSON.stringify(dados).slice(0, 150)})`);
        algumaFalhou = true;
        continue;
      }
      console.log(`  Chave #${i + 1}: ${restante} créditos restantes`);
      total += restante;
    } catch (e) {
      console.log(`  Chave #${i + 1}: não consegui checar (${e.message})`);
      algumaFalhou = true;
    }
  }

  console.log(`  TOTAL somado: ${total} créditos${algumaFalhou ? " (parcial - uma ou mais chaves falharam ao checar)" : ""}`);
  return { total, algumaFalhou };
}

main().catch(e => {
  console.error("Falha geral no script:", e);
  process.exit(1);
});
