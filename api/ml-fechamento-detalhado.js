const { getContasConfig, getAccessToken, chamarApiML } = require('../lib/mlAuth');
const { resolverDadosProduto } = require('../lib/tabelaAuxiliar');
const { pedidoContaComoVenda } = require('../lib/regraVenda');

// Mesma paginação por offset já usada em ml-vendas.js / ml-fechamento.js
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
    if (offset > 20000) break;
  }
  return pedidos;
}

// Gera uma linha por item de venda (= "Base Final"), só com o que de fato vendeu.
// Sem cruzamento bem-sucedido, os campos do produto ficam null e a linha entra
// mesmo assim em naoMapeados para revisão futura.
function montarBaseFinal(pedidos, nomeConta) {
  const linhas = [];

  for (const order of pedidos) {
    if (!pedidoContaComoVenda(order)) continue;

    for (const item of order.order_items || []) {
      const sku = item.item?.seller_sku || item.item?.seller_custom_field;
      const titulo = item.item?.title;
      const codigoAnuncio = item.item?.id;
      const quantidade = item.quantity || 0;
      const precoUnitario = item.unit_price ?? item.full_unit_price ?? 0;
      const receitaBruta = precoUnitario * quantidade;

      const dadosProduto = resolverDadosProduto({ sku, titulo });

      const custoTotal =
        dadosProduto && dadosProduto.custo != null
          ? dadosProduto.custo * (dadosProduto.unidade || 1) * quantidade
          : null;
      const margemBruta = custoTotal != null ? receitaBruta - custoTotal : null;
      const margemPercentual =
        margemBruta != null && receitaBruta > 0 ? (margemBruta / receitaBruta) * 100 : null;

      linhas.push({
        // --- colunas vindas do cruzamento com a TABELA_AUXILIAR ---
        empresa: nomeConta,
        produto: dadosProduto?.produto ?? null,
        cor: dadosProduto?.cor ?? null,
        tamanho: dadosProduto?.tamanho ?? null,
        unidade: dadosProduto?.unidade ?? null,
        custoUnitario: dadosProduto?.custo ?? null,
        custoTotal: custoTotal != null ? Math.round(custoTotal * 100) / 100 : null,
        margemBruta: margemBruta != null ? Math.round(margemBruta * 100) / 100 : null,
        margemPercentual:
          margemPercentual != null ? Math.round(margemPercentual * 100) / 100 : null,

        // --- colunas vindas diretamente do relatório/API do ML ---
        numeroVenda: order.id,
        dataVenda: order.date_created,
        estado: order.status,
        skuItem: sku ?? null,
        codigoAnuncio: codigoAnuncio ?? null,
        tituloAnuncio: titulo ?? null,
        unidadesVendidas: quantidade,
        precoUnitarioVenda: precoUnitario,
        receitaPorProdutos: Math.round(receitaBruta * 100) / 100,
      });
    }
  }

  return linhas;
}

async function buscarBaseFinalDaConta(conta, dataInicio, dataFim) {
  const accessToken = await getAccessToken(conta.nome);
  const meResp = await chamarApiML('/users/me', accessToken);
  const sellerId = meResp.id;
  const pedidos = await buscarTodosPedidos(accessToken, sellerId, dataInicio, dataFim);
  return montarBaseFinal(pedidos, conta.nome);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { dataInicio, dataFim } = req.query;

    if (!dataInicio || !dataFim) {
      return res.status(400).json({
        erro: 'Parâmetros obrigatórios: dataInicio e dataFim (formato ISO, ex: 2026-06-01T00:00:00.000-00:00)',
      });
    }

    const contas = getContasConfig();
    const resultadosPorConta = await Promise.all(
      contas.map((conta) => buscarBaseFinalDaConta(conta, dataInicio, dataFim))
    );

    const linhas = resultadosPorConta.flat();
    const totalNaoMapeados = linhas.filter((l) => l.produto === null).length;

    return res.status(200).json({
      linhas,
      totalLinhas: linhas.length,
      totalNaoMapeados,
      geradoEm: new Date().toISOString(),
      periodo: { dataInicio, dataFim },
    });
  } catch (erro) {
    console.error('Erro ao gerar Base Final:', erro);
    return res.status(500).json({ erro: erro.message });
  }
};
