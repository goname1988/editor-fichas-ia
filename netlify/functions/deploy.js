// Netlify Function: deploy.js
// Recibe un zip (base64) desde el editor y lo publica en un site nuevo de Netlify
// con nombre custom. Token guardado en env var NETLIFY_TOKEN (NUNCA en el frontend).
//
// POST /.netlify/functions/deploy
// Body: { "name": "venta-cordon-ia-0042", "zipBase64": "<base64 del zip>" }
// Respuesta: { "url": "https://venta-cordon-ia-0042.netlify.app", "siteId": "..." }
//            o { "error": "..." } con status >=400

export default async (req) => {
  // CORS: solo para caso de que el editor se abra desde otro origen (file://, otro dominio)
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const TOKEN = Netlify.env.get('NETLIFY_TOKEN');
  if (!TOKEN) {
    return new Response(JSON.stringify({ error: 'Falta env var NETLIFY_TOKEN en el sitio' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Body no es JSON válido' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const { name, zipBase64 } = body;
  if (!name || !zipBase64) {
    return new Response(JSON.stringify({ error: 'Faltan parámetros: name y zipBase64' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Validar nombre: solo minúsculas, números y guiones (regla Netlify)
  const nameOk = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name);
  if (!nameOk) {
    return new Response(JSON.stringify({ error: 'Nombre inválido. Solo minúsculas, números y guiones, entre 3 y 63 caracteres.' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // 1. Buscar si ya existe un site con ese nombre (reusar en vez de crear duplicado)
  let site = null;
  try {
    const listRes = await fetch(`https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(name)}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      // La API devuelve TODOS los sites que empiezan con el nombre; filtrar por match exacto
      site = list.find(s => s.name === name) || null;
    }
  } catch (e) {
    // no bloquea; sigue al create
  }

  // 2. Si no existe, crearlo
  if (!site) {
    const createRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ name }),
    });
    if (createRes.status === 422) {
      return new Response(JSON.stringify({ error: `El nombre "${name}" ya está tomado por otra cuenta. Elegí otro.` }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!createRes.ok) {
      const errText = await createRes.text();
      return new Response(JSON.stringify({ error: `No se pudo crear el sitio: ${errText}` }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    site = await createRes.json();
  }

  // 3. Deploy del zip
  const zipBytes = Uint8Array.from(atob(zipBase64), c => c.charCodeAt(0));
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'Authorization': `Bearer ${TOKEN}` },
    body: zipBytes,
  });
  if (!deployRes.ok) {
    const errText = await deployRes.text();
    return new Response(JSON.stringify({ error: `Deploy falló: ${errText}` }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const deploy = await deployRes.json();

  return new Response(JSON.stringify({
    url: site.ssl_url || site.url,
    siteId: site.id,
    deployId: deploy.id,
    state: deploy.state,
  }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
};
