const jwt = require('jsonwebtoken');
const http = require('http');

const token = jwt.sign({ id: '66e138a2c20ef22cf884ed61' }, 'solatide_secret_key_2026_dev_mode', { expiresIn: '1h' });

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/admin/content/pages',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer ' + token
  }
};

const req = http.request(options, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', error => console.error(error));
req.end();
