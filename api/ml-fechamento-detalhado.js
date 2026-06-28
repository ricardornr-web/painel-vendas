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

      // Nomes de campo abaixo espelham 1:1 as colunas da aba "Base Final" do
      // modelo Excel — só as que são possíveis de obter via /orders/search,
      // sem chamada extra por pedido (ver ALTERACAO_mlAuth / decisão registrada
      // no chat: colunas de tarifa/frete/dados do comprador/status narrativo
      // ficam de fora por exigirem o relatório manual ou custar 1 call/pedido).
      linhas.push({
        Empresa: nomeConta,
        PRODUTO: dadosProduto?.produto ?? null,
        COR: dadosProduto?.cor ?? null,
        TAMANHO: dadosProduto?.tamanho ?? null,
        UNIDADE: dadosProduto?.unidade ?? null,
        Custo: dadosProduto?.custo ?? null,
        'Custo total': custoTotal != null ? Math.round(custoTotal * 100) / 100 : null,
        'Margem bruta': margemBruta != null ? Math.round(margemBruta * 100) / 100 : null,
        'Margem %': margemPercentual != null ? Math.round(margemPercentual * 100) / 100 : null,

        'N.º de venda': order.id,
        'Data da venda': order.date_created,
        Unidades: quantidade,
        'Receita por produtos (BRL)': Math.round(receitaBruta * 100) / 100,
        SKU: sku ?? null,
        '# de anúncio': codigoAnuncio ?? null,
        'Canal de venda': 'Mercado Livre',
        'Título do anúncio': titulo ?? null,
        'Preço unitário de venda do anúncio (BRL)': precoUnitario,
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
    const totalNaoMapeados = linhas.filter((l) => l.PRODUTO === null).length;

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
