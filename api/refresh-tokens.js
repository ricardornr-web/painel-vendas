const { getContasConfig, renovarToken } = require('../lib/mlAuth');

// Executado automaticamente pelo Vercel Cron (ver vercel.json) a cada hora.
// Garante que o access_token de cada conta esteja sempre fresco, e atualiza
// o refresh_token guardado no KV (o ML invalida o anterior a cada renovação).
module.exports = async function handler(req, res) {
  const segredoEsperado = process.env.CRON_SECRET;
  const segredoRecebido = req.headers['authorization']?.replace('Bearer ', '');
  if (segredoEsperado && segredoRecebido !== segredoEsperado) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }

  const contas = getContasConfig();
  const resultados = [];

  for (const conta of contas) {
    try {
      await renovarToken(conta);
      resultados.push({ conta: conta.nome, status: 'ok' });
    } catch (erro) {
      console.error(`Falha ao renovar token de ${conta.nome}:`, erro);
      resultados.push({ conta: conta.nome, status: 'erro', mensagem: erro.message });
    }
  }

  return res.status(200).json({ resultados });
};
