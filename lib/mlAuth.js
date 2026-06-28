const { createClient } = require('redis');

const ML_API = 'https://api.mercadolibre.com';

// Cliente Redis reutilizável entre invocações (a function fica "quente" por um tempo).
let redisClient = null;
async function getRedisClient() {
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: process.env.KV_REDIS_URL });
  await redisClient.connect();
  return redisClient;
}

// Wrapper simples imitando a API do @vercel/kv (get/set) usada no resto do arquivo.
const kv = {
  async get(key) {
    const client = await getRedisClient();
    return client.get(key);
  },
  async set(key, value) {
    const client = await getRedisClient();
    return client.set(key, String(value));
  },
};

// Cada conta tem suas próprias credenciais completas (client_id, client_secret,
// refresh_token inicial). As env vars seguem o padrão ML_<CONTA>_CLIENT_ID etc.
function getContasConfig() {
  return [
    {
      nome: 'Ricapet',
      clientId: process.env.ML_RICAPET_CLIENT_ID,
      clientSecret: process.env.ML_RICAPET_CLIENT_SECRET,
      refreshTokenEnv: process.env.ML_RICAPET_REFRESH_TOKEN,
    },
    {
      nome: 'Thapets',
      clientId: process.env.ML_THAPETS_CLIENT_ID,
      clientSecret: process.env.ML_THAPETS_CLIENT_SECRET,
      refreshTokenEnv: process.env.ML_THAPETS_REFRESH_TOKEN,
    },
  ];
}

// O refresh_token é invalidado a cada uso pelo ML, então o token "atual" fica
// guardado no Vercel KV. Se não houver nada no KV ainda, usa o valor inicial
// das env vars (primeira execução).
async function getRefreshTokenAtual(nomeConta) {
  const chave = `ml:refresh_token:${nomeConta}`;
  const salvo = await kv.get(chave);
  if (salvo) return salvo;
  const conta = getContasConfig().find((c) => c.nome === nomeConta);
  return conta ? conta.refreshTokenEnv : null;
}

async function salvarTokens(nomeConta, { access_token, refresh_token, expires_in }) {
  const expiraEm = Date.now() + expires_in * 1000 - 60_000; // margem de 60s
  await kv.set(`ml:access_token:${nomeConta}`, access_token);
  await kv.set(`ml:access_token_expira:${nomeConta}`, expiraEm);
  await kv.set(`ml:refresh_token:${nomeConta}`, refresh_token);
}

async function renovarToken(conta) {
  const refreshToken = await getRefreshTokenAtual(conta.nome);
  if (!refreshToken) {
    throw new Error(`Refresh token ausente para a conta ${conta.nome}`);
  }

  const resp = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: conta.clientId,
      client_secret: conta.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`Falha ao renovar token de ${conta.nome}: ${resp.status} ${texto}`);
  }

  const dados = await resp.json();
  await salvarTokens(conta.nome, dados);
  return dados.access_token;
}

// Retorna um access_token válido para a conta, renovando se necessário.
async function getAccessToken(nomeConta) {
  const conta = getContasConfig().find((c) => c.nome === nomeConta);
  if (!conta) throw new Error(`Conta desconhecida: ${nomeConta}`);

  const tokenSalvo = await kv.get(`ml:access_token:${nomeConta}`);
  const expiraEm = await kv.get(`ml:access_token_expira:${nomeConta}`);

  if (tokenSalvo && expiraEm && Date.now() < Number(expiraEm)) {
    return tokenSalvo;
  }

  return renovarToken(conta);
}

async function chamarApiML(path, accessToken, params = {}) {
  const url = new URL(`${ML_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`Erro na API ML (${path}): ${resp.status} ${texto}`);
  }

  return resp.json();
}

module.exports = { getContasConfig, getAccessToken, renovarToken, chamarApiML, ML_API, kv };
