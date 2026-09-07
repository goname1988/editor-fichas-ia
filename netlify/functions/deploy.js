// Netlify Function: deploy.js (v2 — file digests)
// Publica una ficha en Netlify usando el protocolo "file digests" — mismo
// mecanismo que Netlify CLI y Netlify Drop. Cada request individual del cliente
// pesa poco (SHA1s son ~40 bytes por archivo, y las fotos individuales son <1MB
// cada una), así que NUNCA se excede el límite de 6MB del body de las Functions.
//
// El editor invoca 3 acciones distintas:
//
// 1) INIT — POST /.netlify/functions/deploy
//    Body JSON: { "name":"venta-cordon-alq-p015", "files":{ "/index.html":"sha1...", "/fotos/foto-0.jpg":"sha1..." } }
//    Retorna:   { deployId, siteId, siteUrl, required:[sha1,...], state }
//    Crea (o reusa) el site + inicia el deploy con los digests.
//
// 2) UPLOAD — POST /.netlify/functions/deploy?action=upload&deployId=X&path=/foto.jpg
//    Body: bytes crudos del archivo (Content-Type: application/octet-stream).
//    Retorna: { ok: true }
//    Sube UN archivo del deploy iniciado. El editor llama esto por cada sha1
//    de `required`.
//
// 3) CHECK — POST /.netlify/functions/deploy?action=check
//    Body JSON: { "deployId": "..." }
//    Retorna: { state: "ready"|"processing"|"error", url }
//    Polea el estado del deploy. El editor polea hasta que state == "ready".

export default async (req) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const jsonErr = (status, msg) => new Response(
    JSON.stringify({ error: msg }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
  const json200 = (obj) => new Response(
    JSON.stringify(obj),
    { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return jsonErr(405, 'Method not allowed');

  const TOKEN = Netlify.env.get('NETLIFY_TOKEN');
  if (!TOKEN) return jsonErr(500, 'Falta env var NETLIFY_TOKEN en el sitio');

  const reqUrl = new URL(req.url);
  const action = reqUrl.searchParams.get('action') || 'init';

  // ============================================================
  // ACTION: UPLOAD — subir bytes de un archivo al deploy
  // ============================================================
  if (action === 'upload') {
    const deployId = reqUrl.searchParams.get('deployId');
    const path = reqUrl.searchParams.get('path');  // ej "/index.html" o "/fotos/foto-0.jpg"
    if (!deployId || !path) return jsonErr(400, 'Faltan deployId o path');
    // Validación básica del path (path traversal etc)
    if (!path.startsWith('/') || path.includes('..')) return jsonErr(400, 'path inválido');

    let bytes;
    try { bytes = new Uint8Array(await req.arrayBuffer()); }
    catch (e) { return jsonErr(400, 'No se pudo leer el body binario'); }
    if (bytes.length === 0) return jsonErr(400, 'Body vacío');

    const putRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}/files${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Authorization': `Bearer ${TOKEN}` },
      body: bytes,
    });
    if (!putRes.ok) {
      const errText = await putRes.text();
      return jsonErr(500, `PUT falló (status ${putRes.status}): ${errText.slice(0, 300)}`);
    }
    return json200({ ok: true, path, size: bytes.length });
  }

  // ============================================================
  // ACTION: CHECK — consultar estado del deploy
  // ============================================================
  if (action === 'check') {
    let body;
    try { body = await req.json(); } catch (e) { return jsonErr(400, 'Body no es JSON'); }
    const deployId = body.deployId;
    if (!deployId) return jsonErr(400, 'Falta deployId');

    const getRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (!getRes.ok) {
      const errText = await getRes.text();
      return jsonErr(500, `Consulta falló: ${errText.slice(0, 200)}`);
    }
    const dep = await getRes.json();
    return json200({
      state: dep.state,
      url: dep.ssl_url || dep.deploy_ssl_url || dep.url || null,
      errorMessage: dep.error_message || null,
    });
  }

  // ============================================================
  // ACTION: INIT (default) — crear/reusar site + iniciar deploy
  // ============================================================
  let body;
  try { body = await req.json(); }
  catch (e) { return jsonErr(400, 'Body no es JSON válido'); }

  const { name, files } = body;
  if (!name) return jsonErr(400, 'Falta name');
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return jsonErr(400, 'Falta files (objeto {path: sha1})');
  }
  const nameOk = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name);
  if (!nameOk) return jsonErr(400, 'Nombre inválido. Solo minúsculas, números y guiones, entre 3 y 63 caracteres.');

  // Validar que cada valor de files sea un sha1 hex de 40 chars
  for (const [path, sha] of Object.entries(files)) {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
      return jsonErr(400, `SHA1 inválido para ${path}`);
    }
    if (!path.startsWith('/')) {
      return jsonErr(400, `path debe empezar con /: ${path}`);
    }
  }

  // 1. Buscar site existente por nombre exacto
  let site = null;
  try {
    const listRes = await fetch(`https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(name)}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      site = list.find(s => s.name === name) || null;
    }
  } catch (e) { /* sigue al create */ }

  // 2. Crear si no existe
  if (!site) {
    const createRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ name }),
    });
    if (createRes.status === 422) {
      return jsonErr(409, `El nombre "${name}" ya está tomado por otra cuenta. Elegí otro.`);
    }
    if (!createRes.ok) {
      const errText = await createRes.text();
      return jsonErr(500, `No se pudo crear el sitio: ${errText.slice(0, 300)}`);
    }
    site = await createRes.json();
  }

  // 3. Iniciar deploy con file digests
  //    Netlify va a responder con `required: [sha1s]` — los archivos que NO tiene ya cacheados.
  //    El editor sube esos con action=upload.
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ files }),
  });
  if (!deployRes.ok) {
    const errText = await deployRes.text();
    return jsonErr(500, `Init deploy falló (status ${deployRes.status}): ${errText.slice(0, 300)}`);
  }
  const deploy = await deployRes.json();

  return json200({
    deployId: deploy.id,
    siteId: site.id,
    siteUrl: site.ssl_url || site.url,
    required: deploy.required || [],
    state: deploy.state,
  });
};
