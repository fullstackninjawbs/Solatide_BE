const http = require('http');

const data = JSON.stringify({
  title: 'Test',
  slug: 'test-page',
  content: { html: '<p>Test</p>' }
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/admin/content/pages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', error => console.error(error));
req.write(data);
req.end();
