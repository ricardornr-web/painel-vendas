// Regra de negócio definida com o usuário:
// - Conta como venda: pedido pago ("paid"), mesmo que ainda em trânsito/não entregue
// - Não conta: cancelado, devolvido, ou com reclamação/mediação aberta sem resultado

function pedidoContaComoVenda(order) {
  if (!order) return false;

  // status estruturado do pedido na API do ML
  // valores possíveis: confirmed, payment_required, payment_in_process, paid,
  // partially_paid, cancelled, invalid
  if (order.status !== 'paid' && order.status !== 'partially_paid') {
    return false;
  }

  // tags do pedido podem indicar disputa/mediação em andamento
  const tags = order.tags || [];
  if (tags.includes('fraud_risk_detected')) return false;

  // mediations / claims abertas (sem resultado definido) não contam
  if (order.mediations && order.mediations.length > 0) {
    const temMediacaoAberta = order.mediations.some(
      (m) => m.status && !['closed', 'resolved'].includes(m.status)
    );
    if (temMediacaoAberta) return false;
  }

  return true;
}

module.exports = { pedidoContaComoVenda };
