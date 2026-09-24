// Image proxy: adds CORS so external team logos can be drawn onto a canvas.
exports.handler = async function(event){
  try{
    var url = (event.queryStringParameters && event.queryStringParameters.url) || '';
    if (!/^https:\/\//i.test(url)) return { statusCode:400, body:'bad url' };
    var host='';
    try { host = new URL(url).hostname.toLowerCase(); } catch(e){ return { statusCode:400, body:'bad url' }; }
    if (host==='localhost' || host==='127.0.0.1' || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { statusCode:403, body:'blocked' };
    var resp = await fetch(url, { redirect:'follow', headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/png,image/*,*/*',
      'Referer': 'https://brawlify.com/'
    } });
    if (!resp.ok) return { statusCode: resp.status, body:'fetch failed' };
    var ct = resp.headers.get('content-type') || '';
    if (ct.indexOf('image') !== 0) return { statusCode:415, body:'not an image' };
    var buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 3000000) return { statusCode:413, body:'too large' };
    return {
      statusCode:200,
      headers:{ 'Content-Type': ct, 'Access-Control-Allow-Origin':'*', 'Cache-Control':'public, max-age=86400' },
      body: buf.toString('base64'),
      isBase64Encoded:true
    };
  }catch(e){ return { statusCode:500, body:'error' }; }
};
