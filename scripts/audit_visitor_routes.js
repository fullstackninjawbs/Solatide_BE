const mongoose = require('mongoose');
const https = require('https');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

function fetchUrl(targetPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'solatidebiosciences.com.au',
      port: 443,
      path: targetPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const title = (body.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || 'no title';
        resolve({
          path: targetPath,
          statusCode: res.statusCode,
          location: res.headers.location || null,
          title: title.trim(),
          isHtml: res.headers['content-type']?.includes('text/html'),
          bodyLength: body.length
        });
      });
    });
    req.on('error', err => resolve({ path: targetPath, error: err.message }));
    req.end();
  });
}

async function auditVisitorLogs() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log('========================================================================');
  console.log('🔍 SOLATIDE PRODUCTION VISITOR LOG AUDIT');
  console.log('========================================================================\n');

  // 1. Group all paths by occurrence and find strange / legacy patterns
  const allPaths = await db.collection('analyticsevents').aggregate([
    { $group: {
        _id: { $ifNull: ['$path', '$page'] },
        count: { $sum: 1 },
        firstSeen: { $min: '$timestamp' },
        lastSeen: { $max: '$timestamp' },
        sampleCountries: { $addToSet: '$country' }
    }},
    { $sort: { count: -1 } }
  ]).toArray();

  console.log(`Total unique visited paths in MongoDB: ${allPaths.length}`);

  // Categorize paths:
  const trackingLinks = [];
  const policyLinks = [];
  const blogLinks = [];
  const cartLinks = [];
  const legacyProductLinks = [];
  const otherUnusualLinks = [];

  for (const item of allPaths) {
    const p = item._id || '';
    if (p.startsWith('/_t/')) {
      trackingLinks.push(item);
    } else if (p.startsWith('/policies/')) {
      policyLinks.push(item);
    } else if (p.startsWith('/blogs/')) {
      blogLinks.push(item);
    } else if (p.startsWith('/cart')) {
      cartLinks.push(item);
    } else if (p.includes('-lyophilised-peptide') || p.includes('selank-semax-20mg') || p.startsWith('/product/')) {
      legacyProductLinks.push(item);
    } else if (!p.startsWith('/products/') && !p.startsWith('/collections/') && !p.startsWith('/pages/') && !['/', '/checkout', '/checkout/success', '/checkout/failure', '/contact', '/coa', '/sitemap.xml', '/view-document'].includes(p)) {
      otherUnusualLinks.push(item);
    }
  }

  console.log('\n--- 1. TRACKING LINKS (/_t/c/v3/...) ---');
  console.log(`Found ${trackingLinks.length} distinct tracking link paths (${trackingLinks.reduce((acc, c) => acc + c.count, 0)} total hits):`);
  for (const item of trackingLinks) {
    console.log(`- Path: ${item._id.substring(0, 50)}...`);
    console.log(`  Hits: ${item.count} | Last Seen: ${item.lastSeen?.toISOString()} | Countries: ${item.sampleCountries.join(', ')}`);
    console.log(`  Full URL: https://solatidebiosciences.com.au${item._id}`);
  }

  console.log('\n--- 2. LEGACY POLICY ROUTES (/policies/...) ---');
  for (const item of policyLinks) {
    console.log(`- ${item._id} (${item.count} hits, last seen: ${item.lastSeen?.toISOString()})`);
  }

  console.log('\n--- 3. LEGACY BLOG / RESEARCH INSIGHTS (/blogs/...) ---');
  for (const item of blogLinks) {
    console.log(`- ${item._id} (${item.count} hits, last seen: ${item.lastSeen?.toISOString()})`);
  }

  console.log('\n--- 4. CART ROUTE (/cart) ---');
  for (const item of cartLinks) {
    console.log(`- ${item._id} (${item.count} hits, last seen: ${item.lastSeen?.toISOString()})`);
  }

  console.log('\n--- 5. LEGACY PRODUCT SLUGS (/product/*, *-lyophilised-peptide, etc.) ---');
  for (const item of legacyProductLinks) {
    console.log(`- ${item._id} (${item.count} hits, last seen: ${item.lastSeen?.toISOString()})`);
  }

  console.log('\n--- 6. OTHER UNUSUAL PATHS ---');
  for (const item of otherUnusualLinks) {
    console.log(`- ${item._id} (${item.count} hits, last seen: ${item.lastSeen?.toISOString()})`);
  }

  // 2. Test live status for each category
  console.log('\n========================================================================');
  console.log('🌐 LIVE STATUS CODE VERIFICATION ON PRODUCTION DOMAIN');
  console.log('========================================================================\n');

  const testList = [
    trackingLinks[0]?._id,
    '/policies/shipping-policy',
    '/policies/refund-policy',
    '/policies/privacy-policy',
    '/policies/terms-of-service',
    '/blogs/research-insights',
    '/blogs/research-insights/nnmt-inhibition-5-amino-1mq',
    '/blogs/research-insights/retatrutide-vs-semaglutide-research',
    '/blogs/research-insights/glp1-receptor-pathways',
    '/cart',
    '/collections/metabolic-research',
    '/collections/repair-recovery-research',
    '/products/selank-semax-20mg',
    '/products/kpv-10mg-lyophilised-peptide',
    '/products/mots-c-10mg-lyophilised-peptide',
    '/products/ss-31-elamipretide-10mg-lyophilised-peptide',
    '/contact',
    '/coa'
  ].filter(Boolean);

  for (const p of testList) {
    const res = await fetchUrl(p);
    console.log(`${res.statusCode} | ${p.substring(0, 45).padEnd(45)} | Redirect: ${res.location || 'none'} | Title: ${res.title}`);
  }

  await mongoose.disconnect();
}

auditVisitorLogs().catch(console.error);
