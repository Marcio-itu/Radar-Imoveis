// scripts/buscar.mjs
//
// Este script roda dentro do GitHub Actions.
// Ele lê fontes.json, busca cada site, extrai os imóveis e salva tudo em imoveis.json.

import { readFile, writeFile } from "node:fs/promises";

// ----------------------
// Funções utilitárias
// ----------------------

function limparTexto(txt) {
  return (txt || "").replace(/\s+/g, " ").trim();
}

function extrairPreco(texto) {
  const m = texto.match(/R\$\s?[\d.,]+/);
  return m ? m[0] : "";
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

function extrairBairro(texto) {
  let m = texto.match(
    new RegExp(
      `([A-ZÀ-Ú][\\wÀ-ú0-9°º.'\\s]{2,45}?)\\s*[-–]\\s*(?:${CIDADES_REGEX_TEXTO})\\s*[-–]\\s*SP\\b`,
      "i"
    )
  );
  if (m) return limparTexto(m[1]);

  m = texto.match(
    /(?:bairro|condom[ií]nio|residencial|jardim|parque|vila)\s*:?\s+([A-ZÀ-Ú][\wÀ-ú0-9°º.'\s]{2,40})/i
  );
  if (m) return limparTexto(m[0]);

  m = texto.match(/(?:em|no|na)\s+([A-ZÀ-Ú][\wÀ-ú\s]{2,40})/);
  return m ? limparTexto(m[1]) : "";
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
// REGEX DEFINITIVO — pega TODAS as imobiliárias
// ----------------------

const PADRAO_LINK_IMOVEL =
  /\/imovel(\/|\?)|\/imoveis\/[^\"']*\/(\d+)|\/detalhes\/(\d+)|\/propriedade\/(\d+)|\/[a-z-]+\/[a-z-]+\/[a-z-]+\/\d+/i;

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

function buscarImgEmTrecho(trechoHtml) {
  const padroes = [
    /<img[^>]+src=[\"']([^\"']+)[\"']/gi,
    /<img[^>]+data-src=[\"']([^\"']+)[\"']/gi,
    /<img[^>]+srcset=[\"']([^\"',\s]+)/gi,
  ];
  for (const padrao of padroes) {
    const encontrados = [...trechoHtml.matchAll(padrao)]
      .map(m => m[1])
      .filter(url => url && !/logo|icone|icon|avatar|placeholder|\.svg/i.test(url));
    if (encontrados.length > 0) return encontrados[encontrados.length - 1];
  }
  return "";
}

function extrairImagem(anchorHtmlBruto, precedendoHtmlBruto, baseUrl) {
  let encontrada = buscarImgEmTrecho(anchorHtmlBruto);
  if (!encontrada) encontrada = buscarImgEmTrecho(precedendoHtmlBruto);
  return resolverUrlImagem(encontrada, baseUrl);
}

function removerScriptsEEstilos(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function extrairCards(htmlBruto, baseUrl, nomeFonte) {
  const resultados = [];
  const vistos = new Set();
  const html = removerScriptsEEstilos(htmlBruto);

  const regexLink = /<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regexLink.exec(html)) !== null) {
    let href = match[1];
    const anchorHtmlBruto = match[2];
    const textoLink = limparTexto(anchorHtmlBruto.replace(/<[^>]+>/g, " "));

    if (!PADRAO_LINK_IMOVEL.test(href)) continue;

    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = base.origin + href;
    }
    if (vistos.has(href)) continue;
    vistos.add(href);

    const inicioJanela = Math.max(0, match.index - 400);
    const fimJanela = Math.min(html.length, match.index + 400);
    const janelaHtml = html.slice(inicioJanela, fimJanela);
    const textoJanela = limparTexto(janelaHtml.replace(/<[^>]+>/g, " "));

    const precedendoImagem = html.slice(Math.max(0, match.index - 1200), match.index);
    const imagem = extrairImagem(anchorHtmlBruto, precedendoImagem, baseUrl);

    const textoPrincipal = textoLink.length > 25 ? textoLink : textoJanela;

    resultados.push({
      fonte: nomeFonte,
      titulo: textoLink || textoJanela.slice(0, 70) || "Imóvel",
      imagem,
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
    });
  }

  return resultados;
}

// ----------------------
// Fetch normal e ScrapingBee
// ----------------------

async function buscarDireto(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.text();
}

async function buscarComJS(url, apiKey) {
  const endpoint =
    "https://app.scrapingbee.com/api/v1/?api_key=" +
    encodeURIComponent(apiKey) +
    "&url=" +
    encodeURIComponent(url) +
    "&render_js=true";

  const resp = await fetch(endpoint);
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    throw new Error("ScrapingBee HTTP " + resp.status + " " + corpo.slice(0, 200));
  }
  return await resp.text();
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

  const apiKeyScrapingBee = process.env.SCRAPINGBEE_API_KEY || "";

  const todos = [];
  const erros = [];

  for (const fonte of fontes) {
    console.log(
      `Buscando: ${fonte.nome} (${fonte.url})${fonte.jsNecessario ? " [via ScrapingBee]" : ""}`
    );

    try {
      let html;

      if (fonte.jsNecessario) {
        if (!apiKeyScrapingBee) {
          const msg = `${fonte.nome}: precisa de JavaScript, mas SCRAPINGBEE_API_KEY não está configurada. Busca pulada.`;
          console.warn(msg);
          erros.push(msg);
          continue;
        }
        html = await buscarComJS(fonte.url, apiKeyScrapingBee);
      } else {
        html = await buscarDireto(fonte.url);
      }

      const itens = extrairCards(html, fonte.url, fonte.nome);
      todos.push(...itens);

      console.log(`  -> ${itens.length} imóveis encontrados`);

      if (itens.length === 0) {
        const contemImovel = (html.match(/\/imovel\//gi) || []).length;
        const contemComprar = (html.match(/\/(comprar|alugar)\//gi) || []).length;
        const pareceBloqueio = /captcha|access denied|cloudflare|habilite o javascript/i.test(html);

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

  const saida = {
    atualizadoEm: new Date().toISOString(),
    imoveis: todos,
    erros,
  };

  await writeFile(
    new URL("../imoveis.json", import.meta.url),
    JSON.stringify(saida, null, 2),
    "utf-8"
  );

  console.log(`\nTotal: ${todos.length} imóveis salvos em imoveis.json`);
  if (erros.length > 0) {
    console.log(`Avisos/erros: ${erros.length}`);
  }
}

main().catch(e => {
  console.error("Falha geral no script:", e);
  process.exit(1);
});
