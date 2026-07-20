// scripts/gerenciar-links.js
import { readFile, writeFile } from 'node:fs/promises';

const DIAS_EXPIRAR = 10;

async function main() {
  const acao = process.env.ACAO || 'listar-ativos';
  const linksPath = new URL('../links.json', import.meta.url);
  
  let dados;
  try {
    const raw = await readFile(linksPath, 'utf-8');
    dados = JSON.parse(raw);
  } catch (e) {
    console.log('📄 Nenhum links.json encontrado, criando novo...');
    dados = { links: {} };
  }

  if (acao === 'limpar-expirados') {
    const agora = Date.now();
    let removidos = 0;
    
    for (const [codigo, entrada] of Object.entries(dados.links || {})) {
      const criadoEm = new Date(entrada.criadoEm).getTime();
      const diasPassados = (agora - criadoEm) / (1000 * 60 * 60 * 24);
      if (diasPassados > DIAS_EXPIRAR) {
        delete dados.links[codigo];
        removidos++;
        console.log(`🗑️ Removido link expirado: ${codigo} (${diasPassados.toFixed(1)} dias)`);
      }
    }
    
    if (removidos > 0) {
      await writeFile(linksPath, JSON.stringify(dados, null, 2), 'utf-8');
      console.log(`✅ ${removidos} links expirados removidos`);
    } else {
      console.log('✅ Nenhum link expirado encontrado');
    }
  } 
  else if (acao === 'listar-ativos') {
    const agora = Date.now();
    const links = Object.entries(dados.links || {});
    
    if (links.length === 0) {
      console.log('📋 Nenhum link ativo encontrado');
      return;
    }
    
    console.log(`\n📋 ${links.length} LINKS ATIVOS:`);
    for (const [codigo, entrada] of links) {
      const criadoEm = new Date(entrada.criadoEm);
      const diasPassados = (agora - criadoEm.getTime()) / (1000 * 60 * 60 * 24);
      const status = diasPassados > DIAS_EXPIRAR ? '🔴 EXPIRADO' : '🟢 Ativo';
      console.log(`  ${codigo}: ${status} (${diasPassados.toFixed(1)} dias) - ${entrada.itens.length} imóveis`);
    }
  }
}

main().catch(console.error);
