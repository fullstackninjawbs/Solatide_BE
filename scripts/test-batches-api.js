const http = require('http');

http.get('http://localhost:5000/api/admin/batches', {
  headers: {
    'Cookie': 'token=dummy'
  }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
