const { getContasConfig, getAccessToken, chamarApiML } = require('../lib/mlAuth');
const { resolverProduto } = require('../lib/produtoMap');
const { pedidoContaComoVenda } = require('../lib/regraVenda');

// Cache em memória (dura enquanto a function fica "quente" entre invocações)
let cacheResultado = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

function mesDaData(isoDate) {
  return isoDate.slice(0, 7); // "2026-03-15T..." -> "2026-03"
}

async function buscarTodosPedidos(accessToken, sellerId, dataInicio, dataFim) {
  const pedidos = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await chamarApiML('/orders/search', accessToken, {
      seller: sellerId,
      'order.date_created.from': dataInicio,
      'order.date_created.to': dataFim,
      limit,
      offset,
      sort: 'date_asc',
    });

    pedidos.push(...resp.results);

    const total = resp.paging?.total ?? 0;
    offset += limit;
    if (offset >= total || resp.results.length === 0) break;
    if (offset > 20000) break; // proteção contra loop infinito
  }

  return pedidos;
}

// Agrega pedidos brutos em registros no formato {p, c, pr, m, brl, un}
function agregarPedidos(pedidos, nomeConta) {
  const agregados = new Map(); // chave: produto|mes -> {brl, un}

  for (const order of pedidos) {
    if (!pedidoContaComoVenda(order)) continue;

    const mes = mesDaData(order.date_created);

    for (const item of order.order_items || []) {
      const codigoAnuncio = item.item?.id;
      const sku = item.item?.seller_sku || item.item?.seller_custom_field;
      const titulo = item.item?.title;
      const quantidade = item.quantity || 0;
      const precoUnitario = item.unit_price ?? item.full_unit_price ?? 0;
      const valorTotal = precoUnitario * quantidade;

      const produto = resolverProduto({ codigoAnuncio, sku, titulo });
      const chave = `${produto}|${mes}`;

      if (!agregados.has(chave)) {
        agregados.set(chave, { produto, mes, brl: 0, un: 0 });
      }
      const acc = agregados.get(chave);
      acc.brl += valorTotal;
      acc.un += quantidade;
    }
  }

  return [...agregados.values()].map((a) => ({
    p: 'Mercado Livre',
    c: nomeConta,
    pr: a.produto,
    m: a.mes,
    brl: Math.round(a.brl * 100) / 100,
    un: a.un,
  }));
}

async function buscarVendasDaConta(conta, dataInicio, dataFim) {
  const accessToken = await getAccessToken(conta.nome);

  const meResp = await chamarApiML('/users/me', accessToken);
  const sellerId = meResp.id;

  const pedidos = await buscarTodosPedidos(accessToken, sellerId, dataInicio, dataFim);
  return agregarPedidos(pedidos, conta.nome);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const agora = Date.now();
    if (cacheResultado && agora - cacheTimestamp < CACHE_TTL_MS) {
      return res.status(200).json(cacheResultado);
    }

    const inicioDoAno = '2026-01-01T00:00:00.000-00:00';
    const hoje = new Date().toISOString().slice(0, 19) + '.000-00:00';

    const contas = getContasConfig();
    const resultadosPorConta = await Promise.all(
      contas.map((conta) => buscarVendasDaConta(conta, inicioDoAno, hoje))
    );

    const recs = resultadosPorConta.flat();

    const resultado = {
      recs,
      geradoEm: new Date().toISOString(),
    };

    cacheResultado = resultado;
    cacheTimestamp = agora;

    return res.status(200).json(resultado);
  } catch (erro) {
    console.error('Erro ao buscar vendas do ML:', erro);
    return res.status(500).json({ erro: erro.message });
  }
};
