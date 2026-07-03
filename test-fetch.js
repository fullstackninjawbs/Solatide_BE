require('dotenv').config();

async function run() {
  const res = await fetch('https://api.tagadapay.com/v1/orders/12836409049254', {
    headers: {
      'Authorization': `Bearer ${process.env.TAGADA_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
