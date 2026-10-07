const https = require('https');
const fs = require('fs');
const path = require('path');

const sampleTokens = [
  'AAAmJg58R2zvVFetLz01IRRlkTs5jYqocOTokasdBg6LcaD9Uhk8CzZ44tHnZO5g1fQpKnngXjd7wT_Q-itdVtImJg24ldBTwe2Ohov2uvLxcwaw5GJdN62WyUzVtV_28pmnUP8VvcL3f1oor5HQBF5pZFtdyEZjEAWEBoZMK6FLgtDbVp23E_Dhtumwk8KMCAgFl_UlUeRxslzzonwOvUPOkNnxaDJ5TQflq8bL_NQGLdg4dqMFkbK86arUNwfdpjIz1WEIAbgY0ILQte_Ix6-hNPaZMmV9vVtQapfZ9KYGgX2QbHoApNUl7FSvJQkJ2Xmtn1qeThXha_VVigRBXNty6wmx2eQZUwmAKCinUefUfe2iRSRJbtLuvnU6I5uJJixAYno_0gfacP8p3CdljBQo8xg5ZLc3FiUqBAi2_bshSSehyssFYFOLW5JUalqMnokXZLw1sMJf2ca9NIi11GW5KO39q7oJV4ocOSwVuoYJBoRS1xAuwAT',
  'AADr0GZyQWoO5qAAcxVNpz043P88niNFY9ts0WhFNoZR6ELGDlM0ssxlt74M0gCFpdSw2FrttItQsjAxzmNrMa5R9_hfy1ZlCyTVin9GLNGcnl3sAdYFQYSIWCtzgWMMyz9RzAQ3tm732ogJhPgQ26Ja02U4Ox3OpDvqWB2XquO3ZbTpmuthsgGRXEu9KPHXf_2_YZQOc9PGGv3_oECSU0i0MfZkfe2GNeiZ9Llo_na0Bxy02HV0X6n-h4U7WKrjqV-kOCoBwcoxgmWhCuzC60QWPucmzKXsP_EtJbBpgpFhlyh3-_vaqOURcubWb72-QoYYuaTZ8s8vsdoIykYlGWWoQMtVQh7xQ8csdpKCWL6PpQIR0A==',
  'AAArnpoyuBFfzxA-g0FkFFylL6PuuoGRFiTydQzXb-pffmfmp1Ar_1R06x71NlBNJAJy7aPeqvCLgkl500DZ9I6cfIopEzkzv_2F8BGNlzcU0KrQO7CsOn-rZqe8p-LuTl9fYo7Lud2RL0XYw2UPLbua0LV9xsn983C5psVyArUCcQZjI2Zzci4KCFOQDoX_vlTec9mBG-FGXOF3G1DFqJDawfLzmDhXbs2RxWRxqhNRWnpcgLAtWkixbINi3BovSmeQI0UpL8GgcAVk6BycaT_AJ4YElnQc80q6r4ffdM1Fscy9b6eU2gJArSc2y-D3avvOctNtJN51qTqtKIj9AQrbiKV_kNx3CroklihSKB03re-iq5sHB_K2W1cFt2XVDLtLliNXrYRzPm0QC_KTBwMRaAJcKerqxOP5vFvG4uNFTa1auH53WVxT1azaQgdYwr9qzG8awWCVGA-POQmrNgbKor37ig_wVnFSojVIUoIIO1nGwPO8tuf'
];

async function testUrl(targetPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'solatidebiosciences.com.au',
      port: 443,
      path: targetPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          path: targetPath,
          statusCode: res.statusCode,
          headers: res.headers,
          location: res.headers.location || null,
          bodyLength: body.length,
          title: (body.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || 'no title',
          isHtml: res.headers['content-type']?.includes('text/html'),
          bodySnippet: body.substring(0, 200).replace(/\s+/g, ' ')
        });
      });
    });
    req.on('error', (err) => resolve({ path: targetPath, error: err.message }));
    req.end();
  });
}

// Inspect token decoding
function inspectToken(token) {
  console.log('\n--- Inspecting token:', token.substring(0, 30) + '... (length: ' + token.length + ')');
  // Attempt Base64 url decode
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(base64, 'base64');
    console.log('Decoded buffer length:', buf.length);
    console.log('Hex prefix (first 32 bytes):', buf.slice(0, 32).toString('hex'));
    const ascii = buf.toString('latin1');
    // Check if there are any readable strings or URLs inside
    const printable = ascii.replace(/[^\x20-\x7E]/g, ' ');
    const urls = printable.match(/https?:\/\/[^\s]+/g) || [];
    const paths = printable.match(/\/[a-zA-Z0-9_\-\/]+/g) || [];
    console.log('Printable strings preview:', printable.substring(0, 150));
    console.log('URLs detected in payload:', urls);
    console.log('Paths detected in payload:', paths);
  } catch (e) {
    console.log('Decode error:', e.message);
  }
}

async function run() {
  console.log('=== 1. Testing Live HTTP Requests for /_t/c/v3/ ===');
  for (const token of sampleTokens) {
    const p = `/_t/c/v3/${token}`;
    const res = await testUrl(p);
    console.log(`Path: ${p.substring(0, 35)}...`);
    console.log(`  -> Status: ${res.statusCode}`);
    console.log(`  -> Redirect Location: ${res.location}`);
    console.log(`  -> Page Title: ${res.title}`);
    console.log(`  -> Body Length: ${res.bodyLength} bytes`);
  }

  console.log('\n=== 2. Testing Other Historical / Legacy Routes ===');
  const legacyRoutes = [
    '/policies/shipping-policy',
    '/policies/refund-policy',
    '/policies/privacy-policy',
    '/policies/terms-of-service',
    '/blogs/research-insights',
    '/blogs/research-insights/nnmt-inhibition-5-amino-1mq',
    '/cart',
    '/collections/all'
  ];
  for (const p of legacyRoutes) {
    const res = await testUrl(p);
    console.log(`Route: ${p}`);
    console.log(`  -> Status: ${res.statusCode}`);
    console.log(`  -> Redirect Location: ${res.location}`);
    console.log(`  -> Title: ${res.title}`);
  }

  console.log('\n=== 3. Inspecting Token Structure ===');
  for (const token of sampleTokens) {
    inspectToken(token);
  }
}

run();
