const { getContasConfig, getAccessToken, chamarApiML } = require('../lib/mlAuth');
const { resolverDadosProduto } = require('../lib/tabelaAuxiliar');
const { pedidoContaComoVenda } = require('../lib/regraVenda');
const { traduzirEstado } = require('../lib/statusEnvio');

// Acima desse número de pedidos, não buscamos status de envio individual —
// o risco de timeout da function supera o benefício. A tabela ainda é gerada
// normalmente, só sem a coluna "Estado" preenchida.
const LIMITE_PEDIDOS_PARA_BUSCAR_ENVIO = 3000;

// Quantas chamadas a /shipments/{id} disparamos em paralelo por vez.
// Mais alto = mais rápido, mas maior risco de rate limit da API do ML.
const TAMANHO_LOTE_SHIPMENTS = 15;

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

// Busca o status do shipment para uma lista de pedidos, em lotes paralelos
// controlados. Retorna um Map de order.id -> { estado, dataEntrega, rastreio }.
// Pedidos sem shipping_id (ex: "not_specified") ou com erro na chamada ficam
// de fora do Map — quem usa decide o fallback (null).
async function buscarStatusEnvioEmLote(pedidos, accessToken) {
  const mapaEstado = new Map();
  const pedidosComShipping = pedidos.filter((p) => p.shipping?.id);

  for (let i = 0; i < pedidosComShipping.length; i += TAMANHO_LOTE_SHIPMENTS) {
    const lote = pedidosComShipping.slice(i, i + TAMANHO_LOTE_SHIPMENTS);
    const resultados = await Promise.allSettled(
      lote.map((order) => chamarApiML(`/shipments/${order.shipping.id}`, accessToken))
    );

    resultados.forEach((resultado, idx) => {
      const order = lote[idx];
      if (resultado.status === 'fulfilled') {
        const shipment = resultado.value;
        mapaEstado.set(order.id, {
          estado: traduzirEstado(shipment.status, shipment.substatus),
          dataEntrega: shipment.status_history?.date_delivered ?? null,
          rastreio: shipment.tracking_number ?? null,
        });
      }
      // Em caso de falha (resultado.status === 'rejected'), o pedido simplesmente
      // não entra no mapa — a linha final mostra "Estado" como null, sem quebrar
      // o restante do relatório por causa de uma falha pontual.
    });
  }

  return mapaEstado;
}

// Gera uma linha por item de venda (= "Base Final"), só com o que de fato vendeu.
function montarBaseFinal(pedidos, nomeConta, mapaEstado) {
  const linhas = [];

  for (const order of pedidos) {
    if (!pedidoContaComoVenda(order)) continue;

    const infoEnvio = mapaEstado.get(order.id);

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

      // Nomes de campo espelham 1:1 as colunas da aba "Base Final" do modelo.
      // "Estado" é uma TRADUÇÃO APROXIMADA do status/substatus do shipment —
      // não reproduz o texto narrativo exato do relatório manual do ML
      // (ver lib/statusEnvio.js para detalhes da limitação).
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
        Estado: infoEnvio?.estado ?? null,
        Unidades: quantidade,
        'Receita por produtos (BRL)': Math.round(receitaBruta * 100) / 100,
        SKU: sku ?? null,
        '# de anúncio': codigoAnuncio ?? null,
        'Canal de venda': 'Mercado Livre',
        'Título do anúncio': titulo ?? null,
        'Preço unitário de venda do anúncio (BRL)': precoUnitario,
        'Número de rastreamento': infoEnvio?.rastreio ?? null,
        'Data de entrega': infoEnvio?.dataEntrega ?? null,
      });
    }
  }

  return linhas;
}

async function buscarBaseFinalDaConta(conta, dataInicio, dataFim, buscarEnvio) {
  const accessToken = await getAccessToken(conta.nome);
  const meResp = await chamarApiML('/users/me', accessToken);
  const sellerId = meResp.id;
  const pedidos = await buscarTodosPedidos(accessToken, sellerId, dataInicio, dataFim);

  const mapaEstado = buscarEnvio
    ? await buscarStatusEnvioEmLote(pedidos, accessToken)
    : new Map();

  return montarBaseFinal(pedidos, conta.nome, mapaEstado);
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

    // Primeiro busca a contagem de pedidos de cada conta (rápido) para decidir
    // se vale a pena buscar status de envio sem arriscar timeout.
    const tokensPorConta = await Promise.all(
      contas.map(async (conta) => ({ conta, accessToken: await getAccessToken(conta.nome) }))
    );

    let totalPedidosEstimado = 0;
    for (const { accessToken } of tokensPorConta) {
      const sellerId = (await chamarApiML('/users/me', accessToken)).id;
      const resp = await chamarApiML('/orders/search', accessToken, {
        seller: sellerId,
        'order.date_created.from': dataInicio,
        'order.date_created.to': dataFim,
        limit: 1,
        offset: 0,
      });
      totalPedidosEstimado += resp.paging?.total ?? 0;
    }

    const buscarEnvio = totalPedidosEstimado <= LIMITE_PEDIDOS_PARA_BUSCAR_ENVIO;

    const resultadosPorConta = await Promise.all(
      contas.map((conta) => buscarBaseFinalDaConta(conta, dataInicio, dataFim, buscarEnvio))
    );

    const linhas = resultadosPorConta.flat();
    const totalNaoMapeados = linhas.filter((l) => l.PRODUTO === null).length;

    return res.status(200).json({
      linhas,
      totalLinhas: linhas.length,
      totalNaoMapeados,
      estadoEnvioIncluido: buscarEnvio,
      avisoEstadoEnvio: buscarEnvio
        ? null
        : `Período com ${totalPedidosEstimado} pedidos (limite: ${LIMITE_PEDIDOS_PARA_BUSCAR_ENVIO}). Coluna "Estado" não foi buscada para evitar timeout — tente um período menor se precisar dela.`,
      geradoEm: new Date().toISOString(),
      periodo: { dataInicio, dataFim },
    });
  } catch (erro) {
    console.error('Erro ao gerar Base Final:', erro);
    return res.status(500).json({ erro: erro.message });
  }
};
