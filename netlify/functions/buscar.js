// netlify/functions/buscar.js
//
// Esta funcao roda no SERVIDOR do Netlify (nao no navegador de quem
// acessa o site). Por isso ela NAO tem problema de CORS e nao precisa
// de nenhum servico de proxy de terceiro - ela mesma faz as requisicoes
// para os sites de imoveis, direto de servidor para servidor.
//
// Fica disponivel automaticamente em: /.netlify/functions/buscar

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

function extrairBairro(texto) {
  const m = texto.match(/(?:em|no|na)\s+([A-ZÀ-Ú][\wÀ-ú\s]{2,40})/);
  return m ? limparTexto(m[1]) : "";
}

// Um link e considerado "imovel" se bater com qualquer um destes padroes:
// - Grupo Kaion:            /imovel/algo/CODIGO
// - Residencial Imoveis:    /comprar/sp/cidade/bairro/tipo/123456
//                           /comprar-ou-alugar/sp/cidade/bairro/tipo/123456
//                           /alugar/sp/cidade/bairro/tipo/123456
const PADRAO_LINK_IMOVEL = /\/imovel\/|\/(comprar|comprar-ou-alugar|alugar)\/[^"']*\/\d+/i;

// Extrai cards de imovel de um HTML generico, procurando links que
// batam com PADRAO_LINK_IMOVEL e olhando o texto ao redor de cada link.
function extrairCards(html, baseUrl, nomeFonte) {
  const resultados = [];
  const vistos = new Set();

  // Acha todos os links <a href="...">texto</a>
  const regexLink = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regexLink.exec(html)) !== null) {
    let href = match[1];
    const textoLink = limparTexto(match[2].replace(/<[^>]+>/g, " "));

    if (!PADRAO_LINK_IMOVEL.test(href)) continue;

    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = base.origin + href;
    }
    if (vistos.has(href)) continue;
    vistos.add(href);

    // Pega uma janela de texto ao redor da posicao do link no HTML,
    // pra capturar preco/quartos/area que normalmente ficam no mesmo card.
    const inicioJanela = Math.max(0, match.index - 1500);
    const fimJanela = Math.min(html.length, match.index + 1500);
    const janelaHtml = html.slice(inicioJanela, fimJanela);
    const textoJanela = limparTexto(janelaHtml.replace(/<[^>]+>/g, " "));

    resultados.push({
      fonte: nomeFonte,
      titulo: textoLink || "Imóvel",
      preco: extrairPreco(textoJanela),
      quartos: extrairQuartos(textoJanela),
      area: extrairArea(textoJanela),
      bairro: extrairBairro(textoJanela),
      link: href,
    });
  }

  return resultados;
}

const FONTES = [
  {
    nome: "Residencial Imóveis",
    url: "https://www.residencialimoveis.com.br/imoveis/casa",
  },
  {
    nome: "Grupo Kaion",
    url: "https://www.grupokaion.com.br/imoveis/a-venda/casa/itu",
  },
];

export default async () => {
  const todos = [];
  const erros = [];

  for (const fonte of FONTES) {
    try {
      const resp = await fetch(fonte.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const html = await resp.text();
      const itens = extrairCards(html, fonte.url, fonte.nome);
      todos.push(...itens);

      if (itens.length === 0) {
        // Diagnostico: ajuda a entender POR QUE veio vazio, sem precisar
        // adivinhar (ex: pagina bloqueou o pedido e devolveu outra coisa,
        // ou o padrao de link mudou).
        const contemImovel = (html.match(/\/imovel\//gi) || []).length;
        const contemComprar = (html.match(/\/(comprar|alugar)\//gi) || []).length;
        const pareceBloqueio = /captcha|access denied|cloudflare|habilite o javascript/i.test(html);
        erros.push(
          `${fonte.nome}: 0 imóveis encontrados. HTML recebido: ${html.length} caracteres. ` +
          `Ocorrências de "/imovel/": ${contemImovel}. Ocorrências de "/comprar/" ou "/alugar/": ${contemComprar}. ` +
          `Sinal de bloqueio/JS detectado: ${pareceBloqueio ? "SIM" : "não"}.`
        );
      }
    } catch (e) {
      erros.push(`${fonte.nome}: ${e.message}`);
    }
  }

  return new Response(
    JSON.stringify({ imoveis: todos, erros }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};
