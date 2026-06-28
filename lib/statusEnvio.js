// Traduz o par (status, substatus) do shipment do ML para um rótulo em
// português parecido com a coluna "Estado" do relatório nativo do ML.
//
// IMPORTANTE: isso é uma APROXIMAÇÃO. O relatório manual do ML monta esse texto
// combinando status/substatus + datas estimadas de entrega (lead_time) + regras
// internas não documentadas publicamente. Não é possível reproduzir 100% das
// variações (ex: "Para enviar no dia 16 de junho" tem data dinâmica embutida).
// Aqui ficamos só no rótulo do estado, sem a data.

const TRADUCAO_STATUS = {
  pending: 'Pendente',
  handling: 'Etiqueta impressa',
  ready_to_ship: 'Pronto para envio',
  shipped: 'A caminho',
  delivered: 'Entregue',
  not_delivered: 'Não entregue',
  cancelled: 'Venda cancelada',
};

// Alguns substatus merecem um rótulo mais específico que o status genérico.
// Chave: `${status}:${substatus}`
const TRADUCAO_SUBSTATUS = {
  'handling:waiting_for_label_generation': 'Aguardando geração de etiqueta',
  'handling:invoice_pending': 'Aguardando nota fiscal',
  'ready_to_ship:printed': 'Etiqueta impressa',
  'ready_to_ship:ready_to_print': 'Pronto para imprimir etiqueta',
  'shipped:first_visit': 'A caminho (primeira tentativa)',
  'shipped:delayed': 'A caminho (atrasado)',
  'shipped:in_hub': 'Em centro de distribuição',
  'shipped:out_for_delivery': 'Saiu para entrega',
  'not_delivered:second_attempt': 'Não entregue (2ª tentativa)',
  'cancelled:buyer_cancelled': 'Cancelado pelo comprador',
};

function traduzirEstado(status, substatus) {
  if (!status) return null;
  const chaveComposta = `${status}:${substatus}`;
  if (substatus && TRADUCAO_SUBSTATUS[chaveComposta]) {
    return TRADUCAO_SUBSTATUS[chaveComposta];
  }
  return TRADUCAO_STATUS[status] || status; // fallback: mostra o código bruto se não mapeado
}

module.exports = { traduzirEstado, TRADUCAO_STATUS, TRADUCAO_SUBSTATUS };
