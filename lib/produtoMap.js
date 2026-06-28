const produtoMap = require('../data/produto_map.json');

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Resolve o nome "limpo" do produto a partir do código de anúncio (MLB...),
// com fallback por SKU e depois por título normalizado.
// Se nada bater, retorna o próprio título do anúncio (ou um placeholder).
function resolverProduto({ codigoAnuncio, sku, titulo }) {
  if (codigoAnuncio && produtoMap.by_anuncio[codigoAnuncio]) {
    return produtoMap.by_anuncio[codigoAnuncio];
  }
  if (sku && produtoMap.by_sku[sku]) {
    return produtoMap.by_sku[sku];
  }
  if (titulo) {
    const key = normalizar(titulo);
    if (produtoMap.by_titulo[key]) {
      return produtoMap.by_titulo[key];
    }
  }
  return titulo || 'Produto não mapeado';
}

module.exports = { resolverProduto, normalizar };
