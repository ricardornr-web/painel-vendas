const tabelaAuxiliar = require('../data/tabela_auxiliar.json');

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Resolve produto/cor/tamanho/unidade/custo a partir do SKU (com fallback por título).
// Espelha a lógica de preencher_colunas() do script Python: cruza primeiro por SKU,
// se não encontrar, cai para o título normalizado.
// Retorna null se não encontrar em nenhum dos dois — quem chamar decide o que fazer
// (ex: contabilizar como "não mapeado", mas não inventar custo).
function resolverDadosProduto({ sku, titulo }) {
  if (sku) {
    const chaveSku = normalizar(sku);
    if (tabelaAuxiliar.by_sku[chaveSku]) {
      return { ...tabelaAuxiliar.by_sku[chaveSku], origemMatch: 'sku' };
    }
  }
  if (titulo) {
    const chaveTitulo = normalizar(titulo);
    if (tabelaAuxiliar.by_titulo[chaveTitulo]) {
      return { ...tabelaAuxiliar.by_titulo[chaveTitulo], origemMatch: 'titulo' };
    }
  }
  return null;
}

module.exports = { resolverDadosProduto, normalizar };
