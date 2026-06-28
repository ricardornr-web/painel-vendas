const { getContasConfig, getAccessToken, chamarApiML, kv } = require('../lib/mlAuth');
const { resolverDadosProduto } = require('../lib/tabelaAuxiliar');
const { pedidoContaComoVenda } = require('../lib/regraVenda');

function mesDaData(isoDate) {
  return isoDate.slice(0, 7); // "2026-03-15T..." -> "2026-03"
}

// Mesma lógica de paginação por offset que já existe em ml-vendas.js.
// ETAPA 1: ainda usa /orders/search (receita bruta). Tarifa/frete entram na Etapa 2.
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

// Para cada item vendido, cruza com a TABELA_AUXILIAR e calcula receita/custo/margem.
// Agrega por chave única: conta | produto | cor | tamanho | mês
function processarFechamento(pedidos, nomeConta) {
  const agregados = new Map();
  const naoMapeados = []; // itens que não bateram nem por SKU nem por título — ficam de fora do custo

  for (const order of pedidos) {
    if (!pedidoContaComoVenda(order)) continue;
    const mes = mesDaData(order.date_created);

    for (const item of order.order_items || []) {
      const sku = item.item?.seller_sku || item.item?.seller_custom_field;
      const titulo = item.item?.title;
      const codigoAnuncio = item.item?.id;
      const quantidade = item.quantity || 0;
      const precoUnitario = item.unit_price ?? item.full_unit_price ?? 0;
      const receitaBruta = precoUnitario * quantidade;

      const dadosProduto = resolverDadosProduto({ sku, titulo });

      if (!dadosProduto) {
        naoMapeados.push({ sku, titulo, codigoAnuncio, quantidade, receitaBruta, mes, conta: nomeConta });
        continue;
      }

      const { produto, cor, tamanho, unidade, custo } = dadosProduto;
      const chave = `${nomeConta}|${produto}|${cor}|${tamanho}|${mes}`;

      if (!agregados.has(chave)) {
        agregados.set(chave, {
          conta: nomeConta,
          produto,
          cor,
          tamanho,
          mes,
          unidades: 0,
          receitaBruta: 0,
          custoTotal: 0,
          custoUnitarioRef: custo, // guardado para referência/auditoria
        });
      }

      const acc = agregados.get(chave);
      acc.unidades += quantidade;
      acc.receitaBruta += receitaBruta;
      // Custo total = custo unitário cadastrado × unidades por venda (kits) × quantidade vendida
      if (custo != null) {
        acc.custoTotal += custo * (unidade || 1) * quantidade;
      }
    }
  }

  const linhas = [...agregados.values()].map((a) => {
    const margemBruta = a.custoTotal > 0 ? a.receitaBruta - a.custoTotal : null;
    const margemPercentual =
      margemBruta != null && a.receitaBruta > 0 ? (margemBruta / a.receitaBruta) * 100 : null;
    return {
      conta: a.conta,
      produto: a.produto,
      cor: a.cor,
      tamanho: a.tamanho,
      mes: a.mes,
      unidades: a.unidades,
      receitaBruta: Math.round(a.receitaBruta * 100) / 100,
      custoTotal: a.custoTotal > 0 ? Math.round(a.custoTotal * 100) / 100 : null,
      margemBruta: margemBruta != null ? Math.round(margemBruta * 100) / 100 : null,
      margemPercentual: margemPercentual != null ? Math.round(margemPercentual * 100) / 100 : null,
    };
  });

  return { linhas, naoMapeados };
}

async function buscarFechamentoDaConta(conta, dataInicio, dataFim) {
  const accessToken = await getAccessToken(conta.nome);
  const meResp = await chamarApiML('/users/me', accessToken);
  const sellerId = meResp.id;
  const pedidos = await buscarTodosPedidos(accessToken, sellerId, dataInicio, dataFim);
  return processarFechamento(pedidos, conta.nome);
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
      contas.map((conta) => buscarFechamentoDaConta(conta, dataInicio, dataFim))
    );

    const linhas = resultadosPorConta.flatMap((r) => r.linhas);
    const naoMapeados = resultadosPorConta.flatMap((r) => r.naoMapeados);

    const resultado = {
      linhas,
      totalNaoMapeados: naoMapeados.length,
      naoMapeados: naoMapeados.slice(0, 100), // limita o payload; lista completa fica só no Redis
      geradoEm: new Date().toISOString(),
      periodo: { dataInicio, dataFim },
      etapa: 1, // receita bruta — sem tarifa/frete/cancelamento ainda
    };

    // Snapshot salvo no Redis para consulta posterior sem precisar rechamar a API do ML
    const chaveSnapshot = `fechamento:${dataInicio.slice(0, 10)}_${dataFim.slice(0, 10)}`;
    await kv.set(chaveSnapshot, JSON.stringify(resultado));

    return res.status(200).json(resultado);
  } catch (erro) {
    console.error('Erro ao gerar fechamento:', erro);
    return res.status(500).json({ erro: erro.message });
  }
};
